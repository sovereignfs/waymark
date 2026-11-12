import { randomBytes, randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { tableOf } from '../access/trip';
import { DEFAULT_LIMITS } from '../config';
import { ringOf } from '../crypto/keys';
import { Sealer } from '../crypto/sealed';
import type { Database } from '../db/client';
import { dbAll, dbGet } from '../db/exec';
import { makeStore, testTarget } from '../db/test-support';
import { createProfile } from '../profile/profile';
import { TripError } from './format';
import {
  LimitReached,
  type TripDeps,
  createTrip,
  deleteTrip,
  getTrip,
  listTrips,
  previewDeletion,
  updateTrip,
} from './trips';

/**
 * Trips (DESIGN.md §10.1, §11.1, §5.2), against whichever database the leg runs on. **The permission is in the statement**: a trip that is not the caller's, or that their role does not allow them to change, is a trip that is
 * not there, for every operation; what a trip is called is sealed; and deleting a trip leaves no row of it and leaves other people's check-ins theirs.
 */
const { leg } = testTarget();
const ring = ringOf(randomBytes(32));
if (!ring) throw new Error('no ring');
const sealer = new Sealer(ring);
const ADA = 'ada-account';
const GRACE = 'grace-account';
const SAM = 'sam-account';
const NOOR = 'noor-account';
let NOW = 1_800_000_000_000;

let database: Database;
let close: () => Promise<void>;
let deps: TripDeps;

const count = async (table: string, where = sql``): Promise<number> =>
  Number(
    (
      await dbGet<{ n: number | string }>(
        database,
        sql`SELECT COUNT(*) AS n FROM ${tableOf(database, table)} ${where}`,
      )
    )?.n ?? 0,
  );

/** Puts a person in a trip in a role, as 10.1 will (there is no operation for it yet). */
async function join(
  tripId: string,
  accountId: string,
  role: 'organizer' | 'traveler' | 'follower',
  left = false,
) {
  await dbAll(
    database,
    sql`INSERT INTO ${tableOf(database, 'trip_member')} (trip_id, account_id, role, going, share_checkins, joined_at, left_at, seq)
        VALUES (${tripId}, ${accountId}, ${role}, ${role !== 'follower'}, 'ask', ${NOW}, ${left ? NOW : null}, 2) RETURNING trip_id`,
  );
}

beforeAll(async () => {
  ({ database, close } = await makeStore());
  deps = { database, sealer, now: () => ++NOW, limits: DEFAULT_LIMITS };
  for (const [id, name, email] of [
    [ADA, 'Ada Lovelace', 'ada@example.com'],
    [GRACE, 'Grace Hopper', 'grace@example.com'],
    [SAM, 'Sam Rivera', 'sam@example.com'],
    [NOOR, 'Noor Khan', 'noor@example.com'],
  ] as const)
    await createProfile(database, sealer, { accountId: id, name, email }, NOW);
});
afterAll(async () => close());
beforeEach(async () => {
  for (const table of ['trip_member', 'trip', 'checkin', 'account_stream'])
    await dbAll(database, sql`DELETE FROM ${tableOf(database, table)} RETURNING 1 AS gone`);
  deps = { ...deps, limits: DEFAULT_LIMITS };
});

describe(`making and reading a trip (${leg})`, () => {
  it('makes a trip with its creator as its first Organizer, who is going', async () => {
    const trip = await createTrip(deps, ADA, {
      name: '  Iberia  ',
      description: 'Two weeks',
      color: 'info',
    });
    expect(trip).toMatchObject({
      name: 'Iberia',
      description: 'Two weeks',
      color: 'info',
      role: 'organizer',
      going: true,
      createdBy: ADA,
      startDate: null,
      endDate: null,
      readyAt: null,
      seq: 1,
    });
    const detail = await getTrip(deps, ADA, trip.id);
    expect(detail?.members).toEqual([
      expect.objectContaining({
        accountId: ADA,
        role: 'organizer',
        going: true,
        self: true,
        name: 'Ada Lovelace',
        email: 'ada@example.com',
      }),
    ]);
  });

  it('seals what a trip is called: the database holds neither the name nor the description', async () => {
    const trip = await createTrip(deps, ADA, {
      name: 'Secret Itinerary',
      description: 'Where we will be',
    });
    const row = await dbGet<{ sealed: Uint8Array }>(
      database,
      sql`SELECT sealed FROM ${tableOf(database, 'trip')} WHERE id = ${trip.id}`,
    );
    const text = Buffer.from(row?.sealed ?? []).toString('latin1');
    expect(text).not.toContain('Secret');
    expect(text).not.toContain('Where we will be');
    // And it is bound to its row: another row's envelope does not open as this one.
    expect(() => sealer.unseal('trip', randomUUID(), row?.sealed ?? new Uint8Array())).toThrow();
  });

  it('refuses what is not a trip: no name, a long one, a line break, a colour that is not one, a long description', async () => {
    for (const bad of [
      { name: '' },
      { name: '   ' },
      { name: 'x'.repeat(121) },
      { name: 'a\nb' },
      { name: 5 },
      { name: 'ok', color: 'purple' },
      { name: 'ok', description: 'x'.repeat(2001) },
      { name: 'ok', description: 5 },
    ])
      await expect(
        createTrip(deps, ADA, bad),
        JSON.stringify(bad).slice(0, 40),
      ).rejects.toBeInstanceOf(TripError);
    expect(await count('trip')).toBe(0);
    expect(await count('trip_member')).toBe(0);
  });

  it('lists only the trips the caller is in, with their part in each', async () => {
    const mine = await createTrip(deps, ADA, { name: 'Mine' });
    const hers = await createTrip(deps, GRACE, { name: 'Hers' });
    await join(hers.id, ADA, 'follower');
    const left = await createTrip(deps, GRACE, { name: 'Left' });
    await join(left.id, ADA, 'traveler', true);
    const list = await listTrips(deps, ADA);
    expect(list.map((trip) => [trip.name, trip.role]).sort()).toEqual([
      ['Hers', 'follower'],
      ['Mine', 'organizer'],
    ]);
    expect(list.find((trip) => trip.id === mine.id)?.going).toBe(true);
    expect(list.find((trip) => trip.id === hers.id)?.going).toBe(false);
    expect((await listTrips(deps, SAM)).length).toBe(0);
  });

  it('is not there for a person who is not in it, or has left it, or asks for what is not an id', async () => {
    const trip = await createTrip(deps, ADA, { name: 'Private' });
    await join(trip.id, SAM, 'traveler', true);
    for (const stranger of [GRACE, SAM]) {
      expect(await getTrip(deps, stranger, trip.id)).toBeUndefined();
      expect(await updateTrip(deps, stranger, trip.id, { name: 'Hers now' })).toBeUndefined();
      expect(await previewDeletion(deps, stranger, trip.id)).toBeUndefined();
      expect(await deleteTrip(deps, stranger, trip.id)).toBe(false);
    }
    expect(await getTrip(deps, ADA, 'not-an-id')).toBeUndefined();
    expect(await getTrip(deps, ADA, randomUUID())).toBeUndefined();
    expect((await getTrip(deps, ADA, trip.id))?.trip.name).toBe('Private');
  });

  it('shows every member a name and an address only to the Organizers and to the person themselves', async () => {
    const trip = await createTrip(deps, ADA, { name: 'Party' });
    await join(trip.id, GRACE, 'organizer');
    await join(trip.id, SAM, 'traveler');
    await join(trip.id, NOOR, 'follower');
    const seenBy = async (who: string) => (await getTrip(deps, who, trip.id))?.members ?? [];
    const emailsFor = async (who: string) =>
      Object.fromEntries((await seenBy(who)).map((m) => [m.name, m.email]));
    // An Organizer sees everyone's.
    expect(await emailsFor(ADA)).toEqual({
      'Ada Lovelace': 'ada@example.com',
      'Grace Hopper': 'grace@example.com',
      'Sam Rivera': 'sam@example.com',
      'Noor Khan': 'noor@example.com',
    });
    // A Traveler and a Follower see every name and only their own address.
    expect(await emailsFor(SAM)).toEqual({
      'Ada Lovelace': undefined,
      'Grace Hopper': undefined,
      'Sam Rivera': 'sam@example.com',
      'Noor Khan': undefined,
    });
    expect(await emailsFor(NOOR)).toEqual({
      'Ada Lovelace': undefined,
      'Grace Hopper': undefined,
      'Sam Rivera': undefined,
      'Noor Khan': 'noor@example.com',
    });
    // Organizers first, then Travelers, then Followers.
    expect((await seenBy(SAM)).map((m) => m.role)).toEqual([
      'organizer',
      'organizer',
      'traveler',
      'follower',
    ]);
  });
});

describe(`changing a trip (${leg})`, () => {
  it('renames, recolours and describes it, an Organizer only, each change advancing the trip’s counter', async () => {
    const trip = await createTrip(deps, ADA, { name: 'Old', description: 'Keep me' });
    const renamed = await updateTrip(deps, ADA, trip.id, { name: 'New' });
    expect(renamed).toMatchObject({ name: 'New', description: 'Keep me', color: 'accent', seq: 2 });
    const recoloured = await updateTrip(deps, ADA, trip.id, { color: 'success' });
    expect(recoloured).toMatchObject({ name: 'New', color: 'success', seq: 3 });
    const described = await updateTrip(deps, ADA, trip.id, { description: 'Different' });
    expect(described).toMatchObject({ description: 'Different', seq: 4 });
    const cleared = await updateTrip(deps, ADA, trip.id, { description: null });
    expect(cleared?.description).toBeUndefined();
    expect(cleared?.name).toBe('New');
  });

  it('is refused to a Traveler and a Follower, and changes nothing', async () => {
    const trip = await createTrip(deps, ADA, { name: 'Kept' });
    await join(trip.id, SAM, 'traveler');
    await join(trip.id, NOOR, 'follower');
    for (const who of [SAM, NOOR]) {
      expect(await updateTrip(deps, who, trip.id, { name: 'Taken' })).toBeUndefined();
      expect(await previewDeletion(deps, who, trip.id)).toBeUndefined();
      expect(await deleteTrip(deps, who, trip.id)).toBe(false);
    }
    expect((await getTrip(deps, ADA, trip.id))?.trip).toMatchObject({ name: 'Kept', seq: 1 });
    expect(await count('trip_member')).toBe(3);
  });

  it('refuses a value that is not a trip’s, and a change by an Organizer who has left, before and without changing anything', async () => {
    const trip = await createTrip(deps, ADA, { name: 'Fine' });
    await expect(updateTrip(deps, ADA, trip.id, { name: '' })).rejects.toBeInstanceOf(TripError);
    await expect(updateTrip(deps, ADA, trip.id, { color: 'nope' })).rejects.toBeInstanceOf(
      TripError,
    );
    await join(trip.id, GRACE, 'organizer', true);
    expect(await updateTrip(deps, GRACE, trip.id, { name: 'Hers' })).toBeUndefined();
    expect((await getTrip(deps, ADA, trip.id))?.trip).toMatchObject({ name: 'Fine', seq: 1 });
  });

  it('writes two changes made at the same moment without one undoing the other', async () => {
    const trip = await createTrip(deps, ADA, { name: 'Start' });
    await join(trip.id, GRACE, 'organizer');
    const [a, b] = await Promise.all([
      updateTrip(deps, ADA, trip.id, { name: 'Renamed' }),
      updateTrip(deps, GRACE, trip.id, { description: 'Described' }),
    ]);
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    const after = (await getTrip(deps, ADA, trip.id))?.trip;
    expect(after).toMatchObject({ name: 'Renamed', description: 'Described', seq: 3 });
  });
});

describe(`the account's trips are limited (${leg})`, () => {
  it('refuses the trip that is one more than the limit, in a sentence, and makes nothing of it', async () => {
    const limited = { ...deps, limits: { ...DEFAULT_LIMITS, accountTrips: 2 } };
    await createTrip(limited, ADA, { name: 'One' });
    await createTrip(limited, ADA, { name: 'Two' });
    const refusal = await createTrip(limited, ADA, { name: 'Three' }).catch(
      (error: unknown) => error,
    );
    expect(refusal).toBeInstanceOf(LimitReached);
    expect((refusal as LimitReached).sentence).toContain('(2)');
    expect(await count('trip')).toBe(2);
    expect(await count('trip_member', sql`WHERE account_id = ${ADA}`)).toBe(2);
    // Another account is not held by it, and a trip left makes room.
    await createTrip(limited, GRACE, { name: 'Hers' });
    await dbAll(
      database,
      sql`UPDATE ${tableOf(database, 'trip_member')} SET left_at = ${NOW} WHERE account_id = ${ADA} RETURNING 1 AS x`,
    );
    await createTrip(limited, ADA, { name: 'Again' });
  });

  it('never deletes what is over a limit that was lowered: only adding more is refused', async () => {
    await createTrip(deps, ADA, { name: 'One' });
    await createTrip(deps, ADA, { name: 'Two' });
    const lowered = { ...deps, limits: { ...DEFAULT_LIMITS, accountTrips: 1 } };
    expect((await listTrips(lowered, ADA)).length).toBe(2);
    await expect(createTrip(lowered, ADA, { name: 'Three' })).rejects.toBeInstanceOf(LimitReached);
    expect((await listTrips(lowered, ADA)).length).toBe(2);
  });
});

describe(`deleting a trip (${leg})`, () => {
  /** A check-in row linked to a trip, as auto-link and the link a person makes will (9.7), and the owner's stream. */
  async function linked(accountId: string, tripId: string, id: string) {
    await dbAll(
      database,
      sql`INSERT INTO ${tableOf(database, 'checkin')} (id, account_id, place_id, at, tz, offset_min, trip_id, link_source, share, source, version, seq, sealed, created_at, updated_at)
          VALUES (${id}, ${accountId}, 'p1', ${NOW}, 'Europe/Lisbon', 60, ${tripId}, 'manual', 'trip', 'live', 3, 7, ${sealer.seal('checkin', id, {})}, ${NOW}, ${NOW}) RETURNING id`,
    );
  }

  it('says first what it would take: the members and the check-ins that are linked', async () => {
    const trip = await createTrip(deps, ADA, { name: 'Gone soon' });
    await join(trip.id, SAM, 'traveler');
    await linked(ADA, trip.id, 'c-ada');
    await linked(SAM, trip.id, 'c-sam');
    expect(await previewDeletion(deps, ADA, trip.id)).toEqual({
      name: 'Gone soon',
      members: 2,
      linkedCheckins: 2,
    });
  });

  it('leaves no row of the trip, and every linked check-in its author’s, unlinked in their own stream', async () => {
    const trip = await createTrip(deps, ADA, { name: 'Gone' });
    const other = await createTrip(deps, ADA, { name: 'Stays' });
    await join(trip.id, SAM, 'traveler');
    await join(trip.id, NOOR, 'follower');
    await linked(ADA, trip.id, 'c-ada1');
    await linked(ADA, trip.id, 'c-ada2');
    await linked(SAM, trip.id, 'c-sam');
    await linked(ADA, other.id, 'c-other');
    await dbAll(
      database,
      sql`INSERT INTO ${tableOf(database, 'account_stream')} (account_id, seq) VALUES (${ADA}, 10) RETURNING seq`,
    );

    expect(await deleteTrip(deps, ADA, trip.id)).toBe(true);

    expect(await count('trip', sql`WHERE id = ${trip.id}`)).toBe(0);
    expect(await count('trip_member', sql`WHERE trip_id = ${trip.id}`)).toBe(0);
    expect(await count('trip', sql`WHERE id = ${other.id}`)).toBe(1);
    expect(await count('checkin')).toBe(4);
    expect(await count('checkin', sql`WHERE trip_id = ${trip.id}`)).toBe(0);
    const rows = await dbAll<{
      id: string;
      tripId: string | null;
      linkSource: string | null;
      version: number | string;
      seq: number | string;
    }>(
      database,
      sql`SELECT id, trip_id AS "tripId", link_source AS "linkSource", version, seq FROM ${tableOf(database, 'checkin')} ORDER BY id`,
    );
    const byId = Object.fromEntries(rows.map((row) => [row.id, row]));
    // Unlinked, a new version, and a place in their own stream's order.
    expect(byId['c-ada1']).toMatchObject({ tripId: null, linkSource: null });
    expect(Number(byId['c-ada1']?.version)).toBe(4);
    expect([Number(byId['c-ada1']?.seq), Number(byId['c-ada2']?.seq)]).toEqual([11, 12]);
    expect(Number(byId['c-sam']?.seq)).toBe(1);
    // A check-in of another trip is not touched.
    expect(byId['c-other']).toMatchObject({ tripId: other.id, linkSource: 'manual' });
    expect(Number(byId['c-other']?.seq)).toBe(7);
    // The streams were advanced.
    const streams = await dbAll<{ accountId: string; seq: number | string }>(
      database,
      sql`SELECT account_id AS "accountId", seq FROM ${tableOf(database, 'account_stream')} ORDER BY account_id`,
    );
    expect(Object.fromEntries(streams.map((s) => [s.accountId, Number(s.seq)]))).toEqual({
      [ADA]: 12,
      [SAM]: 1,
    });
  });

  it('is safe to ask twice, and a Traveler cannot ask at all', async () => {
    const trip = await createTrip(deps, ADA, { name: 'Twice' });
    await join(trip.id, SAM, 'traveler');
    expect(await deleteTrip(deps, SAM, trip.id)).toBe(false);
    expect(await deleteTrip(deps, ADA, trip.id)).toBe(true);
    expect(await deleteTrip(deps, ADA, trip.id)).toBe(false);
  });

  it('removes a trip’s own places with it', async () => {
    const trip = await createTrip(deps, ADA, { name: 'With places' });
    await dbAll(
      database,
      sql`INSERT INTO ${tableOf(database, 'place')} (id, trip_id, source, version, seq, sealed, created_at, updated_at)
          VALUES ('tp1', ${trip.id}, 'manual', 1, 1, ${sealer.seal('place', 'tp1', { name: 'A', lat: 1, lng: 2 })}, ${NOW}, ${NOW}) RETURNING id`,
    );
    await deleteTrip(deps, ADA, trip.id);
    expect(await count('place', sql`WHERE trip_id = ${trip.id}`)).toBe(0);
  });
});
