import { sql } from 'drizzle-orm';
import { tableOf } from '../access/trip';
import { DEFAULT_LIMITS, type LimitSettings } from '../config';
import type { Sealer } from '../crypto/sealed';
import type { Database } from '../db/client';
import { dbAll } from '../db/exec';
import { listShared } from '../sharing/read';
import { listAttachments } from '../trips/attachments';
import type { Role } from '../trips/format';
import { listLinks } from '../trips/links';
import { readPlan } from '../trips/plan';
import { getTrip } from '../trips/trips';
import type {
  DayRecord,
  ItemRecord,
  TripAsks,
  TripGone,
  TripPage,
  TripSets,
  TripTable,
} from './trip-format';

/**
 * **A trip's stream to a device** (DESIGN.md §15.1, §15.3): for each trip the account is an active member of, what changed past the cursor the device holds, with only what the member's role may see. **The permission is the
 * membership**: the trips come from the account's own rows in `trip_member`, every reader called here names the account again (`readPlan`, `getTrip`, `listLinks`, `listAttachments`, `listShared` each carry their own membership and
 * role in the statement), and a trip the device holds but the account no longer belongs to is not an error but an entry in `gone`, so the device deletes its copy of it.
 *
 * A page is cut at a **number of the trip's counter**, never in the middle of one (one transaction gives all the rows it changes the same number): the rows past the cursor are counted by distinct numbers, up to `limit`, and the
 * page ends at the last of them. A device behind the trip's `floor` (tombstones were pruned, `history.ts`) is told to start again.
 */
export interface TripPullDeps {
  readonly database: Database;
  readonly sealer: Sealer;
  readonly now: () => number;
  readonly limits?: LimitSettings | undefined;
}

const KEPT: readonly TripTable[] = ['item', 'shared_checkin'];

interface Membership {
  tripId: string;
  role: string;
  seq: number | string;
  floor: number | string;
}

export async function pullTrips(
  deps: TripPullDeps,
  accountId: string,
  asked: TripAsks,
  limit: number,
): Promise<{ trips: TripPage[]; gone: string[] }> {
  const memberships = await dbAll<Membership>(
    deps.database,
    sql`SELECT m.trip_id AS "tripId", m.role AS role, t.seq AS seq, t.floor AS floor
        FROM ${tableOf(deps.database, 'trip_member')} m
        JOIN ${tableOf(deps.database, 'trip')} t ON t.id = m.trip_id
        WHERE m.account_id = ${accountId} AND m.left_at IS NULL
        ORDER BY m.trip_id`,
  );
  const mine = new Set(memberships.map((each) => each.tripId));
  const gone = Object.keys(asked)
    .filter((id) => !mine.has(id))
    .sort();
  const trips: TripPage[] = [];
  for (const membership of memberships)
    trips.push(await pullTrip(deps, accountId, membership, asked[membership.tripId], limit));
  return { trips, gone };
}

async function pullTrip(
  deps: TripPullDeps,
  accountId: string,
  membership: Membership,
  ask: { cursor: number; floor: number } | undefined,
  limit: number,
): Promise<TripPage> {
  const { database } = deps;
  const tripId = membership.tripId;
  const role = membership.role as Role;
  const head = Number(membership.seq);
  const floor = Number(membership.floor);
  const reset = (ask?.floor ?? 0) < floor;
  const cursor = reset || !ask ? 0 : ask.cursor;

  // The numbers past the cursor that carry rows or deletions, counted by value: a page ends at one of them.
  const numbers = await dbAll<{ seq: number | string }>(
    database,
    sql`SELECT seq FROM (
          SELECT seq FROM ${tableOf(database, 'item')} WHERE trip_id = ${tripId} AND seq > ${cursor} AND seq <= ${head}
          UNION SELECT seq FROM ${tableOf(database, 'shared_checkin')} WHERE trip_id = ${tripId} AND seq > ${cursor} AND seq <= ${head}
          UNION SELECT seq FROM ${tableOf(database, 'trip_tombstone')} WHERE trip_id = ${tripId} AND seq > ${cursor} AND seq <= ${head}
        ) n ORDER BY seq LIMIT ${limit + 1}`,
  );
  const more = numbers.length > limit;
  const through = more ? Number(numbers[limit - 1]?.seq) : head;

  const rows = await itemsPast(deps, accountId, tripId, cursor, through);
  const shared =
    (await listShared(database, deps.sealer, accountId, tripId, cursor, through)) ?? [];
  const tombstones = await dbAll<{ table: string; id: string; seq: number | string }>(
    database,
    sql`SELECT table_name AS "table", row_id AS id, seq FROM ${tableOf(database, 'trip_tombstone')}
        WHERE trip_id = ${tripId} AND seq > ${cursor} AND seq <= ${through} ORDER BY seq, row_id`,
  );
  const deleted: TripGone[] = tombstones
    .filter((each) => (KEPT as readonly string[]).includes(each.table))
    .map((each) => ({ table: each.table as TripTable, id: each.id, seq: Number(each.seq) }));

  // The small sets, whole, when the trip changed since the device last heard (and always for a snapshot).
  const sets = cursor < head || !ask || reset ? await setsOf(deps, accountId, tripId) : undefined;
  return {
    tripId,
    role,
    cursor: through,
    head,
    floor,
    reset,
    more,
    ...(sets ? { sets } : {}),
    items: rows,
    shared,
    deleted,
  };
}

/** The items whose number is in `(cursor, through]`, as the plan shows them. */
async function itemsPast(
  deps: TripPullDeps,
  accountId: string,
  tripId: string,
  cursor: number,
  through: number,
): Promise<ItemRecord[]> {
  const numbered = await dbAll<{ id: string; seq: number | string }>(
    deps.database,
    sql`SELECT id, seq FROM ${tableOf(deps.database, 'item')} WHERE trip_id = ${tripId} AND seq > ${cursor} AND seq <= ${through}`,
  );
  if (numbered.length === 0) return [];
  const seqOf = new Map(numbered.map((row) => [row.id, Number(row.seq)]));
  const plan = await readPlan(planDeps(deps), accountId, tripId);
  return (plan?.stops ?? [])
    .flatMap((stop) => stop.days.flatMap((day) => day.items))
    .filter((item) => seqOf.has(item.id))
    .map((item) => ({ ...item, seq: seqOf.get(item.id) ?? 0 }))
    .sort((a, b) => a.seq - b.seq || a.id.localeCompare(b.id));
}

const planDeps = (deps: TripPullDeps) => ({
  database: deps.database,
  sealer: deps.sealer,
  now: deps.now,
  limits: deps.limits ?? DEFAULT_LIMITS,
});

async function setsOf(
  deps: TripPullDeps,
  accountId: string,
  tripId: string,
): Promise<TripSets | undefined> {
  const tripDeps = planDeps(deps);
  const detail = await getTrip(tripDeps, accountId, tripId);
  if (!detail) return undefined;
  const plan = await readPlan(tripDeps, accountId, tripId);
  const links = (await listLinks(tripDeps, accountId, tripId)) ?? [];
  // Never for a Follower: the statement behind this one names the role.
  const attachments = await listAttachments(tripDeps, accountId, tripId);
  const dayRows = await dbAll<{
    id: string;
    stopId: string;
    date: string;
    version: number | string;
    sealed: Uint8Array | ArrayBuffer;
  }>(
    deps.database,
    sql`SELECT d.id AS id, d.stop_id AS "stopId", d.date AS date, d.version AS version, d.sealed AS sealed
        FROM ${tableOf(deps.database, 'day')} d WHERE d.trip_id = ${tripId} ORDER BY d.date, d.id`,
  );
  const days: DayRecord[] = dayRows.map((row) => {
    const fields = deps.sealer.unseal(
      'day',
      row.id,
      row.sealed instanceof Uint8Array ? row.sealed : new Uint8Array(row.sealed),
    );
    return {
      id: row.id,
      stopId: row.stopId,
      date: row.date,
      title: fields.title,
      notes: fields.notes,
      version: Number(row.version),
    };
  });
  return {
    trip: detail.trip,
    members: detail.members,
    stops: (plan?.stops ?? []).map(({ days: _days, ...stop }) => stop),
    days,
    links,
    ...(attachments ? { attachments } : {}),
  };
}
