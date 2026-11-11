import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { accountRoute } from '../access/route';
import { type TwoAccounts, twoAccounts } from '../access/two-accounts';
import { DEFAULT_LIMITS } from '../config';
import { ringOf } from '../crypto/keys';
import { Sealer } from '../crypto/sealed';
import type { Database } from '../db/client';
import { openAppBesideAuth, testTarget } from '../db/test-support';
import { RateLimiter } from '../limits/rate';
import { type OpsDeps, opsResponse } from './endpoint';

/**
 * `POST /api/ops` as a browser meets it (DESIGN.md §5.2, §15.7): the same wrapper the route is written with, on a real sign-in store and real sessions. A visitor is turned away, a request from another site is refused, and
 * **a second signed-in person who asks for the first's trip is told it is not there**, for every operation that names one, and nothing of it changes.
 */
const { leg } = testTarget();
const ring = ringOf(randomBytes(32));
if (!ring) throw new Error('no ring');
const sealer = new Sealer(ring);
let t: TwoAccounts;
let database: Database;
let close: () => Promise<void>;
let POST: (request: Request) => Promise<Response>;

beforeAll(async () => {
  t = await twoAccounts();
  ({ database, close } = await openAppBesideAuth());
  const deps: OpsDeps = {
    database,
    sealer,
    now: Date.now,
    limits: DEFAULT_LIMITS,
    limiter: new RateLimiter(database),
    media: {
      database,
      ring,
      dir: path.join(tmpdir(), 'waymark-route-media'),
      maxAccountBytes: 1 << 30,
      now: Date.now,
    },
  };
  POST = accountRoute(({ request, accountId }) => opsResponse(request, accountId, deps), t.deps);
});
afterAll(async () => {
  await t.close();
  await close();
});

const send = async (
  as: Parameters<TwoAccounts['request']>[0],
  body: unknown,
  headers?: Record<string, string>,
) => {
  const response = await POST(
    t.request(as, '/api/ops', { method: 'POST', body, ...(headers ? { headers } : {}) }),
  );
  const text = await response.text();
  return { status: response.status, body: text ? (JSON.parse(text) as Record<string, any>) : null }; // eslint-disable-line @typescript-eslint/no-explicit-any -- a test reads whatever shape the answer has
};

describe(`POST /api/ops (${leg})`, () => {
  it('turns a visitor away, and a request from another site', async () => {
    expect((await send(null, { op: 'trip.list' })).status).toBe(401);
    expect(
      (await send(t.ada, { op: 'trip.list' }, { origin: 'https://evil.example' })).status,
    ).toBe(403);
    expect((await send(t.ada, { op: 'trip.list' }, { origin: '' })).status).toBe(403);
  });

  it('makes a trip for the person the session names, and tells another person it is not there, for each operation that names one', async () => {
    const made = await send(t.ada, { op: 'trip.create', name: 'Ada’s trip' });
    expect(made).toMatchObject({
      status: 200,
      body: { ok: true, trip: { name: 'Ada’s trip', role: 'organizer', createdBy: t.ada.id } },
    });
    const tripId = made.body?.trip.id as string;
    for (const body of [
      { op: 'trip.get', tripId },
      { op: 'trip.update', tripId, name: 'Taken by Grace' },
      { op: 'trip.delete.preview', tripId },
      { op: 'trip.delete', tripId, confirm: true },
    ])
      expect(await send(t.grace, body), body.op).toEqual({
        status: 200,
        body: { ok: false, reason: 'not_found' },
      });
    // What Grace sees is her own trips only, and Ada's trip is as it was.
    expect((await send(t.grace, { op: 'trip.list' })).body).toEqual({ ok: true, trips: [] });
    expect((await send(t.ada, { op: 'trip.get', tripId })).body).toMatchObject({
      ok: true,
      trip: { name: 'Ada’s trip', seq: 1 },
    });
  });

  it('cannot be made to act for someone else: a request that names an account is not an operation', async () => {
    expect((await send(t.grace, { op: 'trip.list', accountId: t.ada.id })).status).toBe(400);
    expect(
      (await send(t.grace, { op: 'trip.create', name: 'X', createdBy: t.ada.id })).status,
    ).toBe(400);
  });
});
