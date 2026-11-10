import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../db/client';
import { makeStore, testTarget } from '../db/test-support';
import type { OutboundOptions, OutboundResponse } from '../security/outbound';
import { PUBLIC_URLS, type PlacesSettings } from './config';
import { type FakeSearch, startFakePlaces } from './fake';
import { PlaceFinder, cleanQuery } from './finder';

/**
 * Place search through the operator's provider (DESIGN.md §7.2), against a fake that reaches nothing. The operator's own address is reached for real, over loopback, through the
 * outbound helper; the public instance's policy (one request a second from the whole server, results kept a day) is tested with a sender that stands in for the network, since a test
 * never reaches the internet.
 */
const { leg } = testTarget();
let database: Database;
let close: () => Promise<void>;
let fake: FakeSearch;
beforeAll(async () => {
  ({ database, close } = await makeStore());
  fake = await startFakePlaces();
});
afterAll(async () => {
  await fake.close();
  await close();
});
beforeEach(() => {
  fake.requests.length = 0;
  fake.failWith(undefined);
  fake.delay(0);
});

const own = (provider: 'nominatim' | 'photon' = 'nominatim'): PlacesSettings => {
  const url = new URL(fake.url());
  return {
    provider,
    url: fake.url(),
    public: false,
    allow: [{ host: url.hostname, allowPrivate: true, allowHttp: true }],
  };
};
const publicSettings = (provider: 'nominatim' | 'photon' = 'nominatim'): PlacesSettings => ({
  provider,
  url: PUBLIC_URLS[provider],
  public: true,
  allow: [{ host: new URL(PUBLIC_URLS[provider]).hostname }],
});
const finder = (
  settings: PlacesSettings,
  extra: Partial<ConstructorParameters<typeof PlaceFinder>[0]> = {},
) =>
  new PlaceFinder({
    settings,
    database,
    userAgent: 'Waymark (https://waymark.example.com)',
    ...extra,
  });

/** A sender that answers from the fake's data and says when it was asked, as the network would be asked. */
function standIn() {
  const asked: { address: string; at: number; headers: Record<string, string> | undefined }[] = [];
  const send = async (address: string, options: OutboundOptions): Promise<OutboundResponse> => {
    asked.push({ address, at: Date.now(), headers: options.headers });
    const path = address.replace(PUBLIC_URLS.nominatim, '').replace(PUBLIC_URLS.photon, '');
    const response = await fetch(`${fake.url()}${path}`);
    return { status: response.status, headers: {}, body: Buffer.from(await response.text()) };
  };
  return { asked, send };
}

describe(`finding a place, with a provider of the operator’s own (${leg})`, () => {
  it('searches Nominatim and reads the answer as candidates, in the provider’s order', async () => {
    const result = await finder(own()).search('cafe');
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.candidates.map((c) => c.name)).toEqual(['Café de Flore', 'Café Central']);
    expect(result.candidates[0]).toMatchObject({
      source: 'osm',
      sourceId: 'node/100002',
      category: 'Cafe',
      address: { city: 'Paris', countryCode: 'FR' },
    });
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]?.path).toContain('/search?q=cafe');
  });

  it('searches Photon and finds the same place by the same id', async () => {
    const [viaNominatim, viaPhoton] = await Promise.all([
      finder(own()).search('tokyo'),
      finder(own('photon')).search('tokyo'),
    ]);
    expect(viaNominatim.status === 'ok' && viaPhoton.status === 'ok').toBe(true);
    if (viaNominatim.status === 'ok' && viaPhoton.status === 'ok')
      expect(viaPhoton.candidates).toEqual(viaNominatim.candidates);
    expect(fake.requests.some((r) => r.path.startsWith('/api/?q=tokyo'))).toBe(true);
  });

  it('looks up what is at a point, and says there is nothing where there is nothing', async () => {
    const at = await finder(own()).reverse(48.8541, 2.3327);
    expect(at).toMatchObject({ status: 'ok', candidate: { name: 'Café de Flore' } });
    expect(await finder(own()).reverse(0, 0)).toEqual({ status: 'ok', candidate: undefined });
    expect(await finder(own('photon')).reverse(35.6587, 139.7455)).toMatchObject({
      status: 'ok',
      candidate: { name: 'Tokyo Tower' },
    });
    expect(await finder(own()).reverse(91, 0)).toEqual({ status: 'unavailable' });
  });

  it('sends nothing for a search of fewer than three characters, and trims what was typed', async () => {
    expect(await finder(own()).search('  ab ')).toEqual({ status: 'too_short' });
    expect(await finder(own()).search('')).toEqual({ status: 'too_short' });
    expect(fake.requests).toHaveLength(0);
    expect(cleanQuery('  café \n  de   flore ')).toBe('café de flore');
    expect(cleanQuery('x'.repeat(500))).toHaveLength(200);
    const result = await finder(own()).search('  tokyo   tower ');
    expect(result.status).toBe('ok');
    expect(fake.requests[0]?.path).toContain('q=tokyo%20tower');
  });

  it('does not keep or space what it asks: an address of the operator’s own lifts the policy', async () => {
    const f = finder(own());
    const started = Date.now();
    await Promise.all([
      f.search('tokyo'),
      f.search('tokyo'),
      f.search('lisbon'),
      f.search('tokyo'),
    ]);
    expect(fake.requests).toHaveLength(4);
    expect(Date.now() - started).toBeLessThan(900);
  });

  it('says plainly that the search is not reachable when the provider is down, answers badly, or is not on the list', async () => {
    fake.failWith(503);
    expect(await finder(own()).search('tokyo')).toEqual({ status: 'unavailable' });
    expect(await finder(own()).reverse(1, 1)).toEqual({ status: 'unavailable' });
    fake.failWith(200); // a page of HTML is not an answer
    expect(await finder(own()).search('tokyo')).toEqual({ status: 'unavailable' });
    fake.failWith(undefined);
    const elsewhere = { ...own(), allow: [{ host: 'somewhere-else.example.com' }] };
    expect(await finder(elsewhere).search('tokyo')).toEqual({ status: 'unavailable' });
    expect(fake.requests.length).toBe(3);
    // And nothing was kept of a failure: the next ask goes out and works.
    expect((await finder(own()).search('tokyo')).status).toBe('ok');
  });

  it('is off with `off`, and sends nothing', async () => {
    const off = finder({ provider: 'off', url: undefined, public: false, allow: [] });
    expect(off.on).toBe(false);
    expect(await off.search('tokyo')).toEqual({ status: 'off' });
    expect(await off.reverse(1, 1)).toEqual({ status: 'off' });
    expect(fake.requests).toHaveLength(0);
  });

  it('never reaches a private address that the operator did not name, whatever the provider says', async () => {
    const notOurs = { ...own(), allow: [{ host: new URL(fake.url()).hostname }] };
    expect(await finder(notOurs).search('tokyo')).toEqual({ status: 'unavailable' });
    expect(fake.requests).toHaveLength(0);
  });
});

describe(`the public instance’s policy (${leg})`, () => {
  it('names Waymark and the instance in its User-Agent, and no one else', async () => {
    const { asked, send } = standIn();
    await finder(publicSettings(), { send, intervalMs: 20 }).search('tokyo');
    expect(asked).toHaveLength(1);
    expect(asked[0]?.headers?.['user-agent']).toBe('Waymark (https://waymark.example.com)');
    expect(asked[0]?.address.startsWith(PUBLIC_URLS.nominatim)).toBe(true);
  });

  it('keeps what it found for a day: asking again sends nothing, until the day is over', async () => {
    const { asked, send } = standIn();
    let now = 1_800_000_000_000;
    const f = finder(publicSettings(), { send, intervalMs: 20, now: () => now });
    const first = await f.search('Tokyo   Tower');
    const second = await f.search('tokyo tower');
    expect(second).toEqual(first);
    expect(asked).toHaveLength(1);
    await f.reverse(48.854, 2.3326);
    await f.reverse(48.854, 2.3326);
    expect(asked).toHaveLength(2);
    now += 23 * 60 * 60 * 1000;
    await f.search('tokyo tower');
    expect(asked).toHaveLength(2);
    now += 2 * 60 * 60 * 1000;
    await f.search('tokyo tower');
    expect(asked).toHaveLength(3);
  });

  it('keeps nothing of a failure, so the next ask is sent', async () => {
    const { asked, send } = standIn();
    const f = finder(publicSettings(), { send, intervalMs: 20 });
    fake.failWith(500);
    expect(await f.search('tokyo')).toEqual({ status: 'unavailable' });
    fake.failWith(undefined);
    expect((await f.search('tokyo')).status).toBe('ok');
    expect(asked).toHaveLength(2);
  });

  it('sends one request for the same thing asked at once', async () => {
    const { asked, send } = standIn();
    fake.delay(80);
    const f = finder(publicSettings(), { send, intervalMs: 20 });
    const results = await Promise.all([f.search('tokyo'), f.search('tokyo'), f.search('Tokyo')]);
    expect(asked).toHaveLength(1);
    expect(results[0]).toEqual(results[2]);
  });

  it('is at most one request a second from the whole server, however many processes there are', async () => {
    // Two finders stand for two processes sharing one database; each has its own cache and its own idea of the time, and the lease is in the database.
    const { asked, send } = standIn();
    const a = finder(publicSettings(), { send, waitMs: 20_000 });
    const b = finder(publicSettings(), { send, waitMs: 20_000 });
    const started = Date.now();
    await Promise.all([
      a.search('tokyo'),
      b.search('lisbon'),
      a.search('central'),
      b.search('cafe'),
    ]);
    expect(asked).toHaveLength(4);
    const times = asked.map((each) => each.at).sort((x, y) => x - y);
    for (let i = 1; i < times.length; i++)
      expect((times[i] ?? 0) - (times[i - 1] ?? 0)).toBeGreaterThanOrEqual(950);
    expect(Date.now() - started).toBeGreaterThanOrEqual(2_900);
  }, 30_000);

  it('says the search is busy when it cannot have a turn in the time it waits, and sends nothing', async () => {
    const { asked, send } = standIn();
    const a = finder(publicSettings(), { send, intervalMs: 60_000 });
    expect((await a.search('tokyo')).status).toBe('ok');
    const b = finder(publicSettings(), { send, intervalMs: 60_000, waitMs: 250 });
    expect(await b.search('lisbon')).toEqual({ status: 'unavailable' });
    expect(asked).toHaveLength(1);
  });
});
