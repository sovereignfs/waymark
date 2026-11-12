import { randomUUID } from 'node:crypto';
import { type SQL, sql } from 'drizzle-orm';
import type { Sealer } from '../crypto/sealed';
import type { Database } from '../db/client';
import { APP_STORE } from '../db/config';
import { dbAll, dbGet, transaction } from '../db/exec';
import * as postgresSchema from '../db/schema/postgres';
import * as sqliteSchema from '../db/schema/sqlite';
import { findSamePlace } from './match';
import {
  type Address,
  type PlaceSource,
  PLACE_SOURCES,
  PlaceError,
  PLACE_ID,
  cleanAddress,
  cleanCategory,
  cleanPlaceName,
  cleanPoint,
  cleanSource,
  cleanSourceId,
  cleanZone,
} from './clean';
import { zoneOf } from './tz';

export { PLACE_SOURCES, PlaceError, cleanPlaceName, cleanPoint };
export type { Address, PlaceSource };
export { CATEGORY_MAX, NAME_MAX } from './clean';

/**
 * A person's places (DESIGN.md §7.1, §20.8): made, renamed, recategorized, moved, merged into another and deleted. **A place is its owner's:** every statement here names the owner
 * (`WHERE id = ? AND account_id = ?`), so another person's place is a place that is not there, and the answer for it is the answer for none. A trip's places (exactly one of `account_id`
 * and `trip_id` is set, §5.2) arrive with trips (9.2) and are not written from here.
 *
 * **What says where or what is sealed** (`SEALED.place`): this file is the only one that writes or reads `place.sealed`. The name, the point, the address, the category and the source id are
 * opened for the one row asked for, or for every row of one person when a list or a search is wanted (`searchPlaces`, in memory).
 *
 * **What points at a place** (check-ins, and a trip's stops and items) is listed in `PLACE_REFERENCES`: merging moves each of them, and a place with any is not deleted. There is no foreign
 * key (§24.1), so a table that names a place is added there by the task that makes it, and `places.test.ts` fails for one that is not.
 */
export interface Place {
  readonly id: string;
  readonly accountId: string;
  readonly source: PlaceSource;
  /** An IANA zone, found from the point and a default a person can correct (§7.3). Absent for a point that is not on the globe. */
  readonly tz: string | null;
  readonly countryCode: string | null;
  readonly version: number;
  readonly seq: number;
  readonly name: string;
  readonly lat: number;
  readonly lng: number;
  readonly address: Address | undefined;
  readonly category: string | undefined;
  readonly sourceId: string | undefined;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface PlaceDeps {
  readonly database: Database;
  readonly sealer: Sealer;
  readonly now: () => number;
}

/** A table that holds a `place_id`: where the rows of `ownerColumn` = the person move on a merge and stop a delete. */
export interface PlaceReference {
  readonly table: string;
  readonly column: string;
  readonly ownerColumn: string;
}

/**
 * Every table that names a place of a person: check-ins (5.2). A trip's stops and items name a trip's place and not a person's (a person's check-in at a trip's place names the copy that was
 * made for them, §7.1), so they are listed apart in `TRIP_REFERENCES`. `places.test.ts` reads the schema and fails for a table with a `place_id` that is in neither list.
 */
export const PLACE_REFERENCES: readonly PlaceReference[] = [
  { table: 'checkin', column: 'place_id', ownerColumn: 'account_id' },
];

/** Tables that name a trip's place, which a person's place is never. Listed so that the test above can tell the two apart. */
export const TRIP_REFERENCES: readonly string[] = ['stop'];

const table = (database: Database) =>
  database.dialect === 'postgres' ? postgresSchema.place : sqliteSchema.place;

const ident = (name: string): string => {
  if (!/^[a-z][a-z0-9_]*$/.test(name)) throw new Error('not a name that is safe to use');
  return name;
};
/** A table of the app's store, as the statement spells it on this dialect. */
const qualified = (database: Database, name: string): SQL =>
  sql.raw(database.dialect === 'postgres' ? `"${APP_STORE}"."${ident(name)}"` : ident(name));

interface Row {
  id: string;
  accountId: string;
  source: string;
  tz: string | null;
  countryCode: string | null;
  version: number | string;
  seq: number | string;
  sealed: ArrayBuffer | Uint8Array;
  createdAt: number | string;
  updatedAt: number | string;
}

const COLUMNS = sql`id, account_id AS "accountId", source, tz, country_code AS "countryCode", version, seq, sealed, created_at AS "createdAt", updated_at AS "updatedAt"`;

function placeOf(sealer: Sealer, row: Row): Place {
  const bytes = row.sealed instanceof Uint8Array ? row.sealed : new Uint8Array(row.sealed);
  const fields = sealer.unseal('place', row.id, bytes);
  return {
    id: row.id,
    accountId: row.accountId,
    source: cleanSource(row.source),
    tz: row.tz,
    countryCode: row.countryCode,
    version: Number(row.version),
    seq: Number(row.seq),
    name: fields.name,
    lat: fields.lat,
    lng: fields.lng,
    address: fields.address as Address | undefined,
    category: fields.category,
    sourceId: fields.sourceId,
    createdAt: Number(row.createdAt),
    updatedAt: Number(row.updatedAt),
  };
}

export const sealedFields = (place: {
  name: string;
  lat: number;
  lng: number;
  address: Address | undefined;
  category: string | undefined;
  sourceId: string | undefined;
}) => ({
  name: place.name,
  lat: place.lat,
  lng: place.lng,
  ...(place.address ? { address: place.address } : {}),
  ...(place.category ? { category: place.category } : {}),
  ...(place.sourceId ? { sourceId: place.sourceId } : {}),
});

export interface NewPlace {
  /** The device's own id for a place made offline (the same id is the same place, replayed); the server makes one without. */
  readonly id?: string;
  readonly name: string;
  readonly lat: number;
  readonly lng: number;
  readonly address?: Address | undefined;
  readonly category?: string | undefined;
  readonly source?: PlaceSource | undefined;
  readonly sourceId?: string | undefined;
  /** Overrides the zone found from the point. */
  readonly tz?: string | undefined;
}

export type Made =
  { ok: true; place: Place; existing: boolean } | { ok: false; reason: 'id_taken' };

/**
 * Makes a place for an account. Its zone is found from its point (§7.3) unless one is given, and its country code is the address's. **A replay** of the same id by the same account makes
 * nothing twice and answers with the place that is there; an id that belongs to another account's place is `id_taken`, which reads as not found. Throws `PlaceError` for a value that is not a place.
 */
export async function makePlace(
  deps: PlaceDeps,
  accountId: string,
  input: NewPlace,
): Promise<Made> {
  const id = input.id ?? randomUUID();
  if (!PLACE_ID.test(id)) throw new PlaceError('a place id is letters, digits, - and _');
  const name = cleanPlaceName(input.name);
  const { lat, lng } = cleanPoint(input.lat, input.lng);
  const address = cleanAddress(input.address);
  const category = cleanCategory(input.category);
  const source = cleanSource(input.source);
  const sourceId = cleanSourceId(input.sourceId);
  const tz = cleanZone(input.tz) ?? zoneOf(lat, lng) ?? null;
  const countryCode = address?.countryCode ?? null;
  const now = deps.now();
  const sealed = deps.sealer.seal(
    'place',
    id,
    sealedFields({ name, lat, lng, address, category, sourceId }),
  );
  const written = await dbAll<{ id: string }>(
    deps.database,
    sql`INSERT INTO ${table(deps.database)} (id, account_id, source, tz, country_code, version, seq, sealed, created_at, updated_at)
        VALUES (${id}, ${accountId}, ${source}, ${tz}, ${countryCode}, 1, 0, ${sealed}, ${now}, ${now})
        ON CONFLICT (id) DO NOTHING
        RETURNING id`,
  );
  const place = await getPlace(deps, accountId, id);
  if (written.length > 0 && place) return { ok: true, place, existing: false };
  // The id was there already: the same account's place is a replay, another's is not ours to say anything about.
  return place ? { ok: true, place, existing: true } : { ok: false, reason: 'id_taken' };
}

/** One of the account's places, or undefined: the same answer for a place that is another's and one that is not there. */
export async function getPlace(
  deps: Pick<PlaceDeps, 'database' | 'sealer'>,
  accountId: string,
  id: string,
): Promise<Place | undefined> {
  const row = await dbGet<Row>(
    deps.database,
    sql`SELECT ${COLUMNS} FROM ${table(deps.database)} WHERE id = ${id} AND account_id = ${accountId}`,
  );
  return row ? placeOf(deps.sealer, row) : undefined;
}

/** Every place of the account, opened, for a list or a search in memory. */
export async function listPlaces(
  deps: Pick<PlaceDeps, 'database' | 'sealer'>,
  accountId: string,
): Promise<Place[]> {
  const rows = await dbAll<Row>(
    deps.database,
    sql`SELECT ${COLUMNS} FROM ${table(deps.database)} WHERE account_id = ${accountId} ORDER BY created_at, id`,
  );
  return rows.map((row) => placeOf(deps.sealer, row));
}

/** The account's place that is the same as `candidate` (`match.ts`: the same source and id, or the same name within 50 metres), if it has one. */
export async function findPlaceLike(
  deps: Pick<PlaceDeps, 'database' | 'sealer'>,
  accountId: string,
  candidate: { name: string; lat: number; lng: number; source?: string; sourceId?: string },
): Promise<Place | undefined> {
  return findSamePlace(candidate, await listPlaces(deps, accountId));
}

export interface PlacePatch {
  readonly name?: string;
  /** An empty string takes the category away. */
  readonly category?: string;
  readonly address?: Address | null;
  /** A new point. The zone is found again from it, unless `tz` is given too. */
  readonly point?: { readonly lat: number; readonly lng: number };
  readonly tz?: string | null;
}

/**
 * Changes a place of the account: rename, recategorize, move, correct the address or the zone. Returns the place as it is now, or undefined if the account has no such place. **A change is
 * written against the version it was read at**, so two changes at once do not lose one: the second reads again and applies to what is there.
 */
export async function updatePlace(
  deps: PlaceDeps,
  accountId: string,
  id: string,
  patch: PlacePatch,
): Promise<Place | undefined> {
  const name = patch.name === undefined ? undefined : cleanPlaceName(patch.name);
  const point = patch.point ? cleanPoint(patch.point.lat, patch.point.lng) : undefined;
  const category = patch.category === undefined ? undefined : (cleanCategory(patch.category) ?? '');
  const address = patch.address === undefined ? undefined : (cleanAddress(patch.address) ?? null);
  const zone = patch.tz === undefined || patch.tz === null ? undefined : cleanZone(patch.tz);
  for (let attempt = 0; attempt < 5; attempt++) {
    const current = await getPlace(deps, accountId, id);
    if (!current) return undefined;
    const next = {
      name: name ?? current.name,
      lat: point?.lat ?? current.lat,
      lng: point?.lng ?? current.lng,
      address: address === undefined ? current.address : (address ?? undefined),
      category: category === undefined ? current.category : category === '' ? undefined : category,
      sourceId: current.sourceId,
    };
    const tz =
      patch.tz === null
        ? (zoneOf(next.lat, next.lng) ?? null)
        : (zone ?? (point ? (zoneOf(next.lat, next.lng) ?? null) : current.tz));
    const countryCode =
      address === undefined ? current.countryCode : (next.address?.countryCode ?? null);
    const sealed = deps.sealer.seal('place', id, sealedFields(next));
    const done = await dbAll<{ id: string }>(
      deps.database,
      sql`UPDATE ${table(deps.database)}
          SET sealed = ${sealed}, tz = ${tz}, country_code = ${countryCode}, version = ${current.version + 1}, updated_at = ${deps.now()}
          WHERE id = ${id} AND account_id = ${accountId} AND version = ${current.version}
          RETURNING id`,
    );
    if (done.length > 0) return getPlace(deps, accountId, id);
  }
  throw new Error('a place changed too often to be written');
}

export const renamePlace = (deps: PlaceDeps, accountId: string, id: string, name: string) =>
  updatePlace(deps, accountId, id, { name });
export const recategorizePlace = (
  deps: PlaceDeps,
  accountId: string,
  id: string,
  category: string,
) => updatePlace(deps, accountId, id, { category });
export const movePlace = (
  deps: PlaceDeps,
  accountId: string,
  id: string,
  point: { lat: number; lng: number },
) => updatePlace(deps, accountId, id, { point });

export type Merged =
  { ok: true; into: Place; moved: number } | { ok: false; reason: 'not_found' | 'same_place' };

/**
 * Merges the account's place `fromId` into its place `intoId`: every row that names the first names the second, and the first is deleted, in one transaction. What `into` has stays as it is
 * (its name, point and zone). Both must be the account's, or the answer is `not_found` and nothing is changed; a place cannot be merged into itself. Safe to run again: the second time `from`
 * is gone, and so it is `not_found`.
 */
export async function mergePlace(
  deps: PlaceDeps,
  accountId: string,
  fromId: string,
  intoId: string,
  references: readonly PlaceReference[] = PLACE_REFERENCES,
): Promise<Merged> {
  if (fromId === intoId) return { ok: false, reason: 'same_place' };
  return transaction(deps.database, async (tx) => {
    const owned = await dbAll<{ id: string }>(
      tx,
      sql`SELECT id FROM ${table(deps.database)} WHERE account_id = ${accountId} AND id IN (${fromId}, ${intoId})`,
    );
    if (owned.length !== 2) return { ok: false, reason: 'not_found' } as const;
    let moved = 0;
    for (const ref of references) {
      const rows = await dbAll<{ id: string }>(
        tx,
        sql`UPDATE ${qualified(deps.database, ref.table)} SET ${sql.raw(ident(ref.column))} = ${intoId}
            WHERE ${sql.raw(ident(ref.column))} = ${fromId} AND ${sql.raw(ident(ref.ownerColumn))} = ${accountId}
            RETURNING ${sql.raw(ident(ref.column))} AS id`,
      );
      moved += rows.length;
    }
    await dbAll(
      tx,
      sql`DELETE FROM ${table(deps.database)} WHERE id = ${fromId} AND account_id = ${accountId} RETURNING id`,
    );
    const into = await getPlace({ database: tx, sealer: deps.sealer }, accountId, intoId);
    if (!into) throw new Error('a place that was just found is gone');
    return { ok: true, into, moved } as const;
  });
}

export type Deleted = { ok: true } | { ok: false; reason: 'not_found' | 'in_use' };

/**
 * Deletes one of the account's places, **only when nothing points at it**: the statement itself names every table that does (`NOT EXISTS`), so the check and the delete are one statement and
 * not a read followed by a write. A place with check-ins is `in_use`, and is merged into another or left (§20.8); another person's is `not_found`. A check-in written after this names a place
 * that is not there, which the write path of check-ins refuses by naming the place in its own statement (5.1).
 */
export async function deletePlace(
  deps: PlaceDeps,
  accountId: string,
  id: string,
  references: readonly PlaceReference[] = PLACE_REFERENCES,
): Promise<Deleted> {
  const unused = references.map(
    (ref) =>
      sql` AND NOT EXISTS (SELECT 1 FROM ${qualified(deps.database, ref.table)} WHERE ${sql.raw(ident(ref.column))} = ${id} AND ${sql.raw(ident(ref.ownerColumn))} = ${accountId})`,
  );
  const deleted = await dbAll<{ id: string }>(
    deps.database,
    sql`DELETE FROM ${table(deps.database)} WHERE id = ${id} AND account_id = ${accountId}${sql.join(unused, sql``)} RETURNING id`,
  );
  if (deleted.length > 0) return { ok: true };
  return (await getPlace(deps, accountId, id))
    ? { ok: false, reason: 'in_use' }
    : { ok: false, reason: 'not_found' };
}

/** Deletes every place of an account (`People.deletePerson`, in its transaction). Returns how many. */
export async function deletePlacesOf(database: Database, accountId: string): Promise<number> {
  const rows = await dbAll<{ id: string }>(
    database,
    sql`DELETE FROM ${table(database)} WHERE account_id = ${accountId} RETURNING id`,
  );
  return rows.length;
}
