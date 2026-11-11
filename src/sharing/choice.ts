import { sql } from 'drizzle-orm';
import { EDITORS, memberOf, tableOf } from '../access/trip';
import { dbAll, transaction } from '../db/exec';
import { TRIP_ID, TripError } from '../trips/format';
import type { TripDeps } from '../trips/trips';
import { resyncAuthor } from './copies';
import { SHARE_CHOICES, type ShareChoice } from './rules';

/**
 * A Traveler's choice for one trip (DESIGN.md §11.3): **share their check-ins on it with its members, or keep them private**. The first time one of their check-ins links to a trip that has other members the screen asks once; the
 * answer is this. It is **their own**, changed only by them, and only while they are an Organizer or a Traveler of the trip (a Follower has no check-ins in it, so no choice: for them, a former member and a stranger the trip is
 * not there). The permission is in the statement: a guarded `UPDATE trip` shows the caller may, takes the trip's row and its next number, and what follows runs only if it did.
 *
 * Changing it makes the copies right **in the same transaction**: `on` shares every check-in of theirs in the trip that follows the trip (and tells the members who chose to hear of it), `off` or `ask` removes the copies of those that
 * do. A check-in that says `on` or `off` for itself is not changed by the trip's choice.
 */
export async function setShareChoice(
  deps: TripDeps,
  accountId: string,
  tripId: string,
  choice: string,
): Promise<ShareChoice | undefined> {
  if (!TRIP_ID.test(tripId)) return undefined;
  if (!(SHARE_CHOICES as readonly string[]).includes(choice))
    throw new TripError(`The choice is one of ${SHARE_CHOICES.join(', ')}.`);
  const next = choice as ShareChoice;
  return transaction(deps.database, async (tx) => {
    const touched = await dbAll<{ seq: number | string }>(
      tx,
      sql`UPDATE ${tableOf(tx, 'trip')} SET seq = seq + 1
          WHERE id = ${tripId} AND ${memberOf(tx, sql`${tripId}`, accountId, EDITORS)}
          RETURNING seq`,
    );
    const trip = touched[0];
    if (!trip) return undefined;
    const changed = await dbAll<{ forTrip: string }>(
      tx,
      sql`UPDATE ${tableOf(tx, 'trip_member')} SET share_checkins = ${next}, seq = ${Number(trip.seq)}
          WHERE trip_id = ${tripId} AND account_id = ${accountId} AND left_at IS NULL AND share_checkins <> ${next}
          RETURNING share_checkins AS "forTrip"`,
    );
    if (changed.length > 0) await resyncAuthor(tx, { ...deps, notify: deps }, tripId, accountId);
    return next;
  });
}
