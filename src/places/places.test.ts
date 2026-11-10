import { randomBytes } from 'node:crypto';
import { is, sql } from 'drizzle-orm';
import { SQLiteTable, getTableConfig } from 'drizzle-orm/sqlite-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Sealer } from '../crypto/sealed';
import { ringOf } from '../crypto/keys';
import type { Database } from '../db/client';
import { dbAll, dbGet, dbRun } from '../db/exec';
import * as sqliteSchema from '../db/schema/sqlite';
import { makeStore, testTarget } from '../db/test-support';
import { findSamePlace } from './match';
import {
  PLACE_REFERENCES,
  PlaceError,
  type PlaceDeps,
  type PlaceReference,
  TRIP_REFERENCES,
  deletePlace,
  deletePlacesOf,
  findPlaceLike,
  getPlace,
  listPlaces,
  makePlace,
  mergePlace,
  movePlace,
  recategorizePlace,
  renamePlace,
  updatePlace,
} from './places';
import { searchPlaces } from './search';

/**
 * A person's places (DESIGN.md §7.1), against whichever database the leg runs on. **Another person's place is a place that is not there** for every operation, and what the
 * database holds of a place is sealed.
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
let deps: PlaceDeps;
const app = (name: string) => (database.dialect === 'postgres' ? `waymark.${name}` : name);
/** A table that stands in for check-ins, which name a place and belong to a person (5.2 makes the real one). */
const VISITS: PlaceReference = {
  table: 'scratch_visit',
  column: 'place_id',
  ownerColumn: 'account_id',
};

beforeAll(async () => {
  ({ database, close } = await makeStore());
  deps = { database, sealer, now: () => ++NOW };
  await dbRun(
    database,
    sql.raw(
      `CREATE TABLE ${app('scratch_visit')} (id text PRIMARY KEY, place_id text NOT NULL, account_id text NOT NULL)`,
    ),
  );
});
afterAll(async () => {
  await dbRun(database, sql.raw(`DROP TABLE ${app('scratch_visit')}`));
  await close();
});

let n = 0;
const visit = async (accountId: string, placeId: string) =>
  dbRun(
    database,
    sql`INSERT INTO ${sql.raw(app('scratch_visit'))} (id, place_id, account_id) VALUES (${`v${++n}`}, ${placeId}, ${accountId})`,
  );
const visitsAt = async (placeId: string) =>
  Number(
    (
      await dbGet<{ n: number | string }>(
        database,
        sql`SELECT COUNT(*) AS n FROM ${sql.raw(app('scratch_visit'))} WHERE place_id = ${placeId}`,
      )
    )?.n,
  );
async function made(accountId: string, input: Parameters<typeof makePlace>[2]) {
  const result = await makePlace(deps, accountId, input);
  if (!result.ok) throw new Error('could not seed a place');
  return result.place;
}
const TOWER = { name: 'Tokyo Tower', lat: 35.6586, lng: 139.7454 };

describe(`making a place (${leg})`, () => {
  it('keeps what was given, finds the time zone from the point and the country from the address', async () => {
    const place = await made(ADA, {
      ...TOWER,
      category: 'Landmark',
      address: { city: 'Minato', country: 'Japan', countryCode: 'jp' },
      source: 'osm',
      sourceId: 'way/1',
    });
    expect(place).toMatchObject({
      accountId: ADA,
      name: 'Tokyo Tower',
      lat: 35.6586,
      lng: 139.7454,
      category: 'Landmark',
      address: { city: 'Minato', country: 'Japan', countryCode: 'JP' },
      source: 'osm',
      sourceId: 'way/1',
      tz: 'Asia/Tokyo',
      countryCode: 'JP',
      version: 1,
    });
    expect(await getPlace(deps, ADA, place.id)).toEqual(place);
  });

  it('seals what says where or what: no name, point or address is in a column or readable in the row', async () => {
    const place = await made(ADA, {
      name: 'Zxqv Secret Hideout',
      lat: 12.3456789,
      lng: 98.7654321,
      address: { street: 'Qwfp Lane' },
    });
    const rows = await dbAll<Record<string, unknown>>(
      database,
      sql`SELECT * FROM ${sql.raw(app('place'))} WHERE id = ${place.id}`,
    );
    expect(Object.keys(rows[0] ?? {}).sort()).toEqual(
      [
        'account_id',
        'country_code',
        'created_at',
        'id',
        'seq',
        'sealed',
        'source',
        'trip_id',
        'tz',
        'updated_at',
        'version',
      ].sort(),
    );
    const bytes = Buffer.from(rows[0]?.sealed as Uint8Array);
    for (const secret of ['Zxqv', 'Secret', 'Hideout', 'Qwfp', '12.3456789', '98.7654321'])
      expect(bytes.includes(Buffer.from(secret))).toBe(false);
    const plain = JSON.stringify({ ...rows[0], sealed: undefined });
    expect(plain).not.toContain('Zxqv');
    expect(plain).not.toContain('12.3456789');
    // Moved to another row's id, the envelope does not open.
    const other = await made(ADA, { name: 'Other', lat: 1, lng: 1 });
    await dbRun(
      database,
      sql`UPDATE ${sql.raw(app('place'))} SET sealed = ${Buffer.from(rows[0]?.sealed as Uint8Array)} WHERE id = ${other.id}`,
    );
    await expect(getPlace(deps, ADA, other.id)).rejects.toThrow();
    // The row is put away: the tests that list a person's places read every one.
    await dbRun(database, sql`DELETE FROM ${sql.raw(app('place'))} WHERE id = ${other.id}`);
  });

  it('is a replay when the same account makes the same id again, and nothing to anyone else', async () => {
    const first = await makePlace(deps, ADA, { id: 'offline-1', ...TOWER });
    const again = await makePlace(deps, ADA, {
      id: 'offline-1',
      name: 'Different',
      lat: 1,
      lng: 1,
    });
    expect(first).toMatchObject({ ok: true, existing: false });
    expect(again).toMatchObject({ ok: true, existing: true, place: { name: 'Tokyo Tower' } });
    const theirs = await makePlace(deps, GRACE, { id: 'offline-1', name: 'Mine', lat: 2, lng: 2 });
    expect(theirs).toEqual({ ok: false, reason: 'id_taken' });
    expect(await getPlace(deps, GRACE, 'offline-1')).toBeUndefined();
    expect((await getPlace(deps, ADA, 'offline-1'))?.name).toBe('Tokyo Tower');
  });

  it('refuses what is not a place, saying which part and never what it was given', async () => {
    const bad: [string, Partial<Parameters<typeof makePlace>[2]>][] = [
      ['name', { name: '   ' }],
      ['name', { name: 'a\nb' }],
      ['name', { name: 'x'.repeat(201) }],
      ['point', { lat: 91 }],
      ['point', { lng: Number.NaN }],
      ['point', { lng: -180.5 }],
      ['category', { category: 'x'.repeat(61) }],
      ['country code', { address: { countryCode: 'JPN' } }],
      ['address', { address: { nonsense: 'x' } as never }],
      ['time zone', { tz: 'Not/AZone' }],
      ['source', { source: 'somewhere' as never }],
      ['id', { id: 'has space' }],
    ];
    for (const [part, patch] of bad) {
      const error = await makePlace(deps, ADA, { ...TOWER, ...patch }).catch((e: unknown) => e);
      expect(error, part).toBeInstanceOf(PlaceError);
      expect(String((error as Error).message)).not.toContain('Not/AZone');
    }
    const before = (await listPlaces(deps, 'nobody')).length;
    expect(before).toBe(0);
  });

  it('takes a time zone that is given over the one the point is in, and none at a point that has a zone to find', async () => {
    const pago = await made(ADA, {
      name: 'Pago Pago',
      lat: -14.2756,
      lng: -170.702,
      tz: 'Pacific/Pago_Pago',
    });
    expect(pago.tz).toBe('Pacific/Pago_Pago');
    expect((await made(ADA, { name: 'Lisbon', lat: 38.7223, lng: -9.1393 })).tz).toBe(
      'Europe/Lisbon',
    );
  });
});

describe(`changing a place (${leg})`, () => {
  it('renames, recategorizes and moves, each changing that and nothing else, and counts the versions', async () => {
    const place = await made(ADA, { ...TOWER, category: 'Landmark', address: { city: 'Minato' } });
    const renamed = await renamePlace(deps, ADA, place.id, '  Tokyo Tower (Tōkyō Tawā) ');
    expect(renamed).toMatchObject({
      name: 'Tokyo Tower (Tōkyō Tawā)',
      category: 'Landmark',
      lat: TOWER.lat,
      version: 2,
    });
    const recategorized = await recategorizePlace(deps, ADA, place.id, 'Viewpoint');
    expect(recategorized).toMatchObject({
      category: 'Viewpoint',
      name: 'Tokyo Tower (Tōkyō Tawā)',
      version: 3,
    });
    const moved = await movePlace(deps, ADA, place.id, { lat: 38.7223, lng: -9.1393 });
    expect(moved).toMatchObject({
      lat: 38.7223,
      lng: -9.1393,
      tz: 'Europe/Lisbon',
      category: 'Viewpoint',
      address: { city: 'Minato' },
      version: 4,
    });
    expect((await recategorizePlace(deps, ADA, place.id, ''))?.category).toBeUndefined();
    expect(await getPlace(deps, ADA, place.id)).toMatchObject({ version: 5, tz: 'Europe/Lisbon' });
  });

  it('keeps a zone a person corrected when the place is renamed, and finds it again from a new point unless told', async () => {
    const place = await made(ADA, { name: 'Pago Pago', lat: -14.2756, lng: -170.702 });
    const corrected = await updatePlace(deps, ADA, place.id, { tz: 'Pacific/Pago_Pago' });
    expect(corrected?.tz).toBe('Pacific/Pago_Pago');
    expect((await renamePlace(deps, ADA, place.id, 'Pago'))?.tz).toBe('Pacific/Pago_Pago');
    expect((await movePlace(deps, ADA, place.id, { lat: 35.6586, lng: 139.7454 }))?.tz).toBe(
      'Asia/Tokyo',
    );
    expect(
      (
        await updatePlace(deps, ADA, place.id, {
          point: { lat: 38.7223, lng: -9.1393 },
          tz: 'Atlantic/Azores',
        })
      )?.tz,
    ).toBe('Atlantic/Azores');
    // `null` asks for the zone to be found again from the point.
    expect((await updatePlace(deps, ADA, place.id, { tz: null }))?.tz).toBe('Europe/Lisbon');
  });

  it('takes the country from a changed address, and an address away with null', async () => {
    const place = await made(ADA, { ...TOWER, address: { countryCode: 'JP' } });
    expect(
      (await updatePlace(deps, ADA, place.id, { address: { countryCode: 'PT', city: 'Lisbon' } }))
        ?.countryCode,
    ).toBe('PT');
    const none = await updatePlace(deps, ADA, place.id, { address: null });
    expect(none?.address).toBeUndefined();
    expect(none?.countryCode).toBeNull();
  });

  it('loses neither of two changes made at the same time', async () => {
    const place = await made(ADA, { ...TOWER, category: 'Landmark' });
    await Promise.all([
      renamePlace(deps, ADA, place.id, 'Renamed'),
      recategorizePlace(deps, ADA, place.id, 'Viewpoint'),
    ]);
    expect(await getPlace(deps, ADA, place.id)).toMatchObject({
      name: 'Renamed',
      category: 'Viewpoint',
      version: 3,
    });
  });

  it('refuses a value that is not one, changing nothing', async () => {
    const place = await made(ADA, TOWER);
    await expect(renamePlace(deps, ADA, place.id, '')).rejects.toBeInstanceOf(PlaceError);
    await expect(movePlace(deps, ADA, place.id, { lat: 100, lng: 0 })).rejects.toBeInstanceOf(
      PlaceError,
    );
    expect(await getPlace(deps, ADA, place.id)).toMatchObject({ name: TOWER.name, version: 1 });
  });
});

describe(`merging and deleting (${leg})`, () => {
  it('merges one place into another, moving every check-in of the person and no one else’s, and deleting the first', async () => {
    const from = await made(ADA, { name: 'Café de Flore', lat: 48.854, lng: 2.3326 });
    const into = await made(ADA, {
      name: 'Cafe de Flore',
      lat: 48.8541,
      lng: 2.3327,
      category: 'Cafe',
    });
    for (let i = 0; i < 3; i++) await visit(ADA, from.id);
    await visit(ADA, into.id);
    await visit(GRACE, from.id); // a row of someone else's that names the same id: not the person's to move
    const result = await mergePlace(deps, ADA, from.id, into.id, [VISITS]);
    expect(result).toMatchObject({
      ok: true,
      moved: 3,
      into: { id: into.id, name: 'Cafe de Flore', category: 'Cafe' },
    });
    expect(await getPlace(deps, ADA, from.id)).toBeUndefined();
    expect(await visitsAt(into.id)).toBe(4);
    expect(await visitsAt(from.id)).toBe(1);
  });

  it('is not found for a place that is another person’s, either side of the merge, and changes nothing', async () => {
    const mine = await made(ADA, { name: 'Mine', lat: 1, lng: 1 });
    const theirs = await made(GRACE, { name: 'Theirs', lat: 2, lng: 2 });
    await visit(ADA, mine.id);
    expect(await mergePlace(deps, ADA, mine.id, theirs.id, [VISITS])).toEqual({
      ok: false,
      reason: 'not_found',
    });
    expect(await mergePlace(deps, ADA, theirs.id, mine.id, [VISITS])).toEqual({
      ok: false,
      reason: 'not_found',
    });
    expect(await mergePlace(deps, ADA, mine.id, 'no-such-place', [VISITS])).toEqual({
      ok: false,
      reason: 'not_found',
    });
    expect(await mergePlace(deps, ADA, mine.id, mine.id, [VISITS])).toEqual({
      ok: false,
      reason: 'same_place',
    });
    expect(await getPlace(deps, GRACE, theirs.id)).toBeDefined();
    expect(await getPlace(deps, ADA, mine.id)).toBeDefined();
    expect(await visitsAt(mine.id)).toBe(1);
  });

  it('runs again with nothing to do: the first place is gone, which is not found', async () => {
    const from = await made(ADA, { name: 'A', lat: 1, lng: 1 });
    const into = await made(ADA, { name: 'B', lat: 2, lng: 2 });
    await visit(ADA, from.id);
    expect((await mergePlace(deps, ADA, from.id, into.id, [VISITS])).ok).toBe(true);
    expect(await mergePlace(deps, ADA, from.id, into.id, [VISITS])).toEqual({
      ok: false,
      reason: 'not_found',
    });
    expect(await visitsAt(into.id)).toBe(1);
  });

  it('deletes a place that nothing points at, and refuses one that has a check-in', async () => {
    const used = await made(ADA, { name: 'Used', lat: 1, lng: 1 });
    const unused = await made(ADA, { name: 'Unused', lat: 2, lng: 2 });
    await visit(ADA, used.id);
    expect(await deletePlace(deps, ADA, used.id, [VISITS])).toEqual({
      ok: false,
      reason: 'in_use',
    });
    expect(await getPlace(deps, ADA, used.id)).toBeDefined();
    expect(await deletePlace(deps, ADA, unused.id, [VISITS])).toEqual({ ok: true });
    expect(await getPlace(deps, ADA, unused.id)).toBeUndefined();
    expect(await deletePlace(deps, ADA, unused.id, [VISITS])).toEqual({
      ok: false,
      reason: 'not_found',
    });
  });

  it('is not found for another person’s place, which is not deleted', async () => {
    const theirs = await made(GRACE, { name: 'Theirs', lat: 2, lng: 2 });
    expect(await deletePlace(deps, ADA, theirs.id, [VISITS])).toEqual({
      ok: false,
      reason: 'not_found',
    });
    expect(await getPlace(deps, GRACE, theirs.id)).toBeDefined();
  });
});

describe(`a person’s places (${leg})`, () => {
  it('are listed only for the person, and never another’s', async () => {
    const mine = await listPlaces(deps, ADA);
    const theirs = await listPlaces(deps, GRACE);
    expect(mine.length).toBeGreaterThan(3);
    expect(mine.every((place) => place.accountId === ADA)).toBe(true);
    expect(theirs.every((place) => place.accountId === GRACE)).toBe(true);
    expect(theirs.map((p) => p.id).filter((id) => mine.some((m) => m.id === id))).toEqual([]);
  });

  it('are searched in memory after unsealing, and the same place is found by the one rule', async () => {
    const mine = await listPlaces(deps, ADA);
    expect(searchPlaces(mine, 'tower').length).toBeGreaterThan(0);
    expect(searchPlaces(await listPlaces(deps, GRACE), 'tower')).toEqual([]);
    const like = await findPlaceLike(deps, ADA, {
      name: 'tokyo tower',
      lat: 35.6587,
      lng: 139.7455,
    });
    expect(like?.name).toContain('Tokyo Tower');
    expect(findSamePlace({ name: 'tokyo tower', lat: 35.6587, lng: 139.7455 }, mine)?.id).toBe(
      like?.id,
    );
    expect(
      await findPlaceLike(deps, GRACE, { name: 'tokyo tower', lat: 35.6587, lng: 139.7455 }),
    ).toBeUndefined();
  });

  it('are all removed with the person, and only theirs', async () => {
    const before = (await listPlaces(deps, GRACE)).length;
    expect(before).toBeGreaterThan(0);
    expect(await deletePlacesOf(database, GRACE)).toBe(before);
    expect(await listPlaces(deps, GRACE)).toEqual([]);
    expect((await listPlaces(deps, ADA)).length).toBeGreaterThan(3);
    expect(await deletePlacesOf(database, GRACE)).toBe(0);
  });
});

describe('what names a place', () => {
  it('is every table with a place_id, each listed as a person’s or a trip’s, so a merge moves it and a delete sees it', () => {
    const tables = Object.values(sqliteSchema).filter((each) =>
      is(each, SQLiteTable),
    ) as SQLiteTable[];
    const naming = tables
      .map((each) => getTableConfig(each))
      .filter((config) => config.columns.some((column) => column.name === 'place_id'))
      .map((config) => config.name);
    const listed = new Set([...PLACE_REFERENCES.map((ref) => ref.table), ...TRIP_REFERENCES]);
    expect(
      naming.filter((name) => !listed.has(name)),
      'a table that names a place and is in neither list',
    ).toEqual([]);
    expect(
      [...listed].filter((name) => !naming.includes(name)),
      'a listed table that is not there',
    ).toEqual([]);
  });
});
