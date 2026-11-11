import { sql } from 'drizzle-orm';
import { ORGANIZERS, memberOf, tableOf } from '../access/trip';
import { dbAll, dbGet, transaction } from '../db/exec';
import { notifyMembersOf } from './notify';
import { ROLES, type Role, TRIP_ID, TripError } from './format';
import { type TripDeps, type TripView, getTrip } from './trips';

/**
 * A person's part in a trip (DESIGN.md §11.1): changing a **role**, and an Organizer's **going** switch. **Organizers only**: the permission is in the statement, and a trip that is not the caller's, a role they do not have and a
 * person who is not in the trip are all the same answer (`undefined`: not found). **A trip always has an Organizer** (§11.1): the last one cannot become another role, and the rule is **in the statement that changes the role**
 * (`role <> 'organizer' OR another active Organizer exists`), on a trip whose row the transaction already holds, so that two Organizers demoting each other at the same moment leave one. Throws `TripError` for the one thing that is
 * refused in words.
 *
 * Adding, leaving and removing people are invitations (10.2) and 10.4; this is what the roles allow once someone is in.
 */
const ROLE_GOING: Readonly<Record<Role, boolean>> = {
  // Organizers and Travelers go; Followers follow along. An Organizer who only organizes switches it off with `setGoing`.
  organizer: true,
  traveler: true,
  follower: false,
};

/** Nothing changed (so nothing is written or said): the transaction is undone, and the trip is returned as it is. */
class Unchanged extends Error {}

const SOMEONE = (target: unknown): target is string =>
  typeof target === 'string' && target.length >= 1 && target.length <= 128;

export async function setRole(
  deps: TripDeps,
  accountId: string,
  tripId: string,
  target: string,
  role: string,
): Promise<TripView | undefined> {
  if (!TRIP_ID.test(tripId) || !SOMEONE(target)) return undefined;
  if (!(ROLES as readonly string[]).includes(role))
    throw new TripError(`A role is one of ${ROLES.join(', ')}.`);
  const next = role as Role;
  const now = deps.now();
  try {
    const done = await transaction(deps.database, async (tx) => {
      // The guarded statement: it shows the caller is an Organizer and takes the trip's row, so that what follows cannot change under it.
      const touched = await dbAll<{ seq: number | string; sealed: Uint8Array | ArrayBuffer }>(
        tx,
        sql`UPDATE ${tableOf(tx, 'trip')} SET seq = seq + 1, updated_at = ${now}
            WHERE id = ${tripId} AND ${memberOf(tx, sql`${tripId}`, accountId, ORGANIZERS)}
            RETURNING seq, sealed`,
      );
      const trip = touched[0];
      if (!trip) return 'not_found' as const;
      const changed = await dbAll<{ accountId: string }>(
        tx,
        sql`UPDATE ${tableOf(tx, 'trip_member')} SET role = ${next}, going = ${ROLE_GOING[next]}, seq = ${Number(trip.seq)}
            WHERE trip_id = ${tripId} AND account_id = ${target} AND left_at IS NULL AND role <> ${next}
              AND (role <> 'organizer' OR EXISTS (
                SELECT 1 FROM ${tableOf(tx, 'trip_member')} o
                WHERE o.trip_id = ${tripId} AND o.account_id <> ${target} AND o.role = 'organizer' AND o.left_at IS NULL))
            RETURNING account_id AS "accountId"`,
      );
      if (changed.length === 0) {
        const member = await dbGet<{ role: string }>(
          tx,
          sql`SELECT role FROM ${tableOf(tx, 'trip_member')} WHERE trip_id = ${tripId} AND account_id = ${target} AND left_at IS NULL`,
        );
        if (!member) throw new NotFound();
        if (member.role === next) throw new Unchanged();
        // They are the last Organizer, and the trip keeps one.
        throw new TripError(
          'A trip always has an Organizer: make another person an Organizer first.',
        );
      }
      const name = deps.sealer.unseal('trip', tripId, bytes(trip.sealed)).name;
      await notifyMembersOf(tx, deps, [target], tripId, accountId, 'role_changed', {
        title: `Your part in “${name}” is now ${LABEL[next]}`,
        detail: DETAIL[next],
      });
      return 'changed' as const;
    });
    if (done === 'not_found') return undefined;
  } catch (error) {
    if (error instanceof NotFound) return undefined;
    if (!(error instanceof Unchanged)) throw error;
  }
  return (await getTrip(deps, accountId, tripId))?.trip;
}

/** An Organizer's "Not going" switch for themselves (DESIGN.md §11.1): an Organizer who only organizes is not counted by the journal or by planned versus actual. A Traveler goes and a Follower does not, so for them there is no switch. */
export async function setGoing(
  deps: TripDeps,
  accountId: string,
  tripId: string,
  going: boolean,
): Promise<TripView | undefined> {
  if (!TRIP_ID.test(tripId)) return undefined;
  const now = deps.now();
  try {
    const found = await transaction(deps.database, async (tx) => {
      const touched = await dbAll<{ seq: number | string }>(
        tx,
        sql`UPDATE ${tableOf(tx, 'trip')} SET seq = seq + 1, updated_at = ${now}
            WHERE id = ${tripId} AND ${memberOf(tx, sql`${tripId}`, accountId, ORGANIZERS)}
            RETURNING seq`,
      );
      const trip = touched[0];
      if (!trip) return false;
      const changed = await dbAll<{ accountId: string }>(
        tx,
        sql`UPDATE ${tableOf(tx, 'trip_member')} SET going = ${going}, seq = ${Number(trip.seq)}
            WHERE trip_id = ${tripId} AND account_id = ${accountId} AND role = 'organizer' AND left_at IS NULL AND going <> ${going}
            RETURNING account_id AS "accountId"`,
      );
      if (changed.length === 0) throw new Unchanged();
      return true;
    });
    if (!found) return undefined;
  } catch (error) {
    if (!(error instanceof Unchanged)) throw error;
  }
  return (await getTrip(deps, accountId, tripId))?.trip;
}

class NotFound extends Error {}

const LABEL: Readonly<Record<Role, string>> = {
  organizer: 'Organizer',
  traveler: 'Traveler',
  follower: 'Follower',
};
const DETAIL: Readonly<Record<Role, string>> = {
  organizer: 'You can plan the trip, invite people and change what everyone may do.',
  traveler: 'You are going: you can read and edit the plan.',
  follower: 'You follow along: you can read the plan, but not change it.',
};

const bytes = (value: Uint8Array | ArrayBuffer): Uint8Array =>
  value instanceof Uint8Array ? value : new Uint8Array(value);
