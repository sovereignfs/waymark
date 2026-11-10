import { type SQL, sql } from 'drizzle-orm';
import { type Reason, SENTENCES, parseMutation } from '../checkins/validate';
import type { Sealer } from '../crypto/sealed';
import type { Database } from '../db/client';
import { dbAll, dbGet, transaction } from '../db/exec';
import * as postgresSchema from '../db/schema/postgres';
import * as sqliteSchema from '../db/schema/sqlite';
import { sealedFields } from '../places/places';
import { zoneOf } from '../places/tz';
import type { CheckinRow, PlaceRow } from './format';

/**
 * **Applying a mutation** (DESIGN.md §15.3, §15.5, §18.1): the only way a check-in or a place a device made reaches the server's tables. One short transaction for each mutation:
 *
 *  1. **Once.** The mutation id is recorded first, in the same transaction, and a mutation whose id is already there is a replay that **writes nothing** and says so.
 *  2. **Re-checked.** What a device sent is parsed again with the rules the device ran (`parseMutation`), since the server believes nothing it did not check; every statement names the account, so
 *     a row that is another person's is a row that is not there.
 *  3. **Ordered.** The account's stream counter is increased by the number of changes, in one statement, and each change takes the next number: it is stamped on the row, or on its tombstone, so a
 *     device asks for what is past the last number it saw.
 *  4. **Sealed.** What says where or what (the place's name and point, the note and companions) is written sealed (`SEALED`), and nowhere in the clear.
 *  5. **Whole or not at all.** The first thing wrong with any change refuses the mutation, and nothing it did is kept (the transaction is rolled back, and so is the id): the refusal is a reason
 *     and a sentence the device keeps in Couldn't sync with what the person wrote, for them to fix and send or to discard (§15.5).
 *
 * A change is a whole-row `put`, which makes the row or replaces it (**the edit that reaches the server later stands**, §15.4; one for a row that was deleted restores it), or a `delete`
 * (**both deleted: deleted**; a delete of a row that is not there, or not the person's, does nothing and tells no more than that). A place with a check-in is not deleted, and a check-in must be at a
 * place of the same person's, which may be one made earlier in the same mutation. A place made from a point alone is marked, and named by reverse lookup afterwards by a job (`places/naming.ts`).
 *
 * Nothing here logs a place, a note or a name.
 */
export interface ApplyDeps {
  readonly database: Database;
  readonly sealer: Sealer;
  readonly now: () => number;
}

export type ApplyResult =
  | { readonly status: 'applied'; readonly seq: number; readonly unnamed: readonly string[] }
  | { readonly status: 'replay' }
  | { readonly status: 'refused'; readonly reason: Reason; readonly sentence: string };

/** Thrown inside the transaction to roll it back with a reason. */
class Refused extends Error {
  constructor(readonly reason: Reason) {
    super(reason);
  }
}

const schemaOf = (database: Database) =>
  database.dialect === 'postgres' ? postgresSchema : sqliteSchema;

interface Tables {
  place: SQL;
  checkin: SQL;
  stream: SQL;
  applied: SQL;
  tombstone: SQL;
}
const tablesOf = (database: Database): Tables => {
  const s = schemaOf(database);
  return {
    place: sql`${s.place}`,
    checkin: sql`${s.checkin}`,
    stream: sql`${s.accountStream}`,
    applied: sql`${s.appliedMutation}`,
    tombstone: sql`${s.tombstone}`,
  };
};

interface Existing {
  accountId: string;
  version: number | string;
  createdAt: number | string;
}

export async function applyMutation(
  deps: ApplyDeps,
  accountId: string,
  input: unknown,
): Promise<ApplyResult> {
  const now = deps.now();
  const parsed = parseMutation(input, now);
  if (!parsed.ok) return { status: 'refused', reason: parsed.reason, sentence: parsed.sentence };
  const mutation = parsed.value;
  const t = tablesOf(deps.database);

  try {
    return await transaction(deps.database, async (tx): Promise<ApplyResult> => {
      // 1. Once: the id is taken first, and one that was taken already is a replay.
      const taken = await dbAll<{ id: string }>(
        tx,
        sql`INSERT INTO ${t.applied} (account_id, mutation_id, seq, applied_at)
            VALUES (${accountId}, ${mutation.mutationId}, 0, ${now})
            ON CONFLICT (account_id, mutation_id) DO NOTHING
            RETURNING mutation_id AS id`,
      );
      if (taken.length === 0) return { status: 'replay' };

      // 3. Ordered: one statement takes a number for each change, and no other transaction can take the same ones.
      const count = mutation.changes.length;
      const counted = await dbGet<{ seq: number | string }>(
        tx,
        sql`INSERT INTO ${t.stream} AS s (account_id, seq) VALUES (${accountId}, ${count})
            ON CONFLICT (account_id) DO UPDATE SET seq = s.seq + ${count}
            RETURNING seq`,
      );
      const last = Number(counted?.seq);
      const first = last - count + 1;
      const unnamed: string[] = [];

      for (const [index, change] of mutation.changes.entries()) {
        const seq = first + index;
        if (change.table === 'place' && change.op === 'put') {
          await putPlace(tx, deps, t, accountId, change.id, change.row, seq, now);
          if (change.row.unnamed) unnamed.push(change.id);
        } else if (change.table === 'checkin' && change.op === 'put') {
          await putCheckin(tx, deps, t, accountId, change.id, change.row, seq, now);
        } else if (change.table === 'place') {
          await deleteRow(tx, t, 'place', accountId, change.id, seq, now);
        } else {
          await deleteRow(tx, t, 'checkin', accountId, change.id, seq, now);
        }
      }
      await dbAll(
        tx,
        sql`UPDATE ${t.applied} SET seq = ${last}
            WHERE account_id = ${accountId} AND mutation_id = ${mutation.mutationId}
            RETURNING mutation_id`,
      );
      return { status: 'applied', seq: last, unnamed };
    });
  } catch (error) {
    if (error instanceof Refused)
      return { status: 'refused', reason: error.reason, sentence: SENTENCES[error.reason] };
    throw error;
  }
}

/** A row's tombstone goes when the row is made again under its id, so that a device does not delete what was restored. */
const clearTombstone = (tx: Database, t: Tables, accountId: string, table: string, id: string) =>
  dbAll(
    tx,
    sql`DELETE FROM ${t.tombstone} WHERE account_id = ${accountId} AND table_name = ${table} AND row_id = ${id} RETURNING row_id`,
  );

async function putPlace(
  tx: Database,
  deps: ApplyDeps,
  t: Tables,
  accountId: string,
  id: string,
  row: PlaceRow,
  seq: number,
  now: number,
): Promise<void> {
  const existing = await dbGet<Existing>(
    tx,
    sql`SELECT account_id AS "accountId", version, created_at AS "createdAt" FROM ${t.place} WHERE id = ${id}`,
  );
  // Another person's id is not found, and says no more.
  if (existing && existing.accountId !== accountId) throw new Refused('missing');
  const sealed = deps.sealer.seal(
    'place',
    id,
    sealedFields({
      name: row.name,
      lat: row.lat,
      lng: row.lng,
      address: row.address,
      category: row.category,
      sourceId: row.sourceId,
    }),
  );
  const tz = row.tz ?? zoneOf(row.lat, row.lng) ?? null;
  const countryCode = row.address?.countryCode ?? null;
  const unnamed = row.unnamed ? 1 : 0;
  if (existing) {
    await dbAll(
      tx,
      sql`UPDATE ${t.place}
          SET sealed = ${sealed}, source = ${row.source}, tz = ${tz}, country_code = ${countryCode}, unnamed = ${unnamed},
              version = ${Number(existing.version) + 1}, seq = ${seq}, updated_at = ${now}
          WHERE id = ${id} AND account_id = ${accountId}
          RETURNING id`,
    );
  } else {
    await dbAll(
      tx,
      sql`INSERT INTO ${t.place} (id, account_id, source, tz, country_code, version, seq, unnamed, sealed, created_at, updated_at)
          VALUES (${id}, ${accountId}, ${row.source}, ${tz}, ${countryCode}, 1, ${seq}, ${unnamed}, ${sealed}, ${now}, ${now})
          RETURNING id`,
    );
  }
  await clearTombstone(tx, t, accountId, 'place', id);
}

async function putCheckin(
  tx: Database,
  deps: ApplyDeps,
  t: Tables,
  accountId: string,
  id: string,
  row: CheckinRow,
  seq: number,
  now: number,
): Promise<void> {
  // At a place of the same person's: one that is not there, or is someone else's, is the same answer.
  const place = await dbGet<{ id: string }>(
    tx,
    sql`SELECT id FROM ${t.place} WHERE id = ${row.placeId} AND account_id = ${accountId}`,
  );
  if (!place) throw new Refused('place_missing');
  const existing = await dbGet<Existing>(
    tx,
    sql`SELECT account_id AS "accountId", version, created_at AS "createdAt" FROM ${t.checkin} WHERE id = ${id}`,
  );
  if (existing && existing.accountId !== accountId) throw new Refused('missing');
  // The import's own id is unique for an account: importing again adds nothing twice.
  if (row.externalId !== undefined) {
    const same = await dbGet<{ id: string }>(
      tx,
      sql`SELECT id FROM ${t.checkin} WHERE account_id = ${accountId} AND external_id = ${row.externalId}`,
    );
    if (same && same.id !== id) throw new Refused('duplicate');
  }
  const sealed = deps.sealer.seal('checkin', id, {
    ...(row.note ? { note: row.note } : {}),
    ...(row.companions.length > 0 ? { companions: [...row.companions] } : {}),
  });
  if (existing) {
    await dbAll(
      tx,
      sql`UPDATE ${t.checkin}
          SET place_id = ${row.placeId}, at = ${row.at}, tz = ${row.tz}, offset_min = ${row.offsetMin}, trip_id = ${row.tripId},
              link_source = ${row.linkSource}, share = ${row.share}, source = ${row.source}, external_id = ${row.externalId ?? null},
              sealed = ${sealed}, version = ${Number(existing.version) + 1}, seq = ${seq}, updated_at = ${now}
          WHERE id = ${id} AND account_id = ${accountId}
          RETURNING id`,
    );
  } else {
    await dbAll(
      tx,
      sql`INSERT INTO ${t.checkin} (id, account_id, place_id, at, tz, offset_min, trip_id, link_source, share, source, external_id, version, seq, sealed, created_at, updated_at)
          VALUES (${id}, ${accountId}, ${row.placeId}, ${row.at}, ${row.tz}, ${row.offsetMin}, ${row.tripId}, ${row.linkSource}, ${row.share},
                  ${row.source}, ${row.externalId ?? null}, 1, ${seq}, ${sealed}, ${now}, ${now})
          RETURNING id`,
    );
  }
  await clearTombstone(tx, t, accountId, 'checkin', id);
}

async function deleteRow(
  tx: Database,
  t: Tables,
  table: 'place' | 'checkin',
  accountId: string,
  id: string,
  seq: number,
  now: number,
): Promise<void> {
  // A place is deleted in the statement that finds nothing at it, so a check-in cannot slip in between a look and the delete.
  const deleted = await dbAll<{ id: string }>(
    tx,
    table === 'checkin'
      ? sql`DELETE FROM ${t.checkin} WHERE id = ${id} AND account_id = ${accountId} RETURNING id`
      : sql`DELETE FROM ${t.place}
            WHERE id = ${id} AND account_id = ${accountId}
              AND NOT EXISTS (SELECT 1 FROM ${t.checkin} WHERE place_id = ${id} AND account_id = ${accountId})
            RETURNING id`,
  );
  if (deleted.length === 0) {
    if (table === 'place') {
      const mine = await dbGet<{ id: string }>(
        tx,
        sql`SELECT id FROM ${t.place} WHERE id = ${id} AND account_id = ${accountId}`,
      );
      // It is there and has check-ins: the person is told. Otherwise it is not theirs or not there, and deleting it again is nothing.
      if (mine) throw new Refused('in_use');
    }
    return;
  }
  await dbAll(
    tx,
    sql`INSERT INTO ${t.tombstone} (account_id, table_name, row_id, seq, deleted_at)
        VALUES (${accountId}, ${table}, ${id}, ${seq}, ${now})
        ON CONFLICT (account_id, table_name, row_id) DO UPDATE SET seq = excluded.seq, deleted_at = excluded.deleted_at
        RETURNING row_id`,
  );
}
