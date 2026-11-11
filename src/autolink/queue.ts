import { sql } from 'drizzle-orm';
import { tableOf } from '../access/trip';
import type { Sealer } from '../crypto/sealed';
import type { Database } from '../db/client';
import { dbAll, dbGet, transaction } from '../db/exec';
import { type Link, reconcile } from './decide';
import { syncCopy } from '../sharing/copies';
import { decideFor } from './server';

/**
 * **Linking again** (DESIGN.md §12): when a trip's stops change dates, or who goes on it changes, the automatic links of the people it concerns are decided again, **in the background**, and never a link set by hand
 * (`reconcile`). A change asks for it by `enqueueRelink`, **in its own transaction** (so a rolled-back change asks for nothing); the job claims a trip by a lease in the database (two workers or two processes never work one) and
 * works it a batch at a time, each batch a short transaction of its own, so a trip with years of check-ins holds nothing for long. **Safe to do twice and to stop anywhere**: a decision made again is the same, a row is deleted
 * only if the trip was not asked for again meanwhile, and a worker that dies costs only the lease. Nothing is logged but counts.
 *
 * What is looked at: every check-in **now linked to the trip by auto-link** (it may stay, move to another trip, or lose its link), and, for each person who goes on the trip, their **unlinked or automatically linked** check-ins
 * in its dates (a day each side, since a check-in's local date depends on its zone). A newly dated trip picks up a person's existing check-ins, and earlier imports, this way.
 */
export const LEASE_MS = 60_000;
export const BATCH = 100;
/** The window of moments looked at beyond the trip's dates, in days: the zones of the world differ from UTC by up to 14 hours, so a local date can be a day off a UTC date either way. */
const SLACK_DAYS = 2;
const DAY_MS = 86_400_000;

/** Asks for the trip's check-ins to be linked again. Idempotent: asking again before it is done moves the time, so that the row is kept until what was asked has been done. */
export async function enqueueRelink(tx: Database, tripId: string, now: number): Promise<void> {
  await dbAll(
    tx,
    sql`INSERT INTO ${tableOf(tx, 'relink')} (trip_id, requested_at, claimed_until) VALUES (${tripId}, ${now}, 0)
        ON CONFLICT (trip_id) DO UPDATE SET requested_at = ${now}
        RETURNING trip_id`,
  );
}

export interface RelinkDeps {
  readonly database: Database;
  readonly sealer: Sealer;
  readonly now: () => number;
}

interface CheckinRow {
  id: string;
  accountId: string;
  at: number | string;
  tz: string;
  placeId: string;
  tripId: string | null;
  linkSource: string | null;
  version: number | string;
}

const COLUMNS = sql.raw(
  `c.id, c.account_id AS "accountId", c.at, c.tz, c.place_id AS "placeId", c.trip_id AS "tripId", c.link_source AS "linkSource", c.version`,
);

/** Decides again, for one batch, and writes what changed **in each owner's own stream** (their counter advanced once for all of theirs, each row a new version and a place in the order), so that their devices pull it. Returns how many changed. */
export async function relinkBatch(
  tx: Database,
  sealer: Sealer,
  rows: readonly CheckinRow[],
  now: number,
): Promise<number> {
  const changes = new Map<string, { row: CheckinRow; next: Link }[]>();
  for (const row of rows) {
    const decided = await decideFor(tx, sealer, row.accountId, {
      at: Number(row.at),
      tz: row.tz,
      placeId: row.placeId,
    });
    const next = reconcile(
      { tripId: row.tripId, linkSource: row.linkSource as Link['linkSource'] },
      decided,
    );
    if (!next) continue;
    const list = changes.get(row.accountId) ?? [];
    list.push({ row, next });
    changes.set(row.accountId, list);
  }
  let changed = 0;
  for (const [owner, list] of changes) {
    const counted = await dbGet<{ seq: number | string }>(
      tx,
      sql`INSERT INTO ${tableOf(tx, 'account_stream')} AS s (account_id, seq) VALUES (${owner}, ${list.length})
          ON CONFLICT (account_id) DO UPDATE SET seq = s.seq + ${list.length}
          RETURNING seq`,
    );
    const first = Number(counted?.seq) - list.length + 1;
    for (const [index, { row, next }] of list.entries()) {
      // Only if it is still as it was read and still not by hand: a person who linked it by hand meanwhile is never overwritten.
      const done = await dbAll<{ id: string }>(
        tx,
        sql`UPDATE ${tableOf(tx, 'checkin')} SET trip_id = ${next.tripId}, link_source = ${next.linkSource}, version = version + 1, seq = ${first + index}, updated_at = ${now}
            WHERE id = ${row.id} AND account_id = ${owner} AND version = ${Number(row.version)} AND (link_source IS NULL OR link_source = 'auto')
            RETURNING id`,
      );
      changed += done.length;
      // A check-in linked to another trip (or to none) is shared, or no longer shared, with the one it is in now.
      if (done.length > 0)
        await syncCopy(tx, { sealer, now: () => now }, owner, row.id, { rewrite: false });
    }
  }
  return changed;
}

/** One page of check-ins after `after`, by id, of the kinds a trip's re-linking looks at. */
async function page(
  database: Database,
  where: ReturnType<typeof sql>,
  after: string,
): Promise<CheckinRow[]> {
  return dbAll<CheckinRow>(
    database,
    sql`SELECT ${COLUMNS} FROM ${tableOf(database, 'checkin')} c WHERE ${where} AND c.id > ${after} ORDER BY c.id LIMIT ${BATCH}`,
  );
}

async function relinkTrip(
  deps: RelinkDeps,
  tripId: string,
  renew: () => Promise<boolean>,
): Promise<number> {
  const { database, sealer } = deps;
  const trip = await dbGet<{ startDate: string | null; endDate: string | null }>(
    database,
    sql`SELECT start_date AS "startDate", end_date AS "endDate" FROM ${tableOf(database, 'trip')} WHERE id = ${tripId}`,
  );
  // A trip that is gone had its links taken away with it.
  if (!trip) return 0;
  let changed = 0;
  const run = async (where: ReturnType<typeof sql>): Promise<void> => {
    let after = '';
    for (;;) {
      if (!(await renew())) throw new Lost();
      const rows = await page(database, where, after);
      if (rows.length === 0) return;
      changed += await transaction(database, (tx) => relinkBatch(tx, sealer, rows, deps.now()));
      after = rows[rows.length - 1]?.id ?? after;
      if (rows.length < BATCH) return;
    }
  };
  // What is linked to it now by auto-link, whoever it is and whatever has become of their part in the trip.
  await run(sql`c.trip_id = ${tripId} AND c.link_source = 'auto'`);
  if (trip.startDate !== null && trip.endDate !== null) {
    const from = Date.parse(`${trip.startDate}T00:00:00Z`) - SLACK_DAYS * DAY_MS;
    const to = Date.parse(`${trip.endDate}T00:00:00Z`) + (SLACK_DAYS + 1) * DAY_MS;
    const people = await dbAll<{ accountId: string }>(
      database,
      sql`SELECT m.account_id AS "accountId" FROM ${tableOf(database, 'trip_member')} m
          WHERE m.trip_id = ${tripId} AND m.left_at IS NULL AND m.role IN ('organizer', 'traveler') AND m.going = ${true}
          ORDER BY m.account_id`,
    );
    for (const person of people)
      await run(
        sql`c.account_id = ${person.accountId} AND (c.link_source IS NULL OR c.link_source = 'auto') AND c.at >= ${from} AND c.at < ${to}`,
      );
  }
  return changed;
}

class Lost extends Error {}

/**
 * Works the trips that wait, oldest request first, until none is due or the budget is spent. Safe to run from two processes at once. Returns how many trips were finished and how many check-ins changed.
 */
export async function workOnRelinks(
  deps: RelinkDeps,
  options: { budgetMs?: number } = {},
): Promise<{ trips: number; changed: number }> {
  const until = deps.now() + (options.budgetMs ?? 20_000);
  const result = { trips: 0, changed: 0 };
  while (deps.now() < until) {
    const now = deps.now();
    const claimed = await dbAll<{ tripId: string; requestedAt: number | string }>(
      deps.database,
      sql`UPDATE ${tableOf(deps.database, 'relink')} SET claimed_until = ${now + LEASE_MS}
          WHERE trip_id IN (SELECT trip_id FROM ${tableOf(deps.database, 'relink')} WHERE claimed_until <= ${now} ORDER BY requested_at, trip_id LIMIT 1)
            AND claimed_until <= ${now}
          RETURNING trip_id AS "tripId", requested_at AS "requestedAt"`,
    );
    const job = claimed[0];
    if (!job) break;
    // Still there: if another worker finished the trip meanwhile (the row is gone) this one stops.
    const renew = async () =>
      (
        await dbAll<{ tripId: string }>(
          deps.database,
          sql`UPDATE ${tableOf(deps.database, 'relink')} SET claimed_until = ${deps.now() + LEASE_MS}
              WHERE trip_id = ${job.tripId} RETURNING trip_id AS "tripId"`,
        )
      ).length > 0;
    try {
      result.changed += await relinkTrip(deps, job.tripId, renew);
    } catch (error) {
      if (error instanceof Lost) continue;
      // Give the lease up so that the next run tries again, and say only that it failed.
      await dbAll(
        deps.database,
        sql`UPDATE ${tableOf(deps.database, 'relink')} SET claimed_until = 0 WHERE trip_id = ${job.tripId} RETURNING trip_id`,
      );
      throw error;
    }
    // Done, unless the trip was asked for again meanwhile: then it stays and is worked again.
    const finished = await dbAll<{ tripId: string }>(
      deps.database,
      sql`DELETE FROM ${tableOf(deps.database, 'relink')} WHERE trip_id = ${job.tripId} AND requested_at = ${Number(job.requestedAt)} RETURNING trip_id AS "tripId"`,
    );
    if (finished.length === 0)
      await dbAll(
        deps.database,
        sql`UPDATE ${tableOf(deps.database, 'relink')} SET claimed_until = 0 WHERE trip_id = ${job.tripId} RETURNING trip_id`,
      );
    else result.trips += 1;
  }
  return result;
}
