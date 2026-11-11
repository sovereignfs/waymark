import { sql } from 'drizzle-orm';
import { EDITORS, memberOf, tableOf } from '../access/trip';
import type { Sealer } from '../crypto/sealed';
import type { Database } from '../db/client';
import { dbAll, dbGet } from '../db/exec';
import { localDate } from '../places/tz';
import { type Candidate, type Facts, type Point, decide } from './decide';

/**
 * Auto-link on the server (DESIGN.md §12, §15): what `src/sync/apply.ts` and the re-linking job (`queue.ts`) ask. **The decision is `decide`, the one pure function** the device runs too; this only gathers what it is given, from the
 * database, **for one account**: the trips the account is a Traveler or a going Organizer of (a statement that names its membership and its role), whose dates contain the check-in's local date, and the stops of those that are on that
 * date, with their places' points (sealed, opened here). Nothing is read about another person's trips, and nothing sealed is in a condition.
 */
const bytes = (value: Uint8Array | ArrayBuffer): Uint8Array =>
  value instanceof Uint8Array ? value : new Uint8Array(value);

/** The trips the account may be linked to on `date`, with the stops on that date. */
export async function candidatesOn(
  tx: Database,
  sealer: Sealer,
  accountId: string,
  date: string,
): Promise<Candidate[]> {
  const trips = await dbAll<{
    id: string;
    createdAt: number | string;
    startDate: string;
    endDate: string;
  }>(
    tx,
    sql`SELECT t.id AS id, t.created_at AS "createdAt", t.start_date AS "startDate", t.end_date AS "endDate"
        FROM ${tableOf(tx, 'trip')} t
        JOIN ${tableOf(tx, 'trip_member')} m ON m.trip_id = t.id
        WHERE m.account_id = ${accountId} AND m.left_at IS NULL AND m.role IN ('organizer', 'traveler') AND m.going = ${true}
          AND t.start_date <= ${date} AND t.end_date >= ${date}
        ORDER BY t.id`,
  );
  if (trips.length === 0) return [];
  const ids = sql.join(
    trips.map((trip) => sql`${trip.id}`),
    sql`, `,
  );
  const stops = await dbAll<{
    tripId: string;
    arrive: string;
    depart: string;
    sealed: Uint8Array | ArrayBuffer;
    placeId: string;
  }>(
    tx,
    sql`SELECT s.trip_id AS "tripId", s.arrive, s.depart, s.place_id AS "placeId", p.sealed
        FROM ${tableOf(tx, 'stop')} s
        JOIN ${tableOf(tx, 'place')} p ON p.id = s.place_id AND p.trip_id = s.trip_id
        WHERE s.trip_id IN (${ids}) AND s.arrive <= ${date} AND s.depart >= ${date}`,
  );
  return trips.map((trip) => ({
    id: trip.id,
    createdAt: Number(trip.createdAt),
    goes: true,
    startDate: trip.startDate,
    endDate: trip.endDate,
    stops: stops
      .filter((stop) => stop.tripId === trip.id)
      .map((stop) => {
        const place = sealer.unseal('place', stop.placeId, bytes(stop.sealed));
        return {
          arrive: stop.arrive,
          depart: stop.depart,
          point: { lat: place.lat, lng: place.lng } as Point,
        };
      }),
  }));
}

/** The point of one of the account's own places, or `undefined`: the check-in's place, which is the person's (a statement that names the owner). */
export async function pointOf(
  tx: Database,
  sealer: Sealer,
  accountId: string,
  placeId: string,
): Promise<Point | undefined> {
  const row = await dbGet<{ sealed: Uint8Array | ArrayBuffer }>(
    tx,
    sql`SELECT sealed FROM ${tableOf(tx, 'place')} WHERE id = ${placeId} AND account_id = ${accountId}`,
  );
  if (!row) return undefined;
  const place = sealer.unseal('place', placeId, bytes(row.sealed));
  return { lat: place.lat, lng: place.lng };
}

/** The trip a check-in of the account falls into, or `undefined`: its local date is the moment in **its own zone**, as the device works it out. */
export async function decideFor(
  tx: Database,
  sealer: Sealer,
  accountId: string,
  facts: { at: number; tz: string; placeId: string },
): Promise<string | undefined> {
  let date: string;
  try {
    date = localDate(facts.at, facts.tz);
  } catch {
    return undefined;
  }
  const trips = await candidatesOn(tx, sealer, accountId, date);
  if (trips.length === 0) return undefined;
  const point = await pointOf(tx, sealer, accountId, facts.placeId);
  const input: Facts = { at: facts.at, tz: facts.tz, point };
  return decide(input, trips);
}

/**
 * Whether the account may link a check-in to this trip **by hand** (DESIGN.md §11.1): an Organizer or a Traveler of it. A Follower, a former member and a stranger may not, and a link to a trip that is not theirs is refused as
 * a link to a trip that is not there. The permission is in the statement.
 */
export async function mayLink(tx: Database, accountId: string, tripId: string): Promise<boolean> {
  const row = await dbGet<{ id: string }>(
    tx,
    sql`SELECT t.id AS id FROM ${tableOf(tx, 'trip')} t WHERE t.id = ${tripId} AND ${memberOf(tx, sql`t.id`, accountId, EDITORS)}`,
  );
  return row !== undefined;
}
