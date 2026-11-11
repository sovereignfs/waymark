import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { tableOf } from '../access/trip';
import { DEFAULT_LIMITS } from '../config';
import { ringOf } from '../crypto/keys';
import { Sealer } from '../crypto/sealed';
import type { Database } from '../db/client';
import { dbAll, dbGet } from '../db/exec';
import { makeStore, testTarget } from '../db/test-support';
import { MAX_LINKS } from './link-format';
import { LinkRefused, addLink, listLinks, moveLink, removeLink, updateLink } from './links';
import { createTrip, deleteTrip } from './trips';

/**
 * A trip's links (DESIGN.md §10.7), against whichever database the leg runs on: an https address and a title, up to ten, read by every member and edited by Organizers and Travelers, sealed, and **never fetched**.
 */
const { leg } = testTarget();
const ring = ringOf(randomBytes(32));
if (!ring) throw new Error('no ring');
const sealer = new Sealer(ring);
const [ADA, SAM, NOOR, STRANGER, GONE] = [
  'ada-acct',
  'sam-acct',
  'noor-acct',
  'stranger-acct',
  'gone-acct',
];
let NOW = 1_800_000_000_000;
let database: Database;
let close: () => Promise<void>;
let deps: Parameters<typeof createTrip>[0];
let tripId: string;
let otherTrip: string;

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
const titles = async (who = ADA) => (await listLinks(deps, who, tripId))?.map((link) => link.title);
const refusal = async (promise: Promise<unknown>): Promise<LinkRefused> => {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(LinkRefused);
  return error as LinkRefused;
};

beforeAll(async () => {
  ({ database, close } = await makeStore());
  deps = { database, sealer, now: () => ++NOW, limits: DEFAULT_LIMITS };
});
afterAll(async () => close());
afterEach(() => vi.unstubAllGlobals());
beforeEach(async () => {
  for (const table of ['trip_link', 'trip_member', 'trip'])
    await dbAll(database, sql`DELETE FROM ${t(table)} RETURNING 1 AS gone`);
  tripId = (await createTrip(deps, ADA, { name: 'Iberia' })).id;
  otherTrip = (await createTrip(deps, ADA, { name: 'Other' })).id;
  for (const [id, role, left] of [
    [SAM, 'traveler', false],
    [NOOR, 'follower', false],
    [GONE, 'traveler', true],
  ] as const)
    await dbAll(
      database,
      sql`INSERT INTO ${t('trip_member')} (trip_id, account_id, role, going, share_checkins, joined_at, left_at, seq) VALUES (${tripId}, ${id}, ${role}, ${role !== 'follower'}, 'ask', ${NOW}, ${left ? NOW : null}, 2) RETURNING trip_id`,
    );
});

describe(`a trip's links (${leg})`, () => {
  it('are added at the end or before another, with a kind, a title and an https address, and Tally’s is called what it is', async () => {
    await addLink(deps, ADA, tripId, { title: 'Hotel', url: 'https://hotel.example/booking/42' });
    await addLink(deps, SAM, tripId, { kind: 'tally', url: 'https://tally.example.org/g/abc' });
    const links = await addLink(deps, ADA, tripId, {
      title: 'Map',
      url: 'HTTPS://Maps.Example/My%20Trip',
      before: (await listLinks(deps, ADA, tripId))?.[0]?.id ?? null,
    });
    expect(links?.map((link) => [link.title, link.kind, link.url])).toEqual([
      ['Map', 'other', 'https://maps.example/My%20Trip'],
      ['Hotel', 'other', 'https://hotel.example/booking/42'],
      ['Expenses in Tally', 'tally', 'https://tally.example.org/g/abc'],
    ]);
  });

  it('seals the title and the address: the database holds neither', async () => {
    await addLink(deps, ADA, tripId, {
      title: 'Our secret itinerary',
      url: 'https://docs.example/d/TOKEN-1234567890',
    });
    const rows = await dbAll<{ sealed: Uint8Array }>(
      database,
      sql`SELECT sealed FROM ${t('trip_link')}`,
    );
    const text = Buffer.from(rows[0]?.sealed ?? []).toString('latin1');
    for (const secret of ['secret', 'TOKEN', 'docs.example']) expect(text).not.toContain(secret);
  });

  it('refuses an address that is not https, whatever it is dressed as, and a title or kind that is not one, and keeps nothing', async () => {
    for (const bad of [
      { title: 'x', url: 'http://example.org/' },
      { title: 'x', url: 'javascript:alert(1)' },
      { title: 'x', url: 'data:text/html,<b>' },
      { title: 'x', url: 'file:///etc/passwd' },
      { title: 'x', url: 'https://user:pw@example.org/' },
      { title: 'x', url: 'example.org' },
      { title: 'x' },
      { url: 'https://example.org/' },
      { title: 'x', url: 'https://example.org/', kind: 'splitwise' },
      { title: 'a\nb', url: 'https://example.org/' },
    ])
      expect(
        (await refusal(addLink(deps, ADA, tripId, bad as never))).reason,
        JSON.stringify(bad),
      ).toBe('invalid');
    expect(await count('trip_link')).toBe(0);
  });

  it('are at most ten, and past ten a sentence says so, and nothing is made', async () => {
    for (let i = 0; i < MAX_LINKS; i += 1)
      await addLink(deps, ADA, tripId, { title: `L${i}`, url: `https://example.org/${i}` });
    const refused = await refusal(
      addLink(deps, SAM, tripId, { title: 'Eleven', url: 'https://example.org/11' }),
    );
    expect(refused).toMatchObject({ reason: 'limit' });
    expect(refused.sentence).toContain('at most 10');
    expect(await count('trip_link', sql`WHERE trip_id = ${tripId}`)).toBe(10);
    // Another trip is not held by it, and removing one makes room.
    await addLink(deps, ADA, otherTrip, { title: 'Elsewhere', url: 'https://example.org/e' });
    await removeLink(deps, ADA, tripId, (await listLinks(deps, ADA, tripId))?.[0]?.id ?? '');
    await addLink(deps, ADA, tripId, { title: 'Eleven', url: 'https://example.org/11' });
  });

  it('are read by every member, a Follower too, and by nobody else', async () => {
    await addLink(deps, ADA, tripId, { title: 'Hotel', url: 'https://hotel.example/' });
    for (const who of [ADA, SAM, NOOR]) expect(await titles(who), who).toEqual(['Hotel']);
    for (const who of [GONE, STRANGER])
      expect(await listLinks(deps, who, tripId), who).toBeUndefined();
    expect(await listLinks(deps, ADA, 'not-an-id')).toBeUndefined();
    expect(await listLinks(deps, ADA, randomUUID())).toBeUndefined();
  });

  it('are changed by an Organizer or a Traveler, and a Follower, a former member and a stranger are told the trip is not there', async () => {
    const first = (
      await addLink(deps, ADA, tripId, { title: 'Original', url: 'https://example.org/o' })
    )?.[0];
    expect(
      await addLink(deps, SAM, tripId, { title: 'By a Traveler', url: 'https://example.org/s' }),
    ).toBeDefined();
    for (const who of [NOOR, GONE, STRANGER]) {
      expect(
        await addLink(deps, who, tripId, { title: 'No', url: 'https://example.org/n' }),
        who,
      ).toBeUndefined();
      expect(
        await updateLink(deps, who, tripId, first?.id ?? '', { title: 'Taken' }),
        who,
      ).toBeUndefined();
      expect(await moveLink(deps, who, tripId, first?.id ?? '', null), who).toBeUndefined();
      expect(await removeLink(deps, who, tripId, first?.id ?? ''), who).toBeUndefined();
    }
    expect(await titles()).toEqual(['Original', 'By a Traveler']);
  });

  it('are edited as a whole: the fields given change, an address that is not https is refused and the link stays as it was', async () => {
    const link = (
      await addLink(deps, ADA, tripId, { title: 'Original', url: 'https://example.org/o' })
    )?.[0];
    const seq = Number(
      (
        await dbGet<{ seq: number | string }>(
          database,
          sql`SELECT seq FROM ${t('trip')} WHERE id = ${tripId}`,
        )
      )?.seq,
    );
    const updated = (
      await updateLink(deps, SAM, tripId, link?.id ?? '', { title: 'Renamed' })
    )?.[0];
    expect(updated).toMatchObject({
      title: 'Renamed',
      url: 'https://example.org/o',
      kind: 'other',
    });
    expect(
      Number(
        (
          await dbGet<{ seq: number | string }>(
            database,
            sql`SELECT seq FROM ${t('trip')} WHERE id = ${tripId}`,
          )
        )?.seq,
      ),
    ).toBe(seq + 1);
    expect(
      (await updateLink(deps, ADA, tripId, link?.id ?? '', { url: 'https://example.org/new' }))?.[0]
        ?.url,
    ).toBe('https://example.org/new');
    expect(
      (await updateLink(deps, ADA, tripId, link?.id ?? '', { kind: 'tally' }))?.[0],
    ).toMatchObject({ kind: 'tally', title: 'Renamed' });
    for (const bad of [
      { url: 'http://example.org/' },
      { url: 'javascript:1' },
      { title: '   ' },
      { kind: 'x' },
      {},
    ])
      expect(
        await updateLink(deps, ADA, tripId, link?.id ?? '', bad).then(
          () => 'accepted',
          (e: unknown) => (e as Error).name,
        ),
        JSON.stringify(bad),
      ).toBe('LinkRefused');
    expect((await listLinks(deps, ADA, tripId))?.[0]).toMatchObject({
      title: 'Renamed',
      url: 'https://example.org/new',
      kind: 'tally',
    });
  });

  it('are reordered, to just before another or to the end, and the order is the database’s too', async () => {
    for (const name of ['A', 'B', 'C'])
      await addLink(deps, ADA, tripId, { title: name, url: `https://example.org/${name}` });
    const [a, , c] = (await listLinks(deps, ADA, tripId)) ?? [];
    await moveLink(deps, ADA, tripId, c?.id ?? '', a?.id ?? null);
    expect(await titles()).toEqual(['C', 'A', 'B']);
    await moveLink(deps, SAM, tripId, c?.id ?? '', null);
    expect(await titles()).toEqual(['A', 'B', 'C']);
    const stored = await dbAll<{ position: string }>(
      database,
      sql`SELECT position FROM ${t('trip_link')} WHERE trip_id = ${tripId} ORDER BY position`,
    );
    expect(stored.map((row) => row.position)).toEqual(
      (await listLinks(deps, ADA, tripId))?.map((link) => link.position),
    );
    // A neighbour or a link that is not this trip's is not found.
    expect(await moveLink(deps, ADA, tripId, a?.id ?? '', randomUUID())).toBeUndefined();
    expect(await moveLink(deps, ADA, tripId, randomUUID(), null)).toBeUndefined();
    const foreign = (
      await addLink(deps, ADA, otherTrip, { title: 'F', url: 'https://example.org/f' })
    )?.[0];
    expect(await moveLink(deps, ADA, tripId, foreign?.id ?? '', null)).toBeUndefined();
    expect(
      await updateLink(deps, ADA, tripId, foreign?.id ?? '', { title: 'Taken' }),
    ).toBeUndefined();
    expect(await removeLink(deps, ADA, tripId, foreign?.id ?? '')).toBeUndefined();
    expect((await listLinks(deps, ADA, otherTrip))?.[0]?.title).toBe('F');
  });

  it('are removed, once, and go with the trip', async () => {
    const link = (
      await addLink(deps, ADA, tripId, { title: 'Gone', url: 'https://example.org/g' })
    )?.[0];
    await addLink(deps, ADA, tripId, { title: 'Also gone', url: 'https://example.org/h' });
    expect(await removeLink(deps, SAM, tripId, link?.id ?? '')).toHaveLength(1);
    expect(await removeLink(deps, SAM, tripId, link?.id ?? '')).toBeUndefined();
    await addLink(deps, ADA, otherTrip, { title: 'Kept', url: 'https://example.org/k' });
    expect(await deleteTrip(deps, ADA, tripId)).toBe(true);
    expect(await count('trip_link', sql`WHERE trip_id = ${tripId}`)).toBe(0);
    expect(await count('trip_link', sql`WHERE trip_id = ${otherTrip}`)).toBe(1);
  });
});

describe(`no request is ever made to a link's address (${leg})`, () => {
  it('through every operation, with the network refused: nothing is fetched, and nothing fails for want of it', async () => {
    // The database may be a service reached over HTTP (sqld), which is `fetch` too: that, to this machine, is let through; everything else is refused and counted.
    const real = globalThis.fetch;
    const outbound: string[] = [];
    vi.stubGlobal(
      'fetch',
      (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        const url = new URL(
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
        );
        if (['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) return real(input, init);
        outbound.push(url.href);
        return Promise.reject(new Error('the network must not be used'));
      },
    );
    const link = (
      await addLink(deps, ADA, tripId, { kind: 'tally', url: 'https://tally.example.org/g/abc' })
    )?.[0];
    await addLink(deps, SAM, tripId, { title: 'Hotel', url: 'https://hotel.example/' });
    await listLinks(deps, NOOR, tripId);
    await updateLink(deps, ADA, tripId, link?.id ?? '', { title: 'Money' });
    await moveLink(deps, ADA, tripId, link?.id ?? '', null);
    await removeLink(deps, ADA, tripId, link?.id ?? '');
    expect(outbound).toEqual([]);
  });

  it('in the code: the link files import no network, no outbound helper, and name no host of an app', () => {
    const dir = path.join(__dirname);
    for (const name of ['links.ts', 'link-format.ts']) {
      const source = readFileSync(path.join(dir, name), 'utf8')
        // Comments say what is not done; the code is what is read.
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
      expect(source, name).not.toMatch(
        /\bfetch\s*\(|XMLHttpRequest|node:https?|node:net|undici|outbound|http\.request|\baxios\b/,
      );
      expect(source, name).not.toMatch(/tally\.|\.sovereign/i);
    }
    // And nothing in the trips code that reads a link's address passes it to anything that makes a request.
    for (const name of readdirSync(dir).filter(
      (file) => file.endsWith('.ts') && !file.endsWith('.test.ts'),
    )) {
      const source = readFileSync(path.join(dir, name), 'utf8');
      expect(source, name).not.toMatch(/outbound\/|from '\.\.\/outbound/);
    }
  });
});
