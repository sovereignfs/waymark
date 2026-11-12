import { randomBytes } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { tableOf } from '../access/trip';
import { DEFAULT_LIMITS } from '../config';
import { ringOf } from '../crypto/keys';
import { Sealer } from '../crypto/sealed';
import type { Database } from '../db/client';
import { dbAll, dbGet, transaction } from '../db/exec';
import { makeStore, testTarget } from '../db/test-support';
import { listNotices } from '../notices/notices';
import { endMembershipsOf } from './people';
import { createTrip, getTrip } from './trips';

/**
 * What becomes of a person's part in trips when their account is deleted (DESIGN.md §11.4, §23): a trip with nobody else is deleted, one they alone organized passes to the longest-standing Traveler and then Follower
 * (who is told), nothing keeps naming them, and it is safe to run again.
 */
const { leg } = testTarget();
const ring = ringOf(randomBytes(32));
if (!ring) throw new Error('no ring');
const sealer = new Sealer(ring);
const [ADA, GRACE, SAM, NOOR] = ['ada-acct', 'grace-acct', 'sam-acct', 'noor-acct'];
let NOW = 1_800_000_000_000;
let database: Database;
let close: () => Promise<void>;
const deps = () => ({ database, sealer, now: () => ++NOW, limits: DEFAULT_LIMITS });
const farewell = (who: string, told = true) =>
  transaction(database, (tx) =>
    endMembershipsOf(
      tx,
      { now: () => ++NOW, ...(told ? { notices: { sealer, delivery: () => ({}) } } : {}) },
      who,
    ),
  );
const count = async (table: string, where = sql``): Promise<number> =>
  Number(
    (
      await dbGet<{ n: number | string }>(
        database,
        sql`SELECT COUNT(*) AS n FROM ${tableOf(database, table)} ${where}`,
      )
    )?.n ?? 0,
  );

async function join(
  tripId: string,
  accountId: string,
  role: string,
  joinedAt: number,
  addedBy: string | null = null,
  left = false,
) {
  await dbAll(
    database,
    sql`INSERT INTO ${tableOf(database, 'trip_member')} (trip_id, account_id, role, going, share_checkins, added_by, joined_at, left_at, seq)
        VALUES (${tripId}, ${accountId}, ${role}, ${role !== 'follower'}, 'ask', ${addedBy}, ${joinedAt}, ${left ? NOW : null}, 2) RETURNING trip_id`,
  );
}
const roleOf = async (tripId: string, who: string) =>
  (
    await dbGet<{ role: string }>(
      database,
      sql`SELECT role FROM ${tableOf(database, 'trip_member')} WHERE trip_id = ${tripId} AND account_id = ${who}`,
    )
  )?.role;

beforeAll(async () => {
  ({ database, close } = await makeStore());
});
afterAll(async () => close());
beforeEach(async () => {
  for (const table of ['trip_member', 'trip', 'checkin', 'account_stream', 'notice'])
    await dbAll(database, sql`DELETE FROM ${tableOf(database, table)} RETURNING 1 AS gone`);
});

describe(`a deleted account's trips (${leg})`, () => {
  it('deletes a trip with nobody else in it, and unlinks what was linked to it', async () => {
    const trip = await createTrip(deps(), ADA, { name: 'Alone' });
    await dbAll(
      database,
      sql`INSERT INTO ${tableOf(database, 'checkin')} (id, account_id, place_id, at, tz, offset_min, trip_id, link_source, share, source, version, seq, sealed, created_at, updated_at)
          VALUES ('c1', ${GRACE}, 'p', ${NOW}, 'Europe/Lisbon', 60, ${trip.id}, 'auto', 'trip', 'live', 1, 4, ${sealer.seal('checkin', 'c1', {})}, ${NOW}, ${NOW}) RETURNING id`,
    );
    await farewell(ADA);
    expect(await count('trip')).toBe(0);
    expect(await count('trip_member')).toBe(0);
    expect(await count('checkin', sql`WHERE id = 'c1' AND trip_id IS NULL`)).toBe(1);
  });

  it('passes a trip the person alone organized to its longest-standing Traveler, who is told', async () => {
    const trip = await createTrip(deps(), ADA, { name: 'Passes' });
    await join(trip.id, NOOR, 'follower', NOW - 5000, ADA);
    await join(trip.id, SAM, 'traveler', NOW - 1000, ADA);
    await join(trip.id, GRACE, 'traveler', NOW - 3000, ADA);
    await farewell(ADA);
    expect(await roleOf(trip.id, GRACE)).toBe('organizer');
    expect(await roleOf(trip.id, SAM)).toBe('traveler');
    expect(await roleOf(trip.id, NOOR)).toBe('follower');
    expect(await roleOf(trip.id, ADA)).toBeUndefined();
    const told = await listNotices({ database, sealer }, GRACE);
    expect(told.map((each) => each.kind)).toEqual(['organizer_passed']);
    expect(JSON.stringify(told)).not.toContain('Passes');
    expect(await listNotices({ database, sealer }, SAM)).toEqual([]);
    expect(await listNotices({ database, sealer }, ADA)).toEqual([]);
    expect((await getTrip(deps(), GRACE, trip.id))?.trip).toMatchObject({
      role: 'organizer',
      createdBy: null,
    });
  });

  it('passes it to a Follower when there is no Traveler, and the trip then has an Organizer', async () => {
    const trip = await createTrip(deps(), ADA, { name: 'Followers only' });
    await join(trip.id, NOOR, 'follower', NOW - 100, ADA);
    await join(trip.id, SAM, 'follower', NOW - 900, ADA);
    await farewell(ADA);
    expect(await roleOf(trip.id, SAM)).toBe('organizer');
    expect(await roleOf(trip.id, NOOR)).toBe('follower');
  });

  it('passes nothing when another Organizer is there, and a member who is not the Organizer just goes', async () => {
    const trip = await createTrip(deps(), ADA, { name: 'Co-organized' });
    await join(trip.id, GRACE, 'organizer', NOW - 100, ADA);
    await join(trip.id, SAM, 'traveler', NOW - 100, ADA);
    await farewell(ADA);
    expect(await roleOf(trip.id, SAM)).toBe('traveler');
    expect(await roleOf(trip.id, GRACE)).toBe('organizer');
    expect(await count('notice')).toBe(0);
    await farewell(SAM);
    expect(await roleOf(trip.id, SAM)).toBeUndefined();
    expect(await count('trip', sql`WHERE id = ${trip.id}`)).toBe(1);
  });

  it('passes a trip to nobody who has left it, and deletes it when only people who left remain', async () => {
    const trip = await createTrip(deps(), ADA, { name: 'Left behind' });
    await join(trip.id, SAM, 'traveler', NOW - 100, ADA, true);
    await farewell(ADA);
    expect(await count('trip', sql`WHERE id = ${trip.id}`)).toBe(0);
    expect(await count('trip_member', sql`WHERE trip_id = ${trip.id}`)).toBe(0);
  });

  it('clears what names the person, keeps what they wrote as the trip’s, and is safe to run again', async () => {
    const trip = await createTrip(deps(), GRACE, { name: 'Hers' });
    await join(trip.id, ADA, 'traveler', NOW - 100, GRACE);
    await join(trip.id, SAM, 'traveler', NOW - 50, ADA);
    await dbAll(
      database,
      sql`UPDATE ${tableOf(database, 'trip')} SET created_by = ${ADA} WHERE id = ${trip.id} RETURNING id`,
    );
    await farewell(ADA);
    await farewell(ADA);
    expect(await count('trip', sql`WHERE created_by = ${ADA}`)).toBe(0);
    expect(await count('trip_member', sql`WHERE added_by = ${ADA}`)).toBe(0);
    expect(await count('trip_member', sql`WHERE account_id = ${ADA}`)).toBe(0);
    expect(await count('trip_member', sql`WHERE trip_id = ${trip.id}`)).toBe(2);
    expect(await count('notice')).toBe(0);
  });

  it('still passes the trip when nobody can be told', async () => {
    const trip = await createTrip(deps(), ADA, { name: 'Quiet' });
    await join(trip.id, SAM, 'traveler', NOW - 100, ADA);
    await farewell(ADA, false);
    expect(await roleOf(trip.id, SAM)).toBe('organizer');
    expect(await count('notice')).toBe(0);
  });
});
