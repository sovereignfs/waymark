import { randomBytes, randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tableOf } from '../access/trip';
import { DEFAULT_LIMITS } from '../config';
import { ringOf } from '../crypto/keys';
import { Sealer } from '../crypto/sealed';
import type { Database } from '../db/client';
import { dbAll } from '../db/exec';
import { makeStore, testTarget } from '../db/test-support';
import { RateLimiter } from '../limits/rate';
import { OPS_BODY_BYTES, type OpsDeps, handleOp, opsResponse } from './endpoint';
import { OPERATIONS, type Op, type OpName, applyOp, parseOp } from './ops';
import { addStop } from './plan';
import { createTrip } from './trips';

/**
 * The operations on trips (DESIGN.md §15.7) as a request meets them, and **every operation as a stranger and as each role** (DESIGN.md §5.2): a table of operations says who may do each, and this calls each as someone who is not in the
 * trip and as a Traveler and a Follower, and expects what the table says: `not_found`, the same words for a trip that is not theirs and one they may not change.
 */
const { leg } = testTarget();
const ring = ringOf(randomBytes(32));
if (!ring) throw new Error('no ring');
const sealer = new Sealer(ring);
const [ADA, SAM, NOOR, STRANGER] = [
  'ada-account',
  'sam-account',
  'noor-account',
  'stranger-account',
];
let NOW = 1_800_000_000_000;

let database: Database;
let close: () => Promise<void>;
let deps: OpsDeps;
let tripId: string;

beforeAll(async () => {
  ({ database, close } = await makeStore());
  deps = {
    database,
    sealer,
    now: () => ++NOW,
    limits: DEFAULT_LIMITS,
    limiter: new RateLimiter(database),
  };
  tripId = (await createTrip(deps, ADA, { name: 'Shared' })).id;
  for (const [id, role] of [
    [SAM, 'traveler'],
    [NOOR, 'follower'],
  ] as const)
    await dbAll(
      database,
      sql`INSERT INTO ${tableOf(database, 'trip_member')} (trip_id, account_id, role, going, share_checkins, joined_at, seq)
          VALUES (${tripId}, ${id}, ${role}, ${role === 'traveler'}, 'ask', ${NOW}, 2) RETURNING trip_id`,
    );
});
afterAll(async () => close());

/** One request for each operation, against the trip above: written for every name, so that a new operation fails to compile here until it is. */
const REQUESTS: Record<OpName, (id: string, stopId: string) => Op> = {
  'trip.list': () => ({ op: 'trip.list' }),
  'trip.get': (id) => ({ op: 'trip.get', tripId: id }),
  'trip.create': () => ({ op: 'trip.create', name: 'A new one' }),
  'trip.update': (id) => ({ op: 'trip.update', tripId: id, name: 'Changed' }),
  'trip.plan': (id) => ({ op: 'trip.plan', tripId: id }),
  'stop.add': (id) => ({
    op: 'stop.add',
    tripId: id,
    place: { name: 'Lisbon', lat: 38.72, lng: -9.14 },
  }),
  'stop.update': (id, stopId) => ({ op: 'stop.update', tripId: id, stopId, note: 'A note' }),
  'stop.move': (id, stopId) => ({ op: 'stop.move', tripId: id, stopId, before: null }),
  'stop.remove': (id, stopId) => ({ op: 'stop.remove', tripId: id, stopId }),
  'trip.delete.preview': (id) => ({ op: 'trip.delete.preview', tripId: id }),
  'trip.delete': (id) => ({ op: 'trip.delete', tripId: id, confirm: true }),
};

/** A stop of the trip made by its Organizer, for an operation on a stop to be tried against: each test gets its own, since some remove it. */
const freshStop = async (): Promise<string> => {
  const plan = await addStop(deps, ADA, tripId, { place: { name: 'Somewhere', lat: 1, lng: 2 } });
  const stop = plan?.stops.at(-1);
  if (!stop) throw new Error('no stop was made');
  return stop.id;
};

describe(`every operation, as a stranger and as each role (${leg})`, () => {
  it('has a request for every operation the table names, and the table names every operation', () => {
    expect(Object.keys(REQUESTS).sort()).toEqual(Object.keys(OPERATIONS).sort());
  });

  for (const name of Object.keys(OPERATIONS) as OpName[]) {
    const who = OPERATIONS[name];
    if (who === 'account') continue;
    it(`${name}: a stranger is told it is not there`, async () => {
      const result = await applyOp(deps, STRANGER, REQUESTS[name](tripId, await freshStop()));
      expect(result).toEqual({ ok: false, reason: 'not_found' });
    });
    it(`${name}: a trip that is not an id's is told it is not there, as a stranger is`, async () => {
      const result = await applyOp(deps, ADA, REQUESTS[name](randomUUID(), randomUUID()));
      expect(result).toEqual({ ok: false, reason: 'not_found' });
    });
    // Who may: Followers are refused what edits, Travelers what only an Organizer does.
    const refused: [string, string][] =
      who === 'organizer'
        ? [
            ['Traveler', SAM],
            ['Follower', NOOR],
          ]
        : who === 'editor'
          ? [['Follower', NOOR]]
          : [];
    const allowed: [string, string][] =
      who === 'organizer'
        ? []
        : who === 'editor'
          ? [['Traveler', SAM]]
          : [
              ['Traveler', SAM],
              ['Follower', NOOR],
            ];
    for (const [role, id] of refused)
      it(`${name}: a ${role} is told it is not there`, async () => {
        expect(await applyOp(deps, id, REQUESTS[name](tripId, await freshStop()))).toEqual({
          ok: false,
          reason: 'not_found',
        });
      });
    for (const [role, id] of allowed)
      it(`${name}: a ${role} may`, async () => {
        expect((await applyOp(deps, id, REQUESTS[name](tripId, await freshStop()))).ok).toBe(true);
      });
  }

  it('lets the Organizer do each, last the one that deletes', async () => {
    for (const name of [
      'trip.list',
      'trip.get',
      'trip.plan',
      'trip.update',
      'trip.delete.preview',
      'stop.add',
      'stop.update',
      'stop.move',
      'stop.remove',
    ] as OpName[])
      expect((await applyOp(deps, ADA, REQUESTS[name](tripId, await freshStop()))).ok, name).toBe(
        true,
      );
    expect((await applyOp(deps, ADA, REQUESTS['trip.create'](tripId, ''))).ok).toBe(true);
    // The Organizer's changes were really made, and a stranger's were not.
    const got = await applyOp(deps, ADA, { op: 'trip.get', tripId });
    expect(got).toMatchObject({ ok: true, trip: { name: 'Changed' } });
    expect(await applyOp(deps, ADA, REQUESTS['trip.delete'](tripId, ''))).toEqual({
      ok: true,
      deleted: true,
    });
    expect(await applyOp(deps, ADA, { op: 'trip.get', tripId })).toEqual({
      ok: false,
      reason: 'not_found',
    });
  });
});

describe('a request is an operation', () => {
  const id = randomUUID();
  it('is a known name with the keys it takes, and a trip id where one is needed', () => {
    for (const op of [
      { op: 'trip.list' },
      { op: 'trip.get', tripId: id },
      { op: 'trip.create', name: 'X' },
      { op: 'trip.create', name: 'X', description: 'Y', color: 'info' },
      { op: 'trip.update', tripId: id, color: 'info' },
      { op: 'trip.delete.preview', tripId: id },
      { op: 'trip.delete', tripId: id, confirm: true },
      { op: 'trip.plan', tripId: id },
      {
        op: 'stop.add',
        tripId: id,
        place: { name: 'P', lat: 1, lng: 2 },
        arrive: '2026-05-01',
        depart: '2026-05-03',
        note: 'n',
      },
      { op: 'stop.update', tripId: id, stopId: id, arrive: null, depart: null },
      { op: 'stop.move', tripId: id, stopId: id, before: null },
      { op: 'stop.move', tripId: id, stopId: id, before: id },
      { op: 'stop.remove', tripId: id, stopId: id },
      { op: 'trip.update', tripId: id, coverPlaceId: null },
    ])
      expect(parseOp(op).ok, JSON.stringify(op)).toBe(true);
  });

  it('is nothing else', () => {
    for (const bad of [
      null,
      [],
      'trip.list',
      {},
      { op: 'trip.destroy' },
      { op: 'trip.list', extra: 1 },
      { op: 'trip.get' },
      { op: 'trip.get', tripId: 'abc' },
      { op: 'trip.get', tripId: id, accountId: 'someone-else' },
      { op: 'trip.create' },
      { op: 'trip.update', tripId: id },
      { op: 'trip.delete', tripId: id },
      { op: 'trip.delete', tripId: id, confirm: 'yes' },
      { op: 'stop.add', tripId: id },
      { op: 'stop.add', tripId: id, place: 'Lisbon' },
      { op: 'stop.update', tripId: id, stopId: id },
      { op: 'stop.update', tripId: id, stopId: 'abc', note: 'x' },
      { op: 'stop.move', tripId: id, stopId: id },
      { op: 'stop.move', tripId: id, stopId: id, before: 'abc' },
      { op: 'stop.remove', tripId: id },
      { op: 'stop.remove', tripId: id, stopId: id, force: true },
      { op: 'constructor' },
      { op: '__proto__' },
    ])
      expect(parseOp(bad).ok, JSON.stringify(bad)).toBe(false);
  });
});

describe(`the endpoint (${leg})`, () => {
  const post = (body: string) =>
    new Request('https://waymark.test/api/ops', { method: 'POST', body });
  const read = async (response: Response) => ({
    status: response.status,
    body: await response.json(),
  });

  it('answers an operation 200 with its result, and a refusal 200 with not found', async () => {
    const made = await read(
      await opsResponse(post(JSON.stringify({ op: 'trip.create', name: 'Endpoint' })), ADA, deps),
    );
    expect(made.status).toBe(200);
    expect(made.body).toMatchObject({ ok: true, trip: { name: 'Endpoint', role: 'organizer' } });
    const refused = await read(
      await opsResponse(
        post(JSON.stringify({ op: 'trip.get', tripId: made.body.trip.id })),
        STRANGER,
        deps,
      ),
    );
    expect(refused).toEqual({ status: 200, body: { ok: false, reason: 'not_found' } });
  });

  it('says what is wrong with a value in a sentence that does not repeat it', async () => {
    const bad = await read(
      await opsResponse(
        post(JSON.stringify({ op: 'trip.create', name: 'Nope\nline', color: 'x' })),
        ADA,
        deps,
      ),
    );
    expect(bad.body).toMatchObject({ ok: false, reason: 'invalid' });
    expect(JSON.stringify(bad.body)).not.toContain('Nope');
  });

  it('refuses a request that is not an operation, one that is not JSON, and one that is too big', async () => {
    expect((await read(await opsResponse(post('{"op":"nope"}'), ADA, deps))).status).toBe(400);
    expect((await read(await opsResponse(post('not json'), ADA, deps))).status).toBe(400);
    const big = await opsResponse(
      post(JSON.stringify({ op: 'trip.create', name: 'x'.repeat(OPS_BODY_BYTES) })),
      ADA,
      deps,
    );
    expect(big.status).toBe(413);
  });

  it('counts requests for each account, and says when to try again', async () => {
    const limiter = new RateLimiter(database);
    const tight = { ...deps, limiter };
    let last = 200;
    for (let i = 0; i < 250; i += 1) {
      const response = await handleOp(
        JSON.stringify({ op: 'trip.list' }),
        'counted-account',
        tight,
      );
      last = response.status;
      if (last === 429) {
        expect(Number(response.headers.get('retry-after'))).toBeGreaterThan(0);
        break;
      }
    }
    expect(last).toBe(429);
    // Another account is not held by it.
    expect(
      (await handleOp(JSON.stringify({ op: 'trip.list' }), 'other-account', tight)).status,
    ).toBe(200);
  });
});
