import { sql } from 'drizzle-orm';
import { EDITORS, memberOf, tableOf } from '../access/trip';
import type { Sealer } from '../crypto/sealed';
import type { Database } from '../db/client';
import { dbAll, dbGet } from '../db/exec';
import { wants } from '../notices/prefs';
import { notifyMembersOf, type NotifyDeps } from '../trips/notify';
import { type CheckinShare, type ShareChoice, sharedWith } from './rules';

/**
 * The reader's copy of a shared check-in (DESIGN.md §11.3, §15.3, §18.1), kept in step with the check-in **in the transaction of every change that could alter who it is shared with or what it says**: the check-in being
 * written, deleted or linked again, its place being edited, the author's part in the trip changing, their choice for the trip changing, the author leaving. `syncCopy` is the one function that decides: it reads the check-in,
 * asks `sharedWith` (the pure rule) and makes the trip's copy what it should be, **writing it, replacing it, moving it to another trip, or removing it**. A copy is `shared_checkin` (plain: the check-in, the trip, the author, the
 * trip's counter) and a sealed body: **the place, moment, note, companions and the ids of the photos**, and nothing else of the author: not their other check-ins, not their other trips, not an email.
 *
 * Every change to a trip's copies takes the **trip's next number** (`trip.seq`), so that members' devices find out (6.6 reads them past their cursor). Lock order: a transaction that changes check-ins takes the account's stream
 * counter first and a trip's row after (as `src/sync/apply.ts` and the job in `src/autolink/queue.ts` do), and nothing here takes the account's stream.
 */
export interface CopyDeps {
  readonly sealer: Sealer;
  readonly now: () => number;
  /** To tell the members who chose it, once, when a check-in is first shared. Without it nobody is told. */
  readonly notify?: NotifyDeps | undefined;
}

export type CopyOutcome = 'written' | 'removed' | 'kept' | 'none';

const bytes = (value: Uint8Array | ArrayBuffer) =>
  value instanceof Uint8Array ? value : new Uint8Array(value);

/** What a reader is given of a check-in. Everything here is something the author chose to share; plain text, as the device holds it. */
export interface SharedBody {
  readonly place: {
    readonly name: string;
    readonly lat: number;
    readonly lng: number;
    readonly address?: unknown;
    readonly category?: string;
  };
  readonly at: number;
  readonly tz: string;
  readonly offsetMin: number;
  readonly note?: string;
  readonly companions: readonly string[];
  readonly photos: readonly string[];
}

interface CheckinFacts {
  placeId: string;
  at: number | string;
  tz: string;
  offsetMin: number | string;
  tripId: string | null;
  share: string;
  sealed: Uint8Array | ArrayBuffer;
}

/** Takes the trip's next number, if the trip is there. */
async function bump(tx: Database, tripId: string): Promise<number | undefined> {
  const rows = await dbAll<{ seq: number | string }>(
    tx,
    sql`UPDATE ${tableOf(tx, 'trip')} SET seq = seq + 1 WHERE id = ${tripId} RETURNING seq`,
  );
  return rows[0] ? Number(rows[0].seq) : undefined;
}

/** Removes a check-in's copy, naming the author and the check-in, and takes the trip's next number for it. Returns whether there was one. */
export async function dropCopy(
  tx: Database,
  accountId: string,
  checkinId: string,
): Promise<boolean> {
  const gone = await dbAll<{ tripId: string }>(
    tx,
    sql`DELETE FROM ${tableOf(tx, 'shared_checkin')} WHERE checkin_id = ${checkinId} AND account_id = ${accountId} RETURNING trip_id AS "tripId"`,
  );
  for (const row of gone) await bump(tx, row.tripId);
  return gone.length > 0;
}

/**
 * Removes every copy of an author's in a trip (or in every trip), for the author leaving, being removed or deleting their account (10.4, `People.deletePerson`): the check-ins stay theirs, and nothing of them stays in the trip.
 * Returns how many copies went.
 */
export async function dropCopiesOf(
  tx: Database,
  accountId: string,
  tripId?: string,
): Promise<number> {
  const gone = await dbAll<{ tripId: string }>(
    tx,
    tripId === undefined
      ? sql`DELETE FROM ${tableOf(tx, 'shared_checkin')} WHERE account_id = ${accountId} RETURNING trip_id AS "tripId"`
      : sql`DELETE FROM ${tableOf(tx, 'shared_checkin')} WHERE account_id = ${accountId} AND trip_id = ${tripId} RETURNING trip_id AS "tripId"`,
  );
  for (const trip of [...new Set(gone.map((row) => row.tripId))].sort()) await bump(tx, trip);
  return gone.length;
}

/** What `syncCopy` is told it may do. */
export interface SyncOptions {
  /** Write the body again even if the copy is already in the right trip: the check-in or its place was edited. Without it, a copy that is where it should be is left alone (a change of choice or of role). */
  readonly rewrite: boolean;
}

/**
 * Makes the check-in's copy what it should be. **The permission is in the statement:** a copy is written only through a statement that shows the author is an Organizer or Traveler of the trip (`memberOf`); when it is
 * not, there is no copy. A check-in that is not there has none.
 */
export async function syncCopy(
  tx: Database,
  deps: CopyDeps,
  accountId: string,
  checkinId: string,
  options: SyncOptions,
): Promise<CopyOutcome> {
  const row = await dbGet<CheckinFacts>(
    tx,
    sql`SELECT place_id AS "placeId", at, tz, offset_min AS "offsetMin", trip_id AS "tripId", share, sealed
        FROM ${tableOf(tx, 'checkin')} WHERE id = ${checkinId} AND account_id = ${accountId}`,
  );
  const existing = await dbGet<{ tripId: string }>(
    tx,
    sql`SELECT trip_id AS "tripId" FROM ${tableOf(tx, 'shared_checkin')} WHERE checkin_id = ${checkinId} AND account_id = ${accountId}`,
  );
  const drop = async (): Promise<CopyOutcome> =>
    existing && (await dropCopy(tx, accountId, checkinId)) ? 'removed' : 'none';
  if (!row) return drop();

  let target: string | undefined;
  if (row.tripId !== null) {
    const member = await dbGet<{ role: string; forTrip: string }>(
      tx,
      sql`SELECT role, share_checkins AS "forTrip" FROM ${tableOf(tx, 'trip_member')}
          WHERE trip_id = ${row.tripId} AND account_id = ${accountId} AND left_at IS NULL`,
    );
    const profile = await dbGet<{ shareDefault: string }>(
      tx,
      sql`SELECT share_default AS "shareDefault" FROM ${tableOf(tx, 'profile')} WHERE account_id = ${accountId}`,
    );
    target = sharedWith({
      share: row.share as CheckinShare,
      tripId: row.tripId,
      authorMay: member !== undefined && (EDITORS as readonly string[]).includes(member.role),
      forTrip: (member?.forTrip ?? 'ask') as ShareChoice,
      defaultChoice: (profile?.shareDefault ?? 'ask') as ShareChoice,
    });
  }
  if (target === undefined) return drop();
  // Linked to another trip now: the old copy goes (and the old trip hears of it) before the new one is made.
  if (existing && existing.tripId !== target) await dropCopy(tx, accountId, checkinId);
  const kept = existing !== undefined && existing.tripId === target;
  if (kept && !options.rewrite) return 'kept';

  const body = await bodyOf(tx, deps.sealer, accountId, checkinId, row);
  if (!body) return drop();
  // The trip's next number, **only if the author is still an Organizer or Traveler of it**: the permission is in the statement that takes it.
  const bumped = await dbAll<{ seq: number | string }>(
    tx,
    sql`UPDATE ${tableOf(tx, 'trip')} SET seq = seq + 1
        WHERE id = ${target} AND ${memberOf(tx, sql`${target}`, accountId, EDITORS)}
        RETURNING seq`,
  );
  const trip = bumped[0];
  if (!trip) return drop();
  const sealed = deps.sealer.seal('shared_checkin', checkinId, { copy: body });
  // Replaced if it is there (the statement names the author), made if it is not.
  const replaced = await dbAll<{ id: string }>(
    tx,
    sql`UPDATE ${tableOf(tx, 'shared_checkin')} SET trip_id = ${target}, seq = ${Number(trip.seq)}, sealed = ${sealed}
        WHERE checkin_id = ${checkinId} AND account_id = ${accountId}
        RETURNING checkin_id AS id`,
  );
  if (replaced.length === 0)
    await dbAll(
      tx,
      sql`INSERT INTO ${tableOf(tx, 'shared_checkin')} (checkin_id, trip_id, account_id, seq, sealed)
          VALUES (${checkinId}, ${target}, ${accountId}, ${Number(trip.seq)}, ${sealed})
          RETURNING checkin_id`,
    );
  if (!kept && deps.notify) await tellOptedIn(tx, deps.notify, target, accountId);
  return 'written';
}

/** The body of a check-in's copy: its place opened, its note and companions opened, and its photos' ids in order. */
async function bodyOf(
  tx: Database,
  sealer: Sealer,
  accountId: string,
  checkinId: string,
  row: CheckinFacts,
): Promise<SharedBody | undefined> {
  const place = await dbGet<{ sealed: Uint8Array | ArrayBuffer }>(
    tx,
    sql`SELECT sealed FROM ${tableOf(tx, 'place')} WHERE id = ${row.placeId} AND account_id = ${accountId}`,
  );
  if (!place) return undefined;
  const fields = sealer.unseal('place', row.placeId, bytes(place.sealed));
  const own = sealer.unseal('checkin', checkinId, bytes(row.sealed));
  const photos = await dbAll<{ id: string }>(
    tx,
    sql`SELECT id FROM ${tableOf(tx, 'checkin_photo')} WHERE checkin_id = ${checkinId} AND account_id = ${accountId} ORDER BY position`,
  );
  return {
    place: {
      name: fields.name,
      lat: fields.lat,
      lng: fields.lng,
      ...(fields.address ? { address: fields.address } : {}),
      ...(fields.category ? { category: fields.category } : {}),
    },
    at: Number(row.at),
    tz: row.tz,
    offsetMin: Number(row.offsetMin),
    ...(own.note ? { note: own.note } : {}),
    companions: own.companions ?? [],
    photos: photos.map((photo) => photo.id),
  };
}

/**
 * `checkin_shared` (DESIGN.md §17.1): the other members **who chose it** are told when a check-in is first shared (not when it is edited), in the same transaction. It is off by default: a member is told only if they have turned
 * it on by a channel (email, or core's bell), so a trip's people are not told of every check-in. The words name the trip and nothing of the check-in or its author.
 */
async function tellOptedIn(
  tx: Database,
  notify: NotifyDeps,
  tripId: string,
  by: string,
): Promise<void> {
  const members = await dbAll<{ accountId: string }>(
    tx,
    sql`SELECT account_id AS "accountId" FROM ${tableOf(tx, 'trip_member')} WHERE trip_id = ${tripId} AND left_at IS NULL AND account_id <> ${by} ORDER BY account_id`,
  );
  const chosen: string[] = [];
  for (const member of members)
    if (
      (await wants(tx, member.accountId, 'checkin_shared', 'email')) ||
      (await wants(tx, member.accountId, 'checkin_shared', 'core'))
    )
      chosen.push(member.accountId);
  if (chosen.length === 0) return;
  const trip = await dbGet<{ sealed: Uint8Array | ArrayBuffer }>(
    tx,
    sql`SELECT sealed FROM ${tableOf(tx, 'trip')} WHERE id = ${tripId}`,
  );
  if (!trip) return;
  const name = notify.sealer.unseal('trip', tripId, bytes(trip.sealed)).name;
  await notifyMembersOf(tx, notify, chosen, tripId, by, 'checkin_shared', {
    title: `A check-in was shared on ${name}`,
    detail: 'Open the trip to see it.',
  });
}

/** Every check-in of an author's that is linked to a trip or has a copy in it, made right: after the author's role or their choice for the trip changed. */
export async function resyncAuthor(
  tx: Database,
  deps: CopyDeps,
  tripId: string,
  accountId: string,
): Promise<number> {
  const ids = await dbAll<{ id: string }>(
    tx,
    sql`SELECT id FROM ${tableOf(tx, 'checkin')} WHERE account_id = ${accountId} AND trip_id = ${tripId}
        UNION SELECT checkin_id AS id FROM ${tableOf(tx, 'shared_checkin')} WHERE account_id = ${accountId} AND trip_id = ${tripId}
        ORDER BY id`,
  );
  let changed = 0;
  for (const { id } of ids) {
    const outcome = await syncCopy(tx, deps, accountId, id, { rewrite: false });
    if (outcome === 'written' || outcome === 'removed') changed += 1;
  }
  return changed;
}

/** The copies of the check-ins at a place of the author's, written again: the place was edited, and a reader must not be left with its old name or point. */
export async function resyncPlace(
  tx: Database,
  deps: CopyDeps,
  accountId: string,
  placeId: string,
): Promise<void> {
  const ids = await dbAll<{ id: string }>(
    tx,
    sql`SELECT c.id AS id FROM ${tableOf(tx, 'checkin')} c
        JOIN ${tableOf(tx, 'shared_checkin')} s ON s.checkin_id = c.id AND s.account_id = c.account_id
        WHERE c.account_id = ${accountId} AND c.place_id = ${placeId} ORDER BY c.id`,
  );
  for (const { id } of ids) await syncCopy(tx, deps, accountId, id, { rewrite: true });
}
