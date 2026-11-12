import { sql } from 'drizzle-orm';
import { EDITORS, memberOf, tableOf } from '../access/trip';
import { DEFAULT_LIMITS, type LimitSettings } from '../config';
import type { Sealer } from '../crypto/sealed';
import type { Database } from '../db/client';
import { dbAll, dbGet, transaction } from '../db/exec';
import type { Delivery } from '../notices/notices';
import { clearGone, recordGone } from './gone';
import { notifyMembersOf } from './notify';
import { sweepPlaces } from './plan';
import { type TripChange, parseTripMutation } from './sync-format';

/**
 * **Applying a mutation to a trip's stream** (DESIGN.md §15.2, §15.4, §15.5): the only way an item or a day's words a device made offline reaches the trip. One short transaction for each mutation, as the account's (`src/sync/apply.ts`):
 *
 *  1. **Once.** The mutation id is taken first, in the same transaction; one already taken is a replay and writes nothing.
 *  2. **By role, in the statement.** The trip's counter is taken by a statement that shows the sender is an Organizer or a Traveler **now**; a Follower, a person who has left and a stranger are refused, and the refusal is a sentence the person
 *     keeps in Couldn't sync (to a person who is in the trip as a Follower: "You're now a Follower of …"; to anyone else, that the trip is not one they can change).
 *  3. **Whole or not at all.** The first thing wrong with any change refuses the mutation and nothing it did is kept, the id included.
 *  4. **The later edit stands, whole** (§15.4). A put makes the row or replaces it; one for a row that was deleted restores it; a delete of a row that is not there does nothing. **When a put replaces what someone else changed after the version
 *     the sender saw, that person is told, with what their edit said** (`edit_replaced`), in this transaction; the sender is never told of their own.
 *  5. **The trip's.** Every row is named with the trip, so an id that is another trip's is a row that is not there; the day and the place must be the trip's, and a day's limit holds.
 *
 * Nothing here logs what an item says.
 */
export interface TripSyncDeps {
  readonly database: Database;
  readonly sealer: Sealer;
  readonly now: () => number;
  readonly limits?: LimitSettings | undefined;
  readonly delivery?: (() => Delivery) | undefined;
}

export type TripApplyResult =
  | { readonly status: 'applied'; readonly seq: number }
  | { readonly status: 'replay' }
  | { readonly status: 'refused'; readonly reason: string; readonly sentence: string };

class Refused extends Error {
  constructor(
    readonly reason: string,
    readonly sentence: string,
  ) {
    super(reason);
  }
}

const bytes = (value: Uint8Array | ArrayBuffer): Uint8Array =>
  value instanceof Uint8Array ? value : new Uint8Array(value);

const itemSealed = (fields: { title?: string | undefined; notes?: string | undefined }) => ({
  ...(fields.title ? { title: fields.title } : {}),
  ...(fields.notes ? { notes: fields.notes } : {}),
});

export async function applyTripMutation(
  deps: TripSyncDeps,
  accountId: string,
  input: unknown,
): Promise<TripApplyResult> {
  const parsed = parseTripMutation(input);
  if (!parsed.ok) return { status: 'refused', reason: parsed.reason, sentence: parsed.sentence };
  const { tripId, mutation } = parsed.value;
  const now = deps.now();
  const limits = deps.limits ?? DEFAULT_LIMITS;
  const t = (name: string) => tableOf(deps.database, name);
  try {
    return await transaction(deps.database, async (tx): Promise<TripApplyResult> => {
      const taken = await dbAll<{ id: string }>(
        tx,
        sql`INSERT INTO ${t('applied_mutation')} (account_id, mutation_id, seq, applied_at)
            VALUES (${accountId}, ${mutation.mutationId}, 0, ${now})
            ON CONFLICT (account_id, mutation_id) DO NOTHING
            RETURNING mutation_id AS id`,
      );
      if (taken.length === 0) return { status: 'replay' };

      // The permission is in the statement: it takes the trip's number only for an Organizer or a Traveler.
      const touched = await dbAll<{ seq: number | string; sealed: Uint8Array | ArrayBuffer }>(
        tx,
        sql`UPDATE ${t('trip')} SET seq = seq + 1, updated_at = ${now}
            WHERE id = ${tripId} AND ${memberOf(tx, sql`${tripId}`, accountId, EDITORS)}
            RETURNING seq, sealed`,
      );
      const trip = touched[0];
      if (!trip) throw await refusalFor(tx, deps.sealer, accountId, tripId);
      const seq = Number(trip.seq);
      const tripName = deps.sealer.unseal('trip', tripId, bytes(trip.sealed)).name;

      let sweep = false;
      for (const change of mutation.changes) {
        if (change.table === 'item_done') await markDone(tx, accountId, tripId, change, now);
        else if (change.table === 'day') await putDay(tx, deps, tripId, change, seq);
        else if (change.op === 'delete') {
          const gone = await dbAll<{ id: string }>(
            tx,
            sql`DELETE FROM ${t('item')} WHERE id = ${change.id} AND trip_id = ${tripId} RETURNING id`,
          );
          await recordGone(
            tx,
            tripId,
            'item',
            gone.map((row) => row.id),
            seq,
            now,
          );
          sweep = sweep || gone.length > 0;
        } else {
          await putItem(tx, deps, limits, accountId, tripId, tripName, change, seq, now);
          sweep = true;
        }
      }
      // A place that nothing names any more goes (an item moved off it, or deleted).
      if (sweep) await sweepPlaces(tx, tripId, seq, now);
      await dbAll(
        tx,
        sql`UPDATE ${t('applied_mutation')} SET seq = ${seq}
            WHERE account_id = ${accountId} AND mutation_id = ${mutation.mutationId}
            RETURNING mutation_id`,
      );
      return { status: 'applied', seq };
    });
  } catch (error) {
    if (error instanceof Refused)
      return { status: 'refused', reason: error.reason, sentence: error.sentence };
    throw error;
  }
}

/** Why a sender may not change a trip, in words they can act on: what their own part is now, if they have one; otherwise only that the trip is not one they can change. */
async function refusalFor(
  tx: Database,
  sealer: Sealer,
  accountId: string,
  tripId: string,
): Promise<Refused> {
  const member = await dbGet<{ role: string; sealed: Uint8Array | ArrayBuffer }>(
    tx,
    sql`SELECT m.role AS role, t.sealed AS sealed FROM ${tableOf(tx, 'trip_member')} m
        JOIN ${tableOf(tx, 'trip')} t ON t.id = m.trip_id
        WHERE m.trip_id = ${tripId} AND m.account_id = ${accountId} AND m.left_at IS NULL`,
  );
  if (member?.role === 'follower') {
    const name = sealer.unseal('trip', tripId, bytes(member.sealed)).name;
    return new Refused('role', `You're now a Follower of “${name}”, so you can't change its plan.`);
  }
  return new Refused('not_in_trip', "That trip isn't one you can change any more.");
}

/** A person's own _Done_ mark: made for an item of this trip, or taken away. Theirs alone: the statement names the account. Marking twice is marking once. */
async function markDone(
  tx: Database,
  accountId: string,
  tripId: string,
  change: Extract<TripChange, { table: 'item_done' }>,
  now: number,
): Promise<void> {
  const t = (name: string) => tableOf(tx, name);
  if (change.op === 'delete') {
    await dbAll(
      tx,
      sql`DELETE FROM ${t('item_done')} WHERE trip_id = ${tripId} AND item_id = ${change.id} AND account_id = ${accountId} RETURNING item_id`,
    );
    return;
  }
  const item = await dbGet<{ id: string }>(
    tx,
    sql`SELECT id FROM ${t('item')} WHERE id = ${change.id} AND trip_id = ${tripId}`,
  );
  if (!item) throw new Refused('item_gone', 'That item was removed from the trip.');
  await dbAll(
    tx,
    sql`INSERT INTO ${t('item_done')} (trip_id, item_id, account_id, done_at)
        VALUES (${tripId}, ${change.id}, ${accountId}, ${now})
        ON CONFLICT (trip_id, item_id, account_id) DO NOTHING
        RETURNING item_id`,
  );
}

async function putDay(
  tx: Database,
  deps: TripSyncDeps,
  tripId: string,
  change: Extract<TripChange, { table: 'day' }>,
  seq: number,
): Promise<void> {
  const updated = await dbAll<{ id: string }>(
    tx,
    sql`UPDATE ${tableOf(tx, 'day')}
        SET sealed = ${deps.sealer.seal('day', change.id, {
          ...(change.row.title ? { title: change.row.title } : {}),
          ...(change.row.notes ? { notes: change.row.notes } : {}),
        })}, version = version + 1, seq = ${seq}
        WHERE id = ${change.id} AND trip_id = ${tripId}
        RETURNING id`,
  );
  if (updated.length === 0) throw new Refused('day_gone', 'That day was removed from the trip.');
}

async function putItem(
  tx: Database,
  deps: TripSyncDeps,
  limits: LimitSettings,
  accountId: string,
  tripId: string,
  tripName: string,
  change: Extract<TripChange, { table: 'item'; op: 'put' }>,
  seq: number,
  now: number,
): Promise<void> {
  const t = (name: string) => tableOf(tx, name);
  const { row } = change;
  const day = await dbGet<{ id: string }>(
    tx,
    sql`SELECT id FROM ${t('day')} WHERE id = ${row.dayId} AND trip_id = ${tripId}`,
  );
  if (!day) throw new Refused('day_gone', 'That day was removed from the trip.');
  if (row.placeId !== null) {
    const place = await dbGet<{ id: string }>(
      tx,
      sql`SELECT id FROM ${t('place')} WHERE id = ${row.placeId} AND trip_id = ${tripId}`,
    );
    if (!place)
      throw new Refused('place_gone', 'The place for that item was removed from the trip.');
  }
  const existing = await dbGet<{
    tripId: string;
    dayId: string;
    version: number | string;
    updatedBy: string | null;
    sealed: Uint8Array | ArrayBuffer;
  }>(
    tx,
    sql`SELECT trip_id AS "tripId", day_id AS "dayId", version, updated_by AS "updatedBy", sealed FROM ${t('item')} WHERE id = ${change.id}`,
  );
  // Another trip's id is not found, and says no more.
  if (existing && existing.tripId !== tripId)
    throw new Refused('missing', "That item isn't one you can change.");
  if (!existing || existing.dayId !== row.dayId) {
    const count = await dbGet<{ n: number | string }>(
      tx,
      sql`SELECT COUNT(*) AS n FROM ${t('item')} WHERE day_id = ${row.dayId} AND trip_id = ${tripId}`,
    );
    if (Number(count?.n ?? 0) >= limits.dayItems)
      throw new Refused('limit', `A day has at most ${limits.dayItems} items on this server.`);
  }
  const sealed = deps.sealer.seal('item', change.id, itemSealed(row));
  if (existing) {
    // Someone else changed it after the version the sender saw: their edit is replaced, and they are told what it said (§15.4).
    const replaced =
      change.baseVersion !== undefined &&
      Number(existing.version) > change.baseVersion &&
      existing.updatedBy !== null &&
      existing.updatedBy !== accountId;
    const before = replaced
      ? deps.sealer.unseal('item', change.id, bytes(existing.sealed))
      : undefined;
    await dbAll(
      tx,
      sql`UPDATE ${t('item')}
          SET day_id = ${row.dayId}, place_id = ${row.placeId}, kind = ${row.kind}, start_time = ${row.start}, end_time = ${row.end}, fixed = ${row.fixed},
              position = ${row.position}, sealed = ${sealed}, updated_by = ${accountId},
              version = version + 1, seq = ${seq}, updated_at = ${now}
          WHERE id = ${change.id} AND trip_id = ${tripId}
          RETURNING id`,
    );
    if (before && existing.updatedBy) {
      const said = [before.title, before.notes].filter(Boolean).join(' — ');
      await notifyMembersOf(
        tx,
        { sealer: deps.sealer, now: deps.now, delivery: deps.delivery },
        [existing.updatedBy],
        tripId,
        accountId,
        'edit_replaced',
        {
          title: `Your change on “${tripName}” was replaced`,
          detail: said
            ? `Someone changed the same item after you, and their change stands. Yours said: ${said}`
            : 'Someone changed the same item after you, and their change stands.',
        },
      );
    }
    return;
  }
  await dbAll(
    tx,
    sql`INSERT INTO ${t('item')} (id, trip_id, day_id, place_id, kind, start_time, end_time, fixed, position, version, seq, created_by, updated_by, sealed, created_at, updated_at)
        VALUES (${change.id}, ${tripId}, ${row.dayId}, ${row.placeId}, ${row.kind}, ${row.start}, ${row.end}, ${row.fixed}, ${row.position}, 1, ${seq},
                ${accountId}, ${accountId}, ${sealed}, ${now}, ${now})
        RETURNING id`,
  );
  // An edit of a row that was deleted restores it: it is not gone any more.
  await clearGone(tx, tripId, 'item', change.id);
}
