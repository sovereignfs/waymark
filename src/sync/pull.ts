import { sql } from 'drizzle-orm';
import type { Sealer } from '../crypto/sealed';
import type { Database } from '../db/client';
import { dbAll, dbGet } from '../db/exec';
import * as postgresSchema from '../db/schema/postgres';
import * as sqliteSchema from '../db/schema/sqlite';
import type { Address } from '../places/clean';
import type { CheckinRow, PlaceRow, SyncTable } from './format';

/**
 * **Pull** (DESIGN.md §15.3): what changed in a person's own stream past a cursor, **in order, unsealed for the account and no one else**. Every statement names the account, so a second person's rows
 * cannot appear. The order is the stream's numbers: each change took a number of its own (`apply.ts`), so no two rows, and no row and tombstone, share one, and a page is cut at the last number it
 * holds with nothing past it left behind. A device that asks with cursor 0 gets everything, as a snapshot, a page at a time; one that asks with a cursor it had gets what changed since.
 *
 * A row is sent whole (it is what the later edit made it); a deleted row is a tombstone with its table and id and no content.
 */
export interface PlaceRecord extends PlaceRow {
  readonly id: string;
  readonly version: number;
  readonly seq: number;
}
export interface CheckinRecord extends CheckinRow {
  readonly id: string;
  readonly version: number;
  readonly seq: number;
}
export interface Gone {
  readonly table: SyncTable;
  readonly id: string;
  readonly seq: number;
}

export interface Page {
  /** In the order of the stream. */
  readonly places: PlaceRecord[];
  readonly checkins: CheckinRecord[];
  readonly deleted: Gone[];
  /** Where the device is now: the number of the last change in this page, or the cursor it had if there was none. */
  readonly cursor: number;
  /** Whether there is more past `cursor`: the device asks again at once. */
  readonly more: boolean;
  /** The stream's own number now, so that a device can tell it has caught up. */
  readonly head: number;
  /** The stream's floor now (`history.ts`): what a device sends back as the floor it has seen. */
  readonly floor: number;
  /**
   * True when this page begins **a fresh snapshot**: the device had not heard of the stream since before tombstones were pruned, so it may have missed a delete, and is given everything again from the
   * start. It **clears its rows before it applies the page**, and goes on from the cursor as usual (§15.8).
   */
  readonly reset: boolean;
}

export interface PullDeps {
  readonly database: Database;
  readonly sealer: Sealer;
}

export const DEFAULT_PAGE = 200;
export const MAX_PAGE = 500;

const schemaOf = (database: Database) =>
  database.dialect === 'postgres' ? postgresSchema : sqliteSchema;
const bytes = (value: Uint8Array | ArrayBuffer) =>
  value instanceof Uint8Array ? value : new Uint8Array(value);

type Item =
  | { seq: number; kind: 'place'; record: PlaceRecord }
  | { seq: number; kind: 'checkin'; record: CheckinRecord }
  | { seq: number; kind: 'gone'; record: Gone };

export async function pullAccount(
  deps: PullDeps,
  accountId: string,
  askedCursor: number,
  limit: number = DEFAULT_PAGE,
  /** The floor the device has seen (0 for one that has not): lower than the stream's means a snapshot from the start. */
  seenFloor = 0,
): Promise<Page> {
  const s = schemaOf(deps.database);
  const take = Math.min(Math.max(1, Math.floor(limit)), MAX_PAGE);
  const stream = await dbGet<{ seq: number | string; floor: number | string }>(
    deps.database,
    sql`SELECT seq, floor FROM ${s.accountStream} WHERE account_id = ${accountId}`,
  );
  const floor = Number(stream?.floor ?? 0);
  // A device that is behind the floor is given the stream from its start, whatever its cursor said.
  const reset = seenFloor < floor;
  const cursor = reset ? 0 : askedCursor;
  const items: Item[] = [];

  const places = await dbAll<{
    id: string;
    source: string;
    tz: string | null;
    countryCode: string | null;
    version: number | string;
    seq: number | string;
    sealed: Uint8Array | ArrayBuffer;
  }>(
    deps.database,
    sql`SELECT id, source, tz, country_code AS "countryCode", version, seq, sealed FROM ${s.place}
        WHERE account_id = ${accountId} AND seq > ${cursor} ORDER BY seq LIMIT ${take + 1}`,
  );
  for (const row of places) {
    const fields = deps.sealer.unseal('place', row.id, bytes(row.sealed));
    items.push({
      seq: Number(row.seq),
      kind: 'place',
      record: {
        id: row.id,
        version: Number(row.version),
        seq: Number(row.seq),
        name: fields.name,
        lat: fields.lat,
        lng: fields.lng,
        ...(fields.address ? { address: fields.address as Address } : {}),
        ...(fields.category ? { category: fields.category } : {}),
        ...(fields.sourceId ? { sourceId: fields.sourceId } : {}),
        source: row.source as PlaceRow['source'],
        tz: row.tz,
        countryCode: row.countryCode,
      },
    });
  }

  const checkins = await dbAll<{
    id: string;
    placeId: string;
    at: number | string;
    tz: string;
    offsetMin: number | string;
    tripId: string | null;
    linkSource: string | null;
    share: string;
    source: string;
    externalId: string | null;
    version: number | string;
    seq: number | string;
    sealed: Uint8Array | ArrayBuffer;
  }>(
    deps.database,
    sql`SELECT id, place_id AS "placeId", at, tz, offset_min AS "offsetMin", trip_id AS "tripId", link_source AS "linkSource", share, source,
               external_id AS "externalId", version, seq, sealed
        FROM ${s.checkin} WHERE account_id = ${accountId} AND seq > ${cursor} ORDER BY seq LIMIT ${take + 1}`,
  );
  // The photos of the check-ins in this page, in order: one query, not one for each.
  const photosOf = new Map<string, string[]>();
  for (const row of checkins.slice(0, take)) {
    const photos = await dbAll<{ id: string }>(
      deps.database,
      sql`SELECT id FROM ${s.checkinPhoto} WHERE checkin_id = ${row.id} AND account_id = ${accountId} ORDER BY position`,
    );
    if (photos.length > 0)
      photosOf.set(
        row.id,
        photos.map((photo) => photo.id),
      );
  }
  for (const row of checkins) {
    const fields = deps.sealer.unseal('checkin', row.id, bytes(row.sealed));
    const photos = photosOf.get(row.id);
    items.push({
      seq: Number(row.seq),
      kind: 'checkin',
      record: {
        id: row.id,
        version: Number(row.version),
        seq: Number(row.seq),
        placeId: row.placeId,
        at: Number(row.at),
        tz: row.tz,
        offsetMin: Number(row.offsetMin),
        ...(fields.note ? { note: fields.note } : {}),
        companions: fields.companions ?? [],
        tripId: row.tripId,
        linkSource: row.linkSource as CheckinRow['linkSource'],
        share: row.share as CheckinRow['share'],
        source: row.source as CheckinRow['source'],
        ...(photos ? { photos } : {}),
        ...(row.externalId ? { externalId: row.externalId } : {}),
      },
    });
  }

  const gone = await dbAll<{ tableName: string; rowId: string; seq: number | string }>(
    deps.database,
    sql`SELECT table_name AS "tableName", row_id AS "rowId", seq FROM ${s.tombstone}
        WHERE account_id = ${accountId} AND seq > ${cursor} ORDER BY seq LIMIT ${take + 1}`,
  );
  for (const row of gone)
    items.push({
      seq: Number(row.seq),
      kind: 'gone',
      record: { table: row.tableName as SyncTable, id: row.rowId, seq: Number(row.seq) },
    });

  items.sort((a, b) => a.seq - b.seq);
  const page = items.slice(0, take);
  const last = page.at(-1)?.seq ?? cursor;
  return {
    places: page.flatMap((item) => (item.kind === 'place' ? [item.record] : [])),
    checkins: page.flatMap((item) => (item.kind === 'checkin' ? [item.record] : [])),
    deleted: page.flatMap((item) => (item.kind === 'gone' ? [item.record] : [])),
    cursor: last,
    more: items.length > take,
    head: Number(stream?.seq ?? 0),
    floor,
    reset,
  };
}
