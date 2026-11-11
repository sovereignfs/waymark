import { randomBytes } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ringOf } from '../crypto/keys';
import { Sealer } from '../crypto/sealed';
import type { Database } from '../db/client';
import { dbAll, dbGet, dbRun } from '../db/exec';
import { makeStore, testTarget } from '../db/test-support';
import { type FakeSearch, startFakePlaces } from '../places/fake';
import { PlaceFinder } from '../places/finder';
import { MAX_TRIES, nameWaitingPlaces } from '../places/naming';
import { getPlace, listPlaces, updatePlace } from '../places/places';
import { mergePlaces } from '../actions/places';
import type { CheckinView, PlaceView } from '../actions/types';
import { type ApplyDeps, applyMutation } from './apply';

/**
 * Applying a mutation (DESIGN.md §15.3, §15.5), against whichever database the leg runs on: once, re-checked, ordered, sealed, and whole or not at all. Two accounts share the store, and every
 * test uses ids of its own.
 */
const { leg } = testTarget();
const ring = ringOf(randomBytes(32));
if (!ring) throw new Error('no ring');
const sealer = new Sealer(ring);
const ADA = 'ada-account';
const GRACE = 'grace-account';
let NOW = 1_800_000_000_000;

let database: Database;
let close: () => Promise<void>;
let deps: ApplyDeps;
const tbl = (name: string) => sql.raw(database.dialect === 'postgres' ? `waymark.${name}` : name);

beforeAll(async () => {
  ({ database, close } = await makeStore());
  deps = { database, sealer, now: () => NOW };
});
afterAll(async () => close());
beforeEach(() => {
  NOW += 1000;
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
const putPlace = (id: string, row: Record<string, unknown> = {}, extra = {}) => ({
  table: 'place',
  op: 'put',
  id,
  row: { ...PLACE, ...row },
  ...extra,
});
const putCheckin = (
  id: string,
  placeId: string,
  row: Record<string, unknown> = {},
  extra = {},
) => ({ table: 'checkin', op: 'put', id, row: checkinRow(placeId, row), ...extra });
const del = (table: 'place' | 'checkin', id: string) => ({ table, op: 'delete', id });
const apply = (who: string, m: unknown) => applyMutation(deps, who, m);

interface CheckinRead {
  id: string;
  placeId: string;
  at: number;
  version: number;
  seq: number;
  note: string | undefined;
  companions: string[] | undefined;
}
async function checkins(accountId: string): Promise<CheckinRead[]> {
  const rows = await dbAll<{
    id: string;
    placeId: string;
    at: number | string;
    version: number | string;
    seq: number | string;
    sealed: Uint8Array;
  }>(
    database,
    sql`SELECT id, place_id AS "placeId", at, version, seq, sealed FROM ${tbl('checkin')} WHERE account_id = ${accountId} ORDER BY id`,
  );
  return rows.map((r) => {
    const fields = sealer.unseal(
      'checkin',
      r.id,
      r.sealed instanceof Uint8Array ? r.sealed : new Uint8Array(r.sealed),
    );
    return {
      id: r.id,
      placeId: r.placeId,
      at: Number(r.at),
      version: Number(r.version),
      seq: Number(r.seq),
      note: fields.note,
      companions: fields.companions,
    };
  });
}
const streamSeq = async (accountId: string) =>
  Number(
    (
      await dbGet<{ seq: number | string }>(
        database,
        sql`SELECT seq FROM ${tbl('account_stream')} WHERE account_id = ${accountId}`,
      )
    )?.seq ?? 0,
  );
const count = async (table: string, accountId: string) =>
  Number(
    (
      await dbGet<{ n: number | string }>(
        database,
        sql`SELECT COUNT(*) AS n FROM ${tbl(table)} WHERE account_id = ${accountId}`,
      )
    )?.n,
  );
const tombstones = async (accountId: string) =>
  dbAll<{ tableName: string; rowId: string; seq: number | string }>(
    database,
    sql`SELECT table_name AS "tableName", row_id AS "rowId", seq FROM ${tbl('tombstone')} WHERE account_id = ${accountId} ORDER BY seq`,
  );

describe(`applying a mutation (${leg})`, () => {
  it('writes a place and a check-in at it, sealed, in order, and stamps each with its number in the stream', async () => {
    const place = uid('place');
    const checkin = uid('checkin');
    const result = await apply(
      ADA,
      mutation([
        putPlace(place),
        putCheckin(checkin, place, { note: 'Zxqv secret note', companions: ['Ada', 'Grace'] }),
      ]),
    );
    expect(result).toEqual({ status: 'applied', seq: 2, unnamed: [], released: [] });
    const [row] = (await checkins(ADA)).filter((c) => c.id === checkin);
    expect(row).toMatchObject({
      placeId: place,
      version: 1,
      seq: 2,
      note: 'Zxqv secret note',
      companions: ['Ada', 'Grace'],
    });
    expect((await getPlace({ database, sealer }, ADA, place))?.name).toBe('Café de Flore');
    expect((await listPlaces({ database, sealer }, ADA)).find((p) => p.id === place)).toMatchObject(
      { version: 1, seq: 1, tz: 'Europe/Paris' },
    );
    // The note is in no column, and not readable in the envelope.
    const raw = await dbAll<Record<string, unknown>>(
      database,
      sql`SELECT * FROM ${tbl('checkin')} WHERE id = ${checkin}`,
    );
    const sealed = Buffer.from(raw[0]?.sealed as Uint8Array);
    expect(sealed.includes(Buffer.from('Zxqv'))).toBe(false);
    expect(JSON.stringify({ ...raw[0], sealed: undefined })).not.toContain('Zxqv');
  });

  it('is once: a replay writes nothing, and says it was a replay', async () => {
    const place = uid('place');
    const m = mutation([putPlace(place), putCheckin(uid('checkin'), place)]);
    expect((await apply(ADA, m)).status).toBe('applied');
    const before = {
      stream: await streamSeq(ADA),
      applied: await count('applied_mutation', ADA),
      checkins: await count('checkin', ADA),
    };
    expect(await apply(ADA, m)).toEqual({ status: 'replay' });
    expect(await apply(ADA, m)).toEqual({ status: 'replay' });
    expect({
      stream: await streamSeq(ADA),
      applied: await count('applied_mutation', ADA),
      checkins: await count('checkin', ADA),
    }).toEqual(before);
  });

  it('keeps the mutations of two accounts apart: the same id is a different mutation for another person', async () => {
    const id = uid('same');
    expect((await apply(ADA, mutation([putPlace(uid('p'))], id))).status).toBe('applied');
    expect((await apply(GRACE, mutation([putPlace(uid('p'))], id))).status).toBe('applied');
    expect((await apply(GRACE, mutation([putPlace(uid('p'))], id))).status).toBe('replay');
  });

  it('is exactly one of two copies of a mutation that arrive at the same time', async () => {
    const place = uid('place');
    const m = mutation([putPlace(place), putCheckin(uid('checkin'), place)]);
    const before = await count('checkin', ADA);
    const results = await Promise.all([apply(ADA, m), apply(ADA, m), apply(ADA, m)]);
    expect(results.map((r) => r.status).sort()).toEqual(['applied', 'replay', 'replay']);
    expect(await count('checkin', ADA)).toBe(before + 1);
  });

  it('gives every change of mutations that arrive at the same time a number of its own, with none missing', async () => {
    const start = await streamSeq(GRACE);
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        apply(GRACE, mutation([putPlace(uid('p')), putPlace(uid('p')), putPlace(uid('p'))])),
      ),
    );
    expect(results.every((r) => r.status === 'applied')).toBe(true);
    const seqs = results.map((r) => (r.status === 'applied' ? r.seq : 0)).sort((a, b) => a - b);
    expect(seqs).toEqual(Array.from({ length: 8 }, (_, i) => start + 3 * (i + 1)));
    expect(await streamSeq(GRACE)).toBe(start + 24);
  });
});

describe(`editing and deleting (${leg})`, () => {
  it('replaces the row whole, counts the version, and lets the later edit stand whatever version it was made from', async () => {
    const place = uid('place');
    const checkin = uid('checkin');
    await apply(ADA, mutation([putPlace(place), putCheckin(checkin, place, { note: 'first' })]));
    await apply(
      ADA,
      mutation([
        putCheckin(checkin, place, { note: 'second', companions: ['Ada'] }, { baseVersion: 1 }),
      ]),
    );
    // Another device, which still had version 1, edits later: its edit stands, whole.
    await apply(ADA, mutation([putCheckin(checkin, place, { note: 'third' }, { baseVersion: 1 })]));
    const [row] = (await checkins(ADA)).filter((c) => c.id === checkin);
    expect(row).toMatchObject({ note: 'third', version: 3 });
    expect(row?.companions).toBeUndefined();
  });

  it('deletes, leaves a tombstone with the table, the id and the number, and no content', async () => {
    const place = uid('place');
    const checkin = uid('checkin');
    const made = await apply(
      ADA,
      mutation([putPlace(place), putCheckin(checkin, place, { note: 'forget me' })]),
    );
    expect(made.status).toBe('applied');
    const gone = await apply(ADA, mutation([del('checkin', checkin)]));
    expect(gone.status).toBe('applied');
    expect((await checkins(ADA)).some((c) => c.id === checkin)).toBe(false);
    const stone = (await tombstones(ADA)).find((t) => t.rowId === checkin);
    expect(stone).toMatchObject({
      tableName: 'checkin',
      seq: gone.status === 'applied' ? gone.seq : -1,
    });
    expect(JSON.stringify(stone)).not.toContain('forget');
  });

  it('is deleted when both delete, and deleting what is not there is nothing', async () => {
    const place = uid('place');
    const checkin = uid('checkin');
    await apply(ADA, mutation([putPlace(place), putCheckin(checkin, place)]));
    expect((await apply(ADA, mutation([del('checkin', checkin)]))).status).toBe('applied');
    const stones = (await tombstones(ADA)).length;
    expect((await apply(ADA, mutation([del('checkin', checkin)]))).status).toBe('applied');
    expect((await apply(ADA, mutation([del('checkin', 'never-was')]))).status).toBe('applied');
    expect((await tombstones(ADA)).length).toBe(stones);
  });

  it('is restored by an edit made on a device that had not heard of the delete: the tombstone goes', async () => {
    const place = uid('place');
    const checkin = uid('checkin');
    await apply(ADA, mutation([putPlace(place), putCheckin(checkin, place)]));
    await apply(ADA, mutation([del('checkin', checkin)]));
    expect((await tombstones(ADA)).some((t) => t.rowId === checkin)).toBe(true);
    await apply(ADA, mutation([putCheckin(checkin, place, { note: 'back' }, { baseVersion: 1 })]));
    expect((await checkins(ADA)).find((c) => c.id === checkin)?.note).toBe('back');
    expect((await tombstones(ADA)).some((t) => t.rowId === checkin)).toBe(false);
  });

  it('does not delete a place that has a check-in, says so, and keeps the rest of the mutation from being applied', async () => {
    const place = uid('place');
    const checkin = uid('checkin');
    const other = uid('place');
    await apply(ADA, mutation([putPlace(place), putCheckin(checkin, place)]));
    const refused = await apply(ADA, mutation([putPlace(other), del('place', place)]));
    expect(refused).toMatchObject({
      status: 'refused',
      reason: 'in_use',
      sentence: expect.stringContaining('Merge it into another place'),
    });
    expect(await getPlace({ database, sealer }, ADA, place)).toBeDefined();
    expect(await getPlace({ database, sealer }, ADA, other)).toBeUndefined();
    // The check-in and then the place, in one mutation, in that order.
    expect(
      (await apply(ADA, mutation([del('checkin', checkin), del('place', place)]))).status,
    ).toBe('applied');
    expect(await getPlace({ database, sealer }, ADA, place)).toBeUndefined();
    expect(
      (await tombstones(ADA))
        .filter((t) => [checkin, place].includes(t.rowId))
        .map((t) => t.tableName)
        .sort(),
    ).toEqual(['checkin', 'place']);
  });
});

describe(`what is refused (${leg})`, () => {
  it('is another person’s row, as not found, with nothing of theirs changed, and a delete of it does nothing', async () => {
    const place = uid('place');
    const checkin = uid('checkin');
    await apply(ADA, mutation([putPlace(place), putCheckin(checkin, place, { note: 'ada’s' })]));
    const graces = uid('place');
    await apply(GRACE, mutation([putPlace(graces)]));
    const before = { ada: await streamSeq(ADA), grace: await streamSeq(GRACE) };
    for (const m of [
      mutation([putCheckin(checkin, graces, { note: 'taken' })]), // a check-in of ada's
      mutation([putPlace(place, { name: 'Taken' })]), // a place of ada's
      mutation([putCheckin(uid('checkin'), place)]), // a check-in at ada's place
    ]) {
      const refused = await apply(GRACE, m);
      expect(refused.status).toBe('refused');
      expect(refused.status === 'refused' && ['missing', 'place_missing']).toContain(
        refused.status === 'refused' ? refused.reason : '',
      );
    }
    expect(
      (await apply(GRACE, mutation([del('checkin', checkin), del('place', place)]))).status,
    ).toBe('applied');
    expect((await checkins(ADA)).find((c) => c.id === checkin)).toMatchObject({
      note: 'ada’s',
      version: 1,
    });
    expect((await getPlace({ database, sealer }, ADA, place))?.name).toBe('Café de Flore');
    expect((await tombstones(ADA)).some((t) => [checkin, place].includes(t.rowId))).toBe(false);
    expect(await streamSeq(ADA)).toBe(before.ada);
  });

  it('is all or none: one change that is wrong keeps every other of the mutation out, the number and the id too', async () => {
    const place = uid('place');
    const id = uid('m');
    const before = {
      stream: await streamSeq(ADA),
      applied: await count('applied_mutation', ADA),
      places: await count('place', ADA),
      checkins: await count('checkin', ADA),
    };
    const refused = await apply(
      ADA,
      mutation(
        [
          putPlace(place),
          putCheckin(uid('checkin'), place),
          putCheckin(uid('checkin'), 'no-such-place'),
        ],
        id,
      ),
    );
    expect(refused).toMatchObject({
      status: 'refused',
      reason: 'place_missing',
      sentence: 'A check-in needs a place.',
    });
    expect({
      stream: await streamSeq(ADA),
      applied: await count('applied_mutation', ADA),
      places: await count('place', ADA),
      checkins: await count('checkin', ADA),
    }).toEqual(before);
    // Mended and sent again under the same id, it is applied: the id was not spent.
    expect(
      (await apply(ADA, mutation([putPlace(place), putCheckin(uid('checkin'), place)], id))).status,
    ).toBe('applied');
  });

  it('is what breaks a rule, re-checked here, whatever the device did: the future, a note too long, a key the format does not have', async () => {
    const place = uid('place');
    const stream = await streamSeq(ADA);
    for (const [changes, reason] of [
      [[putPlace(place), putCheckin(uid('c'), place, { at: NOW + 3_600_000 })], 'future'],
      [[putPlace(place), putCheckin(uid('c'), place, { note: 'x'.repeat(2001) })], 'note'],
      [[putPlace(place, { name: '' })], 'place_name'],
      [[putPlace(place, { rating: 5 })], 'bad_mutation'],
      [[], 'bad_mutation'],
    ] as const) {
      const refused = await apply(ADA, mutation([...changes]));
      expect(refused).toMatchObject({ status: 'refused', reason });
      expect(refused.status === 'refused' && refused.sentence).toMatch(/\.$/);
    }
    expect(await apply(ADA, { mutationId: 'm-x', stream: 'trip:abc', changes: [] })).toMatchObject({
      status: 'refused',
    });
    expect(await apply(ADA, 'not a mutation')).toMatchObject({
      status: 'refused',
      reason: 'bad_mutation',
    });
    expect(await streamSeq(ADA)).toBe(stream);
    expect(await getPlace({ database, sealer }, ADA, place)).toBeUndefined();
  });

  it('is an import’s own id twice, under another check-in id: it is already here, and the same check-in again is an edit', async () => {
    const place = uid('place');
    const first = uid('checkin');
    const row = { source: 'import:swarm', externalId: uid('swarm') };
    expect(
      (await apply(ADA, mutation([putPlace(place), putCheckin(first, place, row)]))).status,
    ).toBe('applied');
    expect(await apply(ADA, mutation([putCheckin(uid('checkin'), place, row)]))).toMatchObject({
      status: 'refused',
      reason: 'duplicate',
    });
    expect(
      (await apply(ADA, mutation([putCheckin(first, place, { ...row, note: 'edited' })]))).status,
    ).toBe('applied');
    // Another person's check-in with the same import id is theirs.
    const graces = uid('place');
    expect(
      (await apply(GRACE, mutation([putPlace(graces), putCheckin(uid('checkin'), graces, row)])))
        .status,
    ).toBe('applied');
  });
});

describe(`a place that is named later (${leg})`, () => {
  let fake: FakeSearch;
  beforeAll(async () => {
    fake = await startFakePlaces();
  });
  afterAll(async () => fake.close());
  beforeEach(() => {
    fake.requests.length = 0;
    fake.failWith(undefined);
  });

  const finder = (provider: 'nominatim' | 'off' = 'nominatim') =>
    new PlaceFinder({
      settings:
        provider === 'off'
          ? { provider: 'off', url: undefined, public: false, allow: [] }
          : {
              provider,
              url: fake.url(),
              public: false,
              allow: [{ host: new URL(fake.url()).hostname, allowPrivate: true, allowHttp: true }],
            },
      database,
      userAgent: 'Waymark',
    });
  const naming = (f = finder()) => ({ database, sealer, finder: f, now: () => ++NOW });
  const unnamedOf = async (id: string) =>
    Number(
      (
        await dbGet<{ unnamed: number | string }>(
          database,
          sql`SELECT unnamed FROM ${tbl('place')} WHERE id = ${id}`,
        )
      )?.unnamed,
    );
  /** Clears the lease the job takes, which lasts a minute: a test runs the job more than once. */
  const release = () =>
    dbRun(database, sql`DELETE FROM ${tbl('job_claim')} WHERE job = 'name-places'`);
  const nearTokyoTower = (id: string) =>
    putPlace(
      id,
      {
        name: 'A place near 35.6586, 139.7454',
        lat: 35.6586,
        lng: 139.7454,
        source: 'manual',
        tz: 'Asia/Tokyo',
      },
      {},
    );

  it('is marked by the mutation, and named from where it is, through the stream, so a device pulls the name', async () => {
    await release();
    const id = uid('place');
    const result = await apply(
      ADA,
      mutation([
        { ...nearTokyoTower(id), row: { ...nearTokyoTower(id).row, unnamed: true } },
        putCheckin(uid('c'), id),
      ]),
    );
    expect(result).toMatchObject({ status: 'applied', unnamed: [id] });
    expect(await unnamedOf(id)).toBe(1);
    const before = await getPlace({ database, sealer }, ADA, id);
    const stream = await streamSeq(ADA);
    expect(await nameWaitingPlaces(naming())).toBeGreaterThanOrEqual(1);
    const after = await getPlace({ database, sealer }, ADA, id);
    expect(after).toMatchObject({
      name: 'Tokyo Tower',
      source: 'osm',
      sourceId: 'way/100001',
      category: 'Tower',
      address: { city: 'Minato', countryCode: 'JP' },
      version: (before?.version ?? 0) + 1,
    });
    expect(after?.seq).toBeGreaterThan(before?.seq ?? 0);
    expect(await streamSeq(ADA)).toBe(stream + 1);
    expect(await unnamedOf(id)).toBe(0);
    expect(await nameWaitingPlaces(naming())).toBe(0); // nothing waits now
  });

  it('leaves a name the person typed meanwhile, which cleared the mark', async () => {
    await release();
    const id = uid('place');
    await apply(
      ADA,
      mutation([{ ...nearTokyoTower(id), row: { ...nearTokyoTower(id).row, unnamed: true } }]),
    );
    const typed = await updatePlace({ database, sealer, now: () => ++NOW }, ADA, id, {
      name: 'My favourite spot',
    });
    // `updatePlace` of 4.1 does not clear the mark; a person's edit through the stream does, as here.
    await apply(
      ADA,
      mutation([
        putPlace(
          id,
          {
            name: 'My favourite spot',
            lat: 35.6586,
            lng: 139.7454,
            source: 'manual',
            tz: 'Asia/Tokyo',
          },
          { baseVersion: typed?.version },
        ),
      ]),
    );
    expect(await unnamedOf(id)).toBe(0);
    await nameWaitingPlaces(naming());
    expect((await getPlace({ database, sealer }, ADA, id))?.name).toBe('My favourite spot');
  });

  it('gives up when nothing is known at the point, or there is no place search, and keeps the name it has', async () => {
    await release();
    const nowhere = uid('place');
    await apply(
      ADA,
      mutation(
        [
          putPlace(
            nowhere,
            { name: 'A place near 0.0000, 0.0000', lat: 0, lng: 0, source: 'manual' },
            {},
          ),
        ].map((c) => ({ ...c, row: { ...c.row, unnamed: true } })),
      ),
    );
    expect(await nameWaitingPlaces(naming())).toBe(0);
    expect(await unnamedOf(nowhere)).toBe(0);
    expect((await getPlace({ database, sealer }, ADA, nowhere))?.name).toBe(
      'A place near 0.0000, 0.0000',
    );
    await release();
    const offPlace = uid('place');
    await apply(
      ADA,
      mutation([
        { ...nearTokyoTower(offPlace), row: { ...nearTokyoTower(offPlace).row, unnamed: true } },
      ]),
    );
    expect(await nameWaitingPlaces(naming(finder('off')))).toBe(0);
    expect(await unnamedOf(offPlace)).toBe(0);
    expect((await getPlace({ database, sealer }, ADA, offPlace))?.name).toContain('A place near');
  });

  it('is tried again while the search is out of reach, and given up after six tries', async () => {
    await release();
    const id = uid('place');
    await apply(
      ADA,
      mutation([{ ...nearTokyoTower(id), row: { ...nearTokyoTower(id).row, unnamed: true } }]),
    );
    fake.failWith(503);
    for (let attempt = 1; attempt < MAX_TRIES; attempt++) {
      await release();
      await nameWaitingPlaces(naming());
      expect(await unnamedOf(id)).toBe(attempt + 1);
    }
    await release();
    await nameWaitingPlaces(naming());
    expect(await unnamedOf(id)).toBe(0);
    expect((await getPlace({ database, sealer }, ADA, id))?.name).toContain('A place near');
    // And with the search back, one that was given up is not asked about again.
    fake.failWith(undefined);
    await release();
    expect(await nameWaitingPlaces(naming())).toBe(0);
  });

  it('does nothing in a process that cannot have the lease, since another has it', async () => {
    await release();
    const id = uid('place');
    await apply(
      ADA,
      mutation([{ ...nearTokyoTower(id), row: { ...nearTokyoTower(id).row, unnamed: true } }]),
    );
    await dbRun(
      database,
      sql`INSERT INTO ${tbl('job_claim')} (job, claimed_until) VALUES ('name-places', ${Date.now() + 60_000})`,
    );
    expect(await nameWaitingPlaces(naming())).toBe(0);
    expect(await unnamedOf(id)).toBe(1);
    await release();
    expect(await nameWaitingPlaces(naming())).toBeGreaterThanOrEqual(1);
  });
});

describe(`merging places (${leg})`, () => {
  const view = (id: string): PlaceView => ({
    id,
    ...(PLACE as Omit<PlaceView, 'id' | 'version'>),
    version: 1,
  });
  const ctx = () => {
    let k = 0;
    return { ids: { newId: () => uid(`merge${++k}`) }, now: NOW, deviceZone: 'Europe/Paris' };
  };
  const seed = async (count: number) => {
    const from = uid('place');
    const into = uid('place');
    const other = uid('place');
    await apply(ADA, mutation([putPlace(from), putPlace(into), putPlace(other)]));
    const views: CheckinView[] = [];
    for (let i = 0; i < count; i += 1) {
      const id = uid('checkin');
      await apply(ADA, mutation([putCheckin(id, from, { at: NOW - 1_000_000 + i })]));
      views.push({
        id,
        ...checkinRow(from, { at: NOW - 1_000_000 + i }),
        version: 1,
      } as CheckinView);
    }
    const kept = uid('checkin');
    await apply(ADA, mutation([putCheckin(kept, other)]));
    return { from, into, other, kept, views };
  };

  it('moves every check-in and deletes the place, through the one path, over several mutations when there are many, and the count adds up', async () => {
    const { from, into, other, kept, views } = await seed(60);
    const before = await count('checkin', ADA);
    const made = mergePlaces(view(from), view(into), views, ctx());
    if (!made.ok) throw new Error(made.sentence);
    expect(made.mutations).toHaveLength(2);
    for (const each of made.mutations)
      expect(await apply(ADA, each)).toMatchObject({ status: 'applied' });

    const mine = await checkins(ADA);
    expect(mine.filter((c) => c.placeId === into)).toHaveLength(60);
    expect(mine.filter((c) => c.placeId === from)).toHaveLength(0);
    expect(mine.find((c) => c.id === kept)?.placeId).toBe(other);
    expect(await count('checkin', ADA)).toBe(before);
    expect(await getPlace({ database, sealer }, ADA, from)).toBeUndefined();
    expect(await getPlace({ database, sealer }, ADA, into)).toBeDefined();
    // Each moved check-in is a new version, with a number in the stream past the old, so a device pulls it; the place is a tombstone.
    expect(mine.filter((c) => c.placeId === into).every((c) => c.version === 2)).toBe(true);
    expect((await tombstones(ADA)).some((t) => t.rowId === from && t.tableName === 'place')).toBe(
      true,
    );
    // A replay writes nothing.
    const stream = await streamSeq(ADA);
    for (const each of made.mutations)
      expect(await apply(ADA, each)).toMatchObject({ status: 'replay' });
    expect(await streamSeq(ADA)).toBe(stream);
  });

  it('does not delete the place when a mutation that moves check-ins did not arrive first: nothing is lost', async () => {
    const { from, into, views } = await seed(60);
    const made = mergePlaces(view(from), view(into), views, ctx());
    if (!made.ok) throw new Error(made.sentence);
    // Only the last, with the delete, arrives: the check-ins of the first are still at the place.
    const last = made.mutations[1];
    expect(await apply(ADA, last)).toMatchObject({ status: 'refused', reason: 'in_use' });
    expect(await getPlace({ database, sealer }, ADA, from)).toBeDefined();
  });

  it('is not another person’s to do: merging someone’s places as a second person changes nothing', async () => {
    const { from, into, views } = await seed(3);
    const made = mergePlaces(view(from), view(into), views, ctx());
    if (!made.ok) throw new Error(made.sentence);
    const mutationOf = made.mutations[0];
    const result = await apply(GRACE, mutationOf);
    expect(result.status).toBe('refused');
    expect((await checkins(ADA)).filter((c) => c.placeId === from)).toHaveLength(3);
    expect(await getPlace({ database, sealer }, ADA, from)).toBeDefined();
  });
});
