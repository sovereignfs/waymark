import { sql } from 'drizzle-orm';
import { lockStreams } from '../access/locks';
import { MEMBERS, ORGANIZERS, memberOf, tableOf } from '../access/trip';
import type { Database } from '../db/client';
import { dbAll, dbGet, transaction } from '../db/exec';
import { raiseNotice } from '../notices/notices';
import { dropCopiesOf } from '../sharing/copies';
import { TRIP_ID, TripError } from './format';
import { notifyMembersOf } from './notify';
import { type TripDeps, type TripView, getTrip, unlinkCheckins } from './trips';

/**
 * **Leaving, removing and handing over** (DESIGN.md §11.4). Anyone leaves; an Organizer removes anyone else; the last Organizer of a trip with other people in it names who takes over first. Either way, in **one transaction**:
 *
 *  - the person's check-ins are **unlinked from the trip and unshared with it**: unlinked in their own stream (a new number each, so their devices find out; the check-ins themselves stay in their log, untouched), and their copies in the trip's
 *    stream removed (with a tombstone, `sharing/copies.ts`), so that after this nothing of theirs is in the trip's stream;
 *  - their membership **ends** (`left_at`; the row stays, so the trip can still say who was there, and every statement asks for `left_at IS NULL`);
 *  - what they planned and attached stays, as the trip's.
 *
 * The permission is in the statement: a guarded `UPDATE trip` shows the caller is a member (leaving) or an Organizer (removing) and takes the trip's number; what follows runs only if it did. A trip the caller is not in, and a person who is not in the
 * trip, are told it is not there (`undefined`), as everywhere. **A trip always has an Organizer:** the rule is in the statement that ends the membership as well as in the words that explain it. The streams of the people whose check-ins are unlinked are
 * taken before the trip's row (`access/locks.ts`), so that this meets a check-in being applied in one order.
 */
export type Left = { readonly left: true };

/** Nothing here for this caller: not a member, or not allowed (the same answer). */
class NotFound extends Error {}

const bytes = (value: Uint8Array | ArrayBuffer): Uint8Array =>
  value instanceof Uint8Array ? value : new Uint8Array(value);

/** Ends a person's part in a trip, in the caller's transaction: their check-ins unlinked and unshared, their membership ended. Returns whether there was a membership to end. */
async function endMembership(
  tx: Database,
  tripId: string,
  who: string,
  seq: number,
  now: number,
): Promise<boolean> {
  await unlinkCheckins(tx, tripId, now, who);
  await dropCopiesOf(tx, who, tripId, now);
  // Their Done marks are theirs, and of no use to a trip they are not in.
  await dbAll(
    tx,
    sql`DELETE FROM ${tableOf(tx, 'item_done')} WHERE trip_id = ${tripId} AND account_id = ${who} RETURNING item_id`,
  );
  const ended = await dbAll<{ accountId: string }>(
    tx,
    sql`UPDATE ${tableOf(tx, 'trip_member')} SET left_at = ${now}, seq = ${seq}
        WHERE trip_id = ${tripId} AND account_id = ${who} AND left_at IS NULL
          AND (role <> 'organizer' OR EXISTS (
            SELECT 1 FROM ${tableOf(tx, 'trip_member')} o
            WHERE o.trip_id = ${tripId} AND o.account_id <> ${who} AND o.role = 'organizer' AND o.left_at IS NULL))
        RETURNING account_id AS "accountId"`,
  );
  return ended.length > 0;
}

/** Leaves a trip. An Organizer who is the last of them must name `successor`, an active member, who becomes an Organizer in the same transaction. Throws `TripError` for the one thing refused in words. */
export async function leaveTrip(
  deps: TripDeps,
  accountId: string,
  tripId: string,
  successor?: string,
): Promise<Left | undefined> {
  if (!TRIP_ID.test(tripId)) return undefined;
  const now = deps.now();
  try {
    return await transaction(deps.database, async (tx) => {
      await lockStreams(tx, [accountId]);
      const touched = await dbAll<{ seq: number | string; sealed: Uint8Array | ArrayBuffer }>(
        tx,
        sql`UPDATE ${tableOf(tx, 'trip')} SET seq = seq + 1, updated_at = ${now}
            WHERE id = ${tripId} AND ${memberOf(tx, sql`${tripId}`, accountId, MEMBERS)}
            RETURNING seq, sealed`,
      );
      const trip = touched[0];
      if (!trip) throw new NotFound();
      const seq = Number(trip.seq);
      const me = await dbGet<{ role: string }>(
        tx,
        sql`SELECT role FROM ${tableOf(tx, 'trip_member')} WHERE trip_id = ${tripId} AND account_id = ${accountId} AND left_at IS NULL`,
      );
      if (me?.role === 'organizer') {
        const others = await dbAll<{ accountId: string; role: string }>(
          tx,
          sql`SELECT account_id AS "accountId", role FROM ${tableOf(tx, 'trip_member')}
              WHERE trip_id = ${tripId} AND account_id <> ${accountId} AND left_at IS NULL`,
        );
        if (!others.some((other) => other.role === 'organizer')) {
          if (others.length === 0)
            throw new TripError("You're the only one in this trip: delete it instead of leaving.");
          const next = others.find((other) => other.accountId === successor);
          if (!next)
            throw new TripError(
              "You're the last Organizer: choose who takes over before you leave.",
            );
          // Handed over in this transaction, so the trip is never without an Organizer.
          await dbAll(
            tx,
            sql`UPDATE ${tableOf(tx, 'trip_member')} SET role = 'organizer', going = ${true}, seq = ${seq}
                WHERE trip_id = ${tripId} AND account_id = ${next.accountId} AND left_at IS NULL
                RETURNING account_id`,
          );
          const name = deps.sealer.unseal('trip', tripId, bytes(trip.sealed)).name;
          await notifyMembersOf(tx, deps, [next.accountId], tripId, accountId, 'role_changed', {
            title: `Your part in “${name}” is now Organizer`,
            detail: 'The last Organizer left the trip and chose you to take over.',
          });
        }
      }
      if (!(await endMembership(tx, tripId, accountId, seq, now))) throw new NotFound();
      return { left: true } as const;
    });
  } catch (error) {
    if (error instanceof NotFound) return undefined;
    throw error;
  }
}

/** Removes a person from a trip: **Organizers only**, and not themselves (that is leaving). The person is told, in the bell, that they were removed. */
export async function removeMember(
  deps: TripDeps,
  accountId: string,
  tripId: string,
  target: string,
): Promise<TripView | undefined> {
  if (!TRIP_ID.test(tripId)) return undefined;
  if (typeof target !== 'string' || target.length < 1 || target.length > 128) return undefined;
  const now = deps.now();
  try {
    await transaction(deps.database, async (tx) => {
      await lockStreams(tx, [target]);
      const touched = await dbAll<{ seq: number | string; sealed: Uint8Array | ArrayBuffer }>(
        tx,
        sql`UPDATE ${tableOf(tx, 'trip')} SET seq = seq + 1, updated_at = ${now}
            WHERE id = ${tripId} AND ${memberOf(tx, sql`${tripId}`, accountId, ORGANIZERS)}
            RETURNING seq, sealed`,
      );
      const trip = touched[0];
      if (!trip) throw new NotFound();
      // Said only to an Organizer, who is allowed to ask: removing oneself is leaving.
      if (target === accountId) throw new TripError('To leave a trip, use Leave.');
      if (!(await endMembership(tx, tripId, target, Number(trip.seq), now))) throw new NotFound();
      const name = deps.sealer.unseal('trip', tripId, bytes(trip.sealed)).name;
      // About a trip they are not in any more, so it carries no trip and no link into it.
      await raiseNotice(
        tx,
        deps.sealer,
        now,
        {
          to: target,
          by: accountId,
          kind: 'role_changed',
          content: {
            title: `You were removed from “${name}”`,
            detail:
              'An Organizer removed you from the trip. Your check-ins are yours and are not in it any more.',
            href: '/',
          },
        },
        deps.delivery?.() ?? {},
      );
    });
  } catch (error) {
    if (error instanceof NotFound) return undefined;
    throw error;
  }
  return (await getTrip(deps, accountId, tripId))?.trip;
}
