import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { accountRoute } from '../access/route';
import { type TwoAccounts, twoAccounts } from '../access/two-accounts';
import { ringOf } from '../crypto/keys';
import { Sealer } from '../crypto/sealed';
import type { Database } from '../db/client';
import { openAppBesideAuth, testTarget } from '../db/test-support';
import { type FakeSearch, startFakePlaces } from './fake';
import { PlaceFinder } from './finder';
import { type FindDeps, findPlaces } from './http';
import { makePlace } from './places';

/** `/api/places`, called as the person and as someone else, over real sessions (DESIGN.md §5.2, §7.2): their own places first, then the provider's. */
const { leg } = testTarget();
const ring = ringOf(randomBytes(32));
if (!ring) throw new Error('no ring');
const sealer = new Sealer(ring);

let t: TwoAccounts;
let database: Database;
let close: () => Promise<void>;
let fake: FakeSearch;
let deps: FindDeps;
let off: FindDeps;
beforeAll(async () => {
  t = await twoAccounts();
  ({ database, close } = await openAppBesideAuth());
  fake = await startFakePlaces();
  const url = new URL(fake.url());
  const finder = new PlaceFinder({
    settings: {
      provider: 'nominatim',
      url: fake.url(),
      public: false,
      allow: [{ host: url.hostname, allowPrivate: true, allowHttp: true }],
    },
    database,
    userAgent: 'Waymark',
  });
  deps = { database, sealer, finder };
  off = {
    ...deps,
    finder: new PlaceFinder({
      settings: { provider: 'off', url: undefined, public: false, allow: [] },
      database,
      userAgent: 'Waymark',
    }),
  };
  const place = (accountId: string, name: string, lat: number, lng: number, extra = {}) =>
    makePlace({ database, sealer, now: () => 1_800_000_000_000 }, accountId, {
      name,
      lat,
      lng,
      ...extra,
    });
  await place(t.ada.id, 'Café de Flore', 48.854, 2.3326, {
    source: 'osm',
    sourceId: 'node/100002',
  });
  await place(t.ada.id, 'Café Ada Secret', 48.86, 2.34);
  await place(t.grace.id, 'Café Grace Secret', 51.5, -0.12);
});
afterAll(async () => {
  await fake.close();
  await t.close();
  await close();
});

const route = (use: () => FindDeps) =>
  accountRoute(
    ({ request, accountId }) =>
      findPlaces(use(), accountId, new URL(request.url).searchParams).then((answer) =>
        Response.json(answer.body, { status: answer.status }),
      ),
    { origin: () => t.deps.origin(), accountOf: (headers) => t.deps.accountOf(headers) },
  );
const find = route(() => deps);
const findWithoutProvider = route(() => off);
const get = (who: typeof t.ada | null, query: string, use = find) =>
  use(t.request(who, `/api/places?${query}`));

describe(`/api/places (${leg})`, () => {
  it('is for someone signed in', async () => {
    expect((await get(null, 'q=cafe')).status).toBe(401);
    expect(fake.requests).toHaveLength(0);
  });

  it('answers the person’s own places first, then the provider’s without what the person already has', async () => {
    const body = await (await get(t.ada, 'q=cafe')).json();
    expect(body.status).toBe('ok');
    expect(body.provider).toBe('on');
    expect(body.mine.map((p: { name: string }) => p.name)).toEqual([
      'Café Ada Secret',
      'Café de Flore',
    ]);
    // Café de Flore is the person's, so the provider's copy is not offered again; Café Central is new to them.
    expect(body.found.map((c: { name: string }) => c.name)).toEqual(['Café Central']);
    expect(body.found[0]).toMatchObject({ source: 'osm', sourceId: 'node/100003' });
  });

  it('orders the person’s own places by distance when a point is given, and does not send the point to the provider', async () => {
    const body = await (await get(t.ada, 'q=cafe&lat=48.8602&lng=2.3402')).json();
    expect(body.mine.map((p: { name: string }) => p.name)).toEqual([
      'Café Ada Secret',
      'Café de Flore',
    ]);
    expect(body.mine[0].distance).toBeLessThan(50);
    const asked = fake.requests.at(-1)?.path ?? '';
    expect(asked).not.toContain('48.86');
    expect(asked).not.toContain('2.34');
  });

  it('never shows one person another’s places: not in what is searched, and not in what is found', async () => {
    const graces = await (await get(t.grace, 'q=cafe')).json();
    expect(graces.mine.map((p: { name: string }) => p.name)).toEqual(['Café Grace Secret']);
    expect(JSON.stringify(graces)).not.toContain('Ada Secret');
    // The provider's Café de Flore is offered to Grace, since it is not hers.
    expect(graces.found.map((c: { name: string }) => c.name)).toContain('Café de Flore');
    expect(JSON.stringify(await (await get(t.ada, 'q=grace')).json())).not.toContain('Grace');
  });

  it('answers what is at a point, and the person’s place that is the same, if they have one', async () => {
    const ada = await (await get(t.ada, 'lat=48.8541&lng=2.3327')).json();
    expect(ada).toMatchObject({
      status: 'ok',
      found: { name: 'Café de Flore', sourceId: 'node/100002' },
      existing: { name: 'Café de Flore' },
    });
    const grace = await (await get(t.grace, 'lat=48.8541&lng=2.3327')).json();
    expect(grace.existing).toBeNull();
    expect(grace.found.name).toBe('Café de Flore');
    const nothing = await (await get(t.ada, 'lat=0&lng=0')).json();
    expect(nothing).toMatchObject({ status: 'ok', found: null, existing: null });
  });

  it('says the search is off, or not reachable, and still answers the person’s own places', async () => {
    const none = await (await get(t.ada, 'q=cafe', findWithoutProvider)).json();
    expect(none).toMatchObject({ provider: 'off', status: 'off', found: [] });
    expect(none.mine).toHaveLength(2);
    fake.failWith(502);
    const down = await (await get(t.ada, 'q=tokyo')).json();
    expect(down).toMatchObject({ provider: 'on', status: 'unavailable', found: [], mine: [] });
    const tooShort = await (await get(t.ada, 'q=ca')).json();
    expect(tooShort).toMatchObject({ status: 'too_short', found: [] });
    expect(tooShort.mine).toHaveLength(2);
    fake.failWith(undefined);
  });

  it('refuses what is not a search or a point, and sends nothing for it', async () => {
    const before = fake.requests.length;
    for (const query of [
      '',
      'q=',
      'q=%20',
      'lat=1',
      'lng=1',
      'lat=91&lng=0',
      'lat=x&lng=1',
      'q=cafe&lat=1',
      'lat=0&lng=181',
    ])
      expect((await get(t.ada, query)).status, query).toBe(400);
    expect(fake.requests.length).toBe(before);
  });
});
