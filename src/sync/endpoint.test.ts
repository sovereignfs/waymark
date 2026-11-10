import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { accountRoute } from '../access/route';
import { type TwoAccounts, twoAccounts } from '../access/two-accounts';
import { ringOf } from '../crypto/keys';
import { Sealer } from '../crypto/sealed';
import type { Database } from '../db/client';
import { openAppBesideAuth, testTarget } from '../db/test-support';
import type { ApplyDeps } from './apply';
import { MAX_OUTBOX, type SyncResponse, handleSync } from './endpoint';
import { PROTOCOL_VERSION } from './format';

/**
 * The sync endpoint (DESIGN.md §15.3): called as the person and as someone else, over real sessions, and its answers read the way a device reads them. The data layer under it is 5.2's.
 */
const { leg } = testTarget();
const ring = ringOf(randomBytes(32));
if (!ring) throw new Error('no ring');
const sealer = new Sealer(ring);
const NOW = 1_800_000_000_000;

let t: TwoAccounts;
let database: Database;
let close: () => Promise<void>;
let deps: ApplyDeps;
beforeAll(async () => {
  t = await twoAccounts();
  ({ database, close } = await openAppBesideAuth());
  deps = { database, sealer, now: () => NOW };
});
afterAll(async () => {
  await t.close();
  await close();
});

let n = 0;
const uid = (what: string) => `${what}-${++n}`;
const PLACE = {
  name: 'Café de Flore',
  lat: 48.854,
  lng: 2.3326,
  source: 'osm',
  tz: 'Europe/Paris',
  countryCode: null,
};
const checkinRow = (placeId: string, over: Record<string, unknown> = {}) => ({
  placeId,
  at: NOW - 60_000,
  tz: 'Europe/Paris',
  offsetMin: 120,
  companions: [],
  tripId: null,
  linkSource: null,
  share: 'trip',
  source: 'live',
  ...over,
});
const mutation = (changes: unknown[], mutationId = uid('m')) => ({
  mutationId,
  stream: 'account',
  changes,
});
const putPlace = (id: string, row: Record<string, unknown> = {}) => ({
  table: 'place',
  op: 'put',
  id,
  row: { ...PLACE, ...row },
});
const putCheckin = (id: string, placeId: string, row: Record<string, unknown> = {}) => ({
  table: 'checkin',
  op: 'put',
  id,
  row: checkinRow(placeId, row),
});
const request = (over: Record<string, unknown> = {}) => ({
  protocol: PROTOCOL_VERSION,
  outbox: [],
  cursor: 0,
  ...over,
});
const sync = async (accountId: string, body: unknown): Promise<SyncResponse> => {
  const answer = await handleSync(deps, accountId, body);
  if (answer.status !== 200) throw new Error(`answered ${answer.status}`);
  return answer.body;
};

describe(`the sync endpoint (${leg})`, () => {
  it('answers a device with an empty outbox and no cursor with everything the account has, as a snapshot', async () => {
    const who = uid('snapshot');
    const place = uid('place');
    await sync(
      who,
      request({
        outbox: [
          mutation([
            putPlace(place),
            putCheckin(uid('c'), place, { note: 'first', companions: ['Ada'] }),
          ]),
        ],
      }),
    );
    const fresh = await sync(who, request());
    expect(fresh.results).toEqual([]);
    expect(fresh.account.places).toHaveLength(1);
    expect(fresh.account.places[0]).toMatchObject({
      id: place,
      name: 'Café de Flore',
      lat: 48.854,
      tz: 'Europe/Paris',
      version: 1,
      seq: 1,
    });
    expect(fresh.account.checkins[0]).toMatchObject({
      placeId: place,
      note: 'first',
      companions: ['Ada'],
      version: 1,
      seq: 2,
      share: 'trip',
      source: 'live',
    });
    expect(fresh.account).toMatchObject({ cursor: 2, more: false, head: 2, deleted: [] });
  });

  it('applies the outbox in order, says what happened to each, and gives the device its changes back with the server’s numbers', async () => {
    const who = uid('outbox');
    const place = uid('place');
    const first = mutation([putPlace(place)]);
    const second = mutation([putCheckin(uid('c'), place)]);
    const bad = mutation([putCheckin(uid('c'), 'no-such-place')]);
    const response = await sync(who, request({ outbox: [first, second, bad] }));
    expect(response.results).toEqual([
      { mutationId: first.mutationId, status: 'applied', seq: 1 },
      { mutationId: second.mutationId, status: 'applied', seq: 2 },
      {
        mutationId: bad.mutationId,
        status: 'refused',
        reason: 'place_missing',
        sentence: 'A check-in needs a place.',
      },
    ]);
    // A refusal does not stop what follows it.
    const last = mutation([putCheckin(uid('c'), place, { note: 'after the refusal' })]);
    const next = await sync(who, request({ outbox: [bad, last], cursor: response.account.cursor }));
    expect(next.results.map((r) => r.status)).toEqual(['refused', 'applied']);
    expect(next.account.checkins.map((c) => c.note)).toEqual(['after the refusal']);
  });

  it('applies nothing twice when a lost answer is retried, and still gives the answer', async () => {
    const who = uid('retry');
    const place = uid('place');
    const m = mutation([putPlace(place), putCheckin(uid('c'), place)]);
    const first = await sync(who, request({ outbox: [m] }));
    expect(first.results).toEqual([{ mutationId: m.mutationId, status: 'applied', seq: 2 }]);
    // The answer was lost: the device sends the same outbox, still with the cursor it had.
    const again = await sync(who, request({ outbox: [m] }));
    expect(again.results).toEqual([{ mutationId: m.mutationId, status: 'replay' }]);
    expect(again.account.places).toHaveLength(1);
    expect(again.account.checkins).toHaveLength(1);
    expect(again.account.head).toBe(2);
  });

  it('returns what changed since a cursor, in order, and a deleted row as a tombstone with no content', async () => {
    const who = uid('since');
    const place = uid('place');
    const checkin = uid('checkin');
    const made = await sync(
      who,
      request({
        outbox: [mutation([putPlace(place), putCheckin(checkin, place, { note: 'secret note' })])],
      }),
    );
    const seen = made.account.cursor;
    await sync(
      who,
      request({
        outbox: [
          mutation([putCheckin(checkin, place, { note: 'edited' })]),
          mutation([putPlace(uid('other'), { name: 'Elsewhere' })]),
        ],
      }),
    );
    await sync(
      who,
      request({ outbox: [mutation([{ table: 'checkin', op: 'delete', id: checkin }])] }),
    );
    const stale = await sync(who, request({ cursor: seen }));
    // The edit of the check-in was replaced by its delete: what is past the cursor is the new place, and the tombstone.
    expect(stale.account.places.map((p) => p.name)).toEqual(['Elsewhere']);
    expect(stale.account.checkins).toEqual([]);
    expect(stale.account.deleted).toEqual([
      { table: 'checkin', id: checkin, seq: expect.any(Number) },
    ]);
    expect(JSON.stringify(stale.account.deleted)).not.toContain('secret');
    const seqs = [
      ...stale.account.places.map((p) => p.seq),
      ...stale.account.deleted.map((d) => d.seq),
    ];
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(await sync(who, request({ cursor: stale.account.cursor }))).toMatchObject({
      account: { places: [], checkins: [], deleted: [], more: false },
    });
  });

  it('pages a snapshot at the stream’s numbers, so that the pages together are everything, once, in order', async () => {
    const who = uid('pages');
    const place = uid('place');
    await sync(who, request({ outbox: [mutation([putPlace(place)])] }));
    for (let i = 0; i < 4; i++)
      await sync(
        who,
        request({
          outbox: [
            mutation([
              putCheckin(uid('c'), place, { note: `n${i}` }),
              putPlace(uid('p'), { name: `P${i}` }),
            ]),
          ],
        }),
      );
    const all: number[] = [];
    let cursor = 0;
    let pages = 0;
    for (;;) {
      const page = (await sync(who, request({ cursor, limit: 3 }))).account;
      all.push(
        ...[
          ...page.places.map((p) => p.seq),
          ...page.checkins.map((c) => c.seq),
          ...page.deleted.map((d) => d.seq),
        ],
      );
      pages++;
      expect(page.places.length + page.checkins.length + page.deleted.length).toBeLessThanOrEqual(
        3,
      );
      cursor = page.cursor;
      if (!page.more) break;
    }
    expect(pages).toBeGreaterThan(2);
    expect(all.sort((a, b) => a - b)).toEqual(Array.from({ length: 9 }, (_, i) => i + 1));
    expect(new Set(all).size).toBe(all.length);
  });

  it('gives each check-in its photos, in order, and none to a check-in that has none', async () => {
    const who = uid('photos');
    const place = uid('place');
    const [a, b] = ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'];
    await sync(
      who,
      request({
        outbox: [
          mutation([
            putPlace(place),
            putCheckin('with-photos', place, { photos: [b, a] }),
            putCheckin('without', place),
          ]),
        ],
      }),
    );
    const got = (await sync(who, request())).account.checkins;
    expect(got.find((c) => c.id === 'with-photos')?.photos).toEqual([b, a]);
    expect(got.find((c) => c.id === 'without')).not.toHaveProperty('photos');
  });

  it('never shows one person another’s rows, as a snapshot, since a cursor or among what was refused', async () => {
    const ada = uid('ada');
    const grace = uid('grace');
    const place = uid('place');
    await sync(
      ada,
      request({
        outbox: [
          mutation([putPlace(place), putCheckin('adas-checkin', place, { note: 'ada only' })]),
        ],
      }),
    );
    await sync(
      grace,
      request({ outbox: [mutation([putPlace(uid('gp'), { name: 'Grace place' })])] }),
    );
    const graces = await sync(grace, request());
    expect(JSON.stringify(graces)).not.toContain('ada only');
    expect(graces.account.checkins).toEqual([]);
    expect(graces.account.places.map((p) => p.name)).toEqual(['Grace place']);
    // Grace tries ada's rows: refused, and still she sees none of them.
    const tried = await sync(
      grace,
      request({ outbox: [mutation([putCheckin('adas-checkin', place, { note: 'mine now' })])] }),
    );
    expect(tried.results[0]).toMatchObject({ status: 'refused' });
    expect(JSON.stringify(tried)).not.toContain('ada only');
    expect((await sync(ada, request())).account.checkins[0]).toMatchObject({
      note: 'ada only',
      version: 1,
    });
  });

  it('is refused in words when it is not a request: a protocol it does not speak, too much, or something else', async () => {
    const who = uid('bad');
    expect(
      await handleSync(
        deps,
        who,
        request({ protocol: 0, outbox: [mutation([putPlace(uid('p'))])] }),
      ),
    ).toEqual({ status: 426, body: { code: 'UPDATE_REQUIRED', protocol: PROTOCOL_VERSION } });
    expect(await handleSync(deps, who, { outbox: [] })).toMatchObject({ status: 426 });
    expect(
      await handleSync(
        deps,
        who,
        request({
          outbox: Array.from({ length: MAX_OUTBOX + 1 }, () => mutation([putPlace(uid('p'))])),
        }),
      ),
    ).toEqual({ status: 413, body: { code: 'TOO_MANY' } });
    for (const body of [
      null,
      'x',
      [],
      request({ outbox: 'no' }),
      request({ cursor: -1 }),
      request({ cursor: 1.5 }),
      request({ cursor: '3' }),
      request({ limit: 0 }),
      request({ limit: 501 }),
    ])
      expect(await handleSync(deps, who, body), JSON.stringify(body)).toEqual({
        status: 400,
        body: { code: 'BAD_REQUEST' },
      });
  });

  it('keeps the outbox when the protocol is old: nothing was applied', async () => {
    const who = uid('old');
    const place = uid('place');
    await handleSync(deps, who, request({ protocol: 0, outbox: [mutation([putPlace(place)])] }));
    expect((await sync(who, request())).account.places).toEqual([]);
  });
});

describe(`/api/sync as a route (${leg})`, () => {
  const route = () =>
    accountRoute(
      async ({ request: req, accountId }) => {
        const answer = await handleSync(deps, accountId, await req.json());
        return Response.json(answer.body, { status: answer.status });
      },
      { origin: () => t.deps.origin(), accountOf: (headers) => t.deps.accountOf(headers) },
    );
  const post = (who: typeof t.ada | null, body: unknown, headers = {}) =>
    route()(t.request(who, '/api/sync', { method: 'POST', body, headers }));

  it('is for someone signed in and from the app', async () => {
    expect((await post(null, request())).status).toBe(401);
    expect((await post(t.ada, request(), { origin: 'https://evil.example' })).status).toBe(403);
    expect((await post(t.ada, request(), { origin: '' })).status).toBe(403);
    expect((await post(t.ada, request())).status).toBe(200);
  });

  it('takes the account from the session: two people syncing the same ids each have their own', async () => {
    const place = uid('place');
    const m = (note: string) =>
      mutation([putPlace(place), putCheckin('shared-id', place, { note })]);
    const ada = await (await post(t.ada, request({ outbox: [m('ada’s')] }))).json();
    const grace = await (await post(t.grace, request({ outbox: [m('grace’s')] }))).json();
    // The same ids are another person's rows, which the second cannot make; she is told so, and gets none of ada's.
    expect(ada.results[0].status).toBe('applied');
    expect(grace.results[0]).toMatchObject({ status: 'refused' });
    expect(JSON.stringify(grace)).not.toContain('ada’s');
    const again = await (await post(t.ada, request())).json();
    expect(again.account.checkins[0].note).toBe('ada’s');
  });
});
