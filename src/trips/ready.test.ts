import { randomBytes } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { tableOf } from '../access/trip';
import { DEFAULT_LIMITS } from '../config';
import { ringOf } from '../crypto/keys';
import { Sealer } from '../crypto/sealed';
import type { Database } from '../db/client';
import { dbAll, dbGet } from '../db/exec';
import { makeStore, testTarget } from '../db/test-support';
import { listNotices } from '../notices/notices';
import { PlanRefused, addStop, removeStop, updateStop } from './plan';
import { TripError } from './format';
import { createTrip, getTrip, listTrips, setReady } from './trips';

/**
 * Ready and status (DESIGN.md §10.2) against whichever database the leg runs on: a trip is planning until an Organizer marks it ready, which needs a stop with dates; its status then follows the dates in the first stop's zone; and
 * the members are told, in the transaction of the change, **never the person who made it**.
 */
const { leg } = testTarget();
const ring = ringOf(randomBytes(32));
if (!ring) throw new Error('no ring');
const sealer = new Sealer(ring);
const [ADA, SAM, NOOR, GRACE, STRANGER] = [
  'ada-acct',
  'sam-acct',
  'noor-acct',
  'grace-acct',
  'stranger-acct',
];
let clock = Date.parse('2026-05-01T12:00:00Z');
let database: Database;
let close: () => Promise<void>;
let deps: Parameters<typeof createTrip>[0];
let tripId: string;

const t = (name: string) => tableOf(database, name);
const count = async (table: string, where = sql``): Promise<number> =>
  Number(
    (
      await dbGet<{ n: number | string }>(
        database,
        sql`SELECT COUNT(*) AS n FROM ${t(table)} ${where}`,
      )
    )?.n ?? 0,
  );
const noticesOf = async (who: string) =>
  (await listNotices({ database, sealer }, who)).filter((n) => n.tripId === tripId);
const kinds = async (who: string) => (await noticesOf(who)).map((n) => n.kind);
const trip = async (who = ADA) => (await getTrip(deps, who, tripId))?.trip;
const lisbon = { name: 'Lisbon', lat: 38.72, lng: -9.14 };
const auckland = { name: 'Auckland', lat: -36.85, lng: 174.76 };

beforeAll(async () => {
  ({ database, close } = await makeStore());
  deps = { database, sealer, now: () => clock, limits: DEFAULT_LIMITS };
});
afterAll(async () => close());
beforeEach(async () => {
  clock = Date.parse('2026-05-01T12:00:00Z');
  for (const table of ['notice', 'item', 'day', 'stop', 'place', 'trip_member', 'trip'])
    await dbAll(database, sql`DELETE FROM ${t(table)} RETURNING 1 AS gone`);
  tripId = (await createTrip(deps, ADA, { name: 'Iberia' })).id;
  for (const [id, role] of [
    [SAM, 'traveler'],
    [NOOR, 'follower'],
  ] as const)
    await dbAll(
      database,
      sql`INSERT INTO ${t('trip_member')} (trip_id, account_id, role, going, share_checkins, joined_at, seq) VALUES (${tripId}, ${id}, ${role}, ${role === 'traveler'}, 'ask', ${clock}, 2) RETURNING trip_id`,
    );
  await dbAll(
    database,
    sql`INSERT INTO ${t('trip_member')} (trip_id, account_id, role, going, share_checkins, joined_at, left_at, seq) VALUES (${tripId}, ${GRACE}, 'traveler', ${true}, 'ask', ${clock}, ${clock}, 2) RETURNING trip_id`,
  );
});

describe(`marking a trip ready (${leg})`, () => {
  it('is planning until an Organizer marks it ready, and needs a stop with dates', async () => {
    expect(await trip()).toMatchObject({ status: 'planning', readyAt: null, datesPassed: false });
    await expect(setReady(deps, ADA, tripId, true)).rejects.toBeInstanceOf(TripError);
    await addStop(deps, ADA, tripId, { place: lisbon });
    await expect(setReady(deps, ADA, tripId, true)).rejects.toThrow('stop with dates');
    expect(await trip()).toMatchObject({ readyAt: null, seq: 2 });
    expect(await count('notice')).toBe(0);
    await addStop(deps, ADA, tripId, { place: lisbon, arrive: '2026-05-10', depart: '2026-05-14' });
    const ready = await setReady(deps, ADA, tripId, true);
    expect(ready).toMatchObject({ status: 'upcoming', readyAt: clock });
  });

  it('gives each status at the day’s edges, in the first stop’s zone', async () => {
    await addStop(deps, ADA, tripId, {
      place: auckland,
      arrive: '2026-05-10',
      depart: '2026-05-12',
    });
    await setReady(deps, ADA, tripId, true);
    // 2026-05-09 12:00 UTC is midnight at the start of 10 May in Auckland (UTC+12).
    for (const [iso, status] of [
      ['2026-05-09T11:59:59Z', 'upcoming'],
      ['2026-05-09T12:00:00Z', 'ongoing'],
      ['2026-05-12T11:59:59Z', 'ongoing'],
      ['2026-05-12T12:00:00Z', 'completed'],
    ] as const) {
      clock = Date.parse(iso);
      expect((await trip())?.status, iso).toBe(status);
      expect((await listTrips(deps, ADA))[0]?.status, iso).toBe(status);
    }
  });

  it('says that the dates of a trip still planning have passed, and it can then be marked ready', async () => {
    await addStop(deps, ADA, tripId, { place: lisbon, arrive: '2026-05-10', depart: '2026-05-12' });
    clock = Date.parse('2026-05-12T23:59:59+01:00');
    expect(await trip()).toMatchObject({ status: 'planning', datesPassed: false });
    clock = Date.parse('2026-05-13T00:00:00+01:00');
    expect(await trip()).toMatchObject({ status: 'planning', datesPassed: true });
    expect(await setReady(deps, ADA, tripId, true)).toMatchObject({
      status: 'completed',
      datesPassed: false,
    });
  });

  it('moves back to planning at any time, and asking for what is so already changes and tells nobody', async () => {
    await addStop(deps, ADA, tripId, { place: lisbon, arrive: '2026-05-10', depart: '2026-05-12' });
    await setReady(deps, ADA, tripId, true);
    const seq = (await trip())?.seq;
    expect(await setReady(deps, ADA, tripId, true)).toMatchObject({ status: 'upcoming', seq });
    expect(await count('notice')).toBe(2);
    expect(await setReady(deps, ADA, tripId, false)).toMatchObject({
      status: 'planning',
      readyAt: null,
    });
    expect(await setReady(deps, ADA, tripId, false)).toMatchObject({ status: 'planning' });
    expect(await count('notice')).toBe(4);
  });

  it('is for an Organizer only: a Traveler, a Follower and a stranger are told it is not there, and nothing changes', async () => {
    await addStop(deps, ADA, tripId, { place: lisbon, arrive: '2026-05-10', depart: '2026-05-12' });
    for (const who of [SAM, NOOR, STRANGER, GRACE])
      expect(await setReady(deps, who, tripId, true), who).toBeUndefined();
    expect(await trip()).toMatchObject({ readyAt: null });
    await setReady(deps, ADA, tripId, true);
    for (const who of [SAM, NOOR, STRANGER])
      expect(await setReady(deps, who, tripId, false), who).toBeUndefined();
    expect(await trip()).toMatchObject({ status: 'upcoming' });
    expect(await setReady(deps, ADA, 'not-an-id', true)).toBeUndefined();
  });

  it('is a ready trip with no dates left, planning, until it has dates again', async () => {
    const plan = await addStop(deps, ADA, tripId, {
      place: lisbon,
      arrive: '2026-05-10',
      depart: '2026-05-12',
    });
    await setReady(deps, ADA, tripId, true);
    await removeStop(deps, ADA, tripId, plan?.stops[0]?.id ?? '');
    expect(await trip()).toMatchObject({
      status: 'planning',
      readyAt: expect.any(Number),
      startDate: null,
      datesPassed: false,
    });
    await addStop(deps, ADA, tripId, { place: lisbon, arrive: '2026-05-20', depart: '2026-05-21' });
    expect((await trip())?.status).toBe('upcoming');
  });
});

describe(`telling the members (${leg})`, () => {
  it('tells every other active member that a trip is ready, and that it is back to planning, and never the Organizer who did it or a member who left', async () => {
    await addStop(deps, ADA, tripId, { place: lisbon, arrive: '2026-05-10', depart: '2026-05-12' });
    await setReady(deps, ADA, tripId, true);
    expect(await kinds(SAM)).toEqual(['trip_ready']);
    expect(await kinds(NOOR)).toEqual(['trip_ready']);
    for (const who of [ADA, GRACE, STRANGER]) expect(await kinds(who), who).toEqual([]);
    await setReady(deps, ADA, tripId, false);
    const sam = await noticesOf(SAM);
    expect(sam.map((n) => n.title).sort()).toEqual([
      '“Iberia” is back to planning',
      '“Iberia” is ready',
    ]);
    expect(sam.every((n) => n.href === `/trips/${tripId}`)).toBe(true);
  });

  it('says only the trip’s name, its dates and a link: no place, note or person, and what is said is sealed', async () => {
    await addStop(deps, ADA, tripId, {
      place: { name: 'Mosteiro dos Jerónimos', lat: 38.7, lng: -9.2 },
      note: 'Pastéis de Belém',
      arrive: '2026-05-10',
      depart: '2026-05-12',
    });
    await setReady(deps, ADA, tripId, true);
    const [notice] = await noticesOf(SAM);
    expect(notice?.detail).toBe('It runs from 2026-05-10 to 2026-05-12.');
    expect(JSON.stringify(notice)).not.toMatch(/Jerónimos|Pastéis|Ada/);
    const rows = await dbAll<{ sealed: Uint8Array }>(
      database,
      sql`SELECT sealed FROM ${t('notice')}`,
    );
    for (const row of rows)
      expect(Buffer.from(row.sealed).toString('latin1')).not.toContain('Iberia');
  });

  it('tells nobody of a change that is refused, and the notice is not made if the transaction is not', async () => {
    await addStop(deps, ADA, tripId, { place: lisbon, arrive: '2026-05-10', depart: '2026-05-12' });
    await setReady(deps, ADA, tripId, true);
    const before = await count('notice');
    await expect(
      addStop(deps, ADA, tripId, { place: lisbon, arrive: '2026-05-11', depart: '2026-05-13' }),
    ).rejects.toBeInstanceOf(PlanRefused);
    expect(await count('notice')).toBe(before);
  });
});

describe(`telling the members of new dates (${leg})`, () => {
  it('tells nobody while the trip is being planned, however its dates change', async () => {
    const plan = await addStop(deps, ADA, tripId, {
      place: lisbon,
      arrive: '2026-05-10',
      depart: '2026-05-12',
    });
    await updateStop(deps, ADA, tripId, plan?.stops[0]?.id ?? '', {
      arrive: '2026-05-11',
      depart: '2026-05-15',
    });
    await addStop(deps, SAM, tripId, { place: lisbon, arrive: '2026-06-01', depart: '2026-06-02' });
    expect(await count('notice')).toBe(0);
  });

  it('tells every other member when the dates of a ready trip change, once for the change, and not the one who made it', async () => {
    const plan = await addStop(deps, ADA, tripId, {
      place: lisbon,
      arrive: '2026-05-10',
      depart: '2026-05-12',
    });
    await setReady(deps, ADA, tripId, true);
    await dbAll(database, sql`DELETE FROM ${t('notice')} RETURNING 1 AS gone`);
    // A Traveler moves the end: the Organizer and the Follower are told.
    await updateStop(deps, SAM, tripId, plan?.stops[0]?.id ?? '', {
      arrive: '2026-05-10',
      depart: '2026-05-13',
    });
    expect(await kinds(ADA)).toEqual(['trip_dates']);
    expect(await kinds(NOOR)).toEqual(['trip_dates']);
    expect(await kinds(SAM)).toEqual([]);
    expect((await noticesOf(NOOR))[0]).toMatchObject({
      title: 'The dates of “Iberia” changed',
      detail: 'It now runs from 2026-05-10 to 2026-05-13.',
    });
  });

  it('tells nobody when the dates stay as they are: a note, an undated stop, a stop made and removed inside them', async () => {
    const plan = await addStop(deps, ADA, tripId, {
      place: lisbon,
      arrive: '2026-05-10',
      depart: '2026-05-14',
    });
    await addStop(deps, ADA, tripId, { place: lisbon, arrive: '2026-05-14', depart: '2026-05-14' });
    await setReady(deps, ADA, tripId, true);
    await dbAll(database, sql`DELETE FROM ${t('notice')} RETURNING 1 AS gone`);
    await updateStop(deps, ADA, tripId, plan?.stops[0]?.id ?? '', { note: 'Noted' });
    await addStop(deps, ADA, tripId, { place: lisbon });
    // A second undated stop made and removed, and the first still sets both ends of the trip.
    const more = await addStop(deps, ADA, tripId, { place: lisbon });
    await removeStop(deps, ADA, tripId, more?.stops.at(-1)?.id ?? '');
    expect(await count('notice')).toBe(0);
  });

  it('says so when a ready trip loses its dates', async () => {
    const plan = await addStop(deps, ADA, tripId, {
      place: lisbon,
      arrive: '2026-05-10',
      depart: '2026-05-12',
    });
    await setReady(deps, ADA, tripId, true);
    await dbAll(database, sql`DELETE FROM ${t('notice')} RETURNING 1 AS gone`);
    await removeStop(deps, ADA, tripId, plan?.stops[0]?.id ?? '');
    expect((await noticesOf(SAM))[0]).toMatchObject({
      kind: 'trip_dates',
      detail: 'It has no dates now.',
    });
  });
});
