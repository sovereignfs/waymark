import { sql } from 'drizzle-orm';
import type { Sealer } from '../crypto/sealed';
import type { Database } from '../db/client';
import { dbAll, dbGet, transaction } from '../db/exec';
import * as postgresSchema from '../db/schema/postgres';
import * as sqliteSchema from '../db/schema/sqlite';
import { claimJob } from '../jobs/claim';
import type { PlaceFinder } from './finder';
import { type Place, getPlace, sealedFields } from './places';

/**
 * Naming the places that were made from a point alone (DESIGN.md §9.2): a GPS check-in with no network is saved at "A place near 38.7223, -9.1393", and **this names it by reverse lookup once it has
 * reached the server**, where the person can still rename it. The place is marked (`place.unnamed`, 1 or more: the tries made, plus one), and a job looks at the marked ones, a few at a time,
 * under a lease so that of several processes one does.
 *
 *  - A name found is written **through the stream**, as any change to a person's row is: the account's counter takes a number, the row's `version` and `seq` change, so that every device of the
 *    person pulls the new name. It is written only to a place that is still marked, so **a name the person typed in the meantime stands** (their edit cleared the mark).
 *  - Nothing found there, or no place search at all, leaves the name as it is and stops asking.
 *  - A search that is not reachable is tried again at the next run, up to six times in all, and then left as it is.
 *
 * Nothing here logs a place, a name or a point.
 */
export const MAX_TRIES = 6;
const BATCH = 10;

const schemaOf = (database: Database) =>
  database.dialect === 'postgres' ? postgresSchema : sqliteSchema;

export interface NamingDeps {
  readonly database: Database;
  readonly sealer: Sealer;
  readonly finder: Pick<PlaceFinder, 'reverse'>;
  readonly now: () => number;
}

/** The places waiting to be named, oldest first, with what is needed to ask for each. */
async function waiting(
  database: Database,
): Promise<{ id: string; accountId: string; unnamed: number }[]> {
  const s = schemaOf(database);
  const rows = await dbAll<{ id: string; accountId: string; unnamed: number | string }>(
    database,
    sql`SELECT id, account_id AS "accountId", unnamed FROM ${s.place} WHERE unnamed > 0 ORDER BY updated_at, id LIMIT ${BATCH}`,
  );
  return rows.map((row) => ({ ...row, unnamed: Number(row.unnamed) }));
}

/** Writes what reverse lookup found as the place's own, in the stream, if the place is still waiting for it. Returns whether it was. */
async function name(
  deps: NamingDeps,
  place: Place,
  found: { name: string; address?: Place['address']; category?: string; sourceId: string },
): Promise<boolean> {
  const s = schemaOf(deps.database);
  const sealed = deps.sealer.seal(
    'place',
    place.id,
    sealedFields({
      name: found.name,
      lat: place.lat,
      lng: place.lng,
      address: found.address ?? place.address,
      category: found.category ?? place.category,
      sourceId: found.sourceId,
    }),
  );
  return transaction(deps.database, async (tx) => {
    const counted = await dbGet<{ seq: number | string }>(
      tx,
      sql`INSERT INTO ${s.accountStream} AS s (account_id, seq) VALUES (${place.accountId}, 1)
          ON CONFLICT (account_id) DO UPDATE SET seq = s.seq + 1
          RETURNING seq`,
    );
    const changed = await dbAll<{ id: string }>(
      tx,
      sql`UPDATE ${s.place}
          SET sealed = ${sealed}, source = 'osm', country_code = ${found.address?.countryCode ?? place.countryCode ?? null}, unnamed = 0,
              version = version + 1, seq = ${Number(counted?.seq)}, updated_at = ${deps.now()}
          WHERE id = ${place.id} AND account_id = ${place.accountId} AND unnamed > 0
          RETURNING id`,
    );
    // A person who named it meanwhile cleared the mark, and keeps their name: the number taken is spent for nothing, which a stream allows.
    return changed.length > 0;
  });
}

/** Records that a place was asked about: one more try, or no more asking. */
async function tried(
  deps: NamingDeps,
  id: string,
  accountId: string,
  stop: boolean,
): Promise<void> {
  const s = schemaOf(deps.database);
  await dbAll(
    deps.database,
    stop
      ? sql`UPDATE ${s.place} SET unnamed = 0 WHERE id = ${id} AND account_id = ${accountId} AND unnamed > 0 RETURNING id`
      : sql`UPDATE ${s.place} SET unnamed = unnamed + 1 WHERE id = ${id} AND account_id = ${accountId} AND unnamed > 0 RETURNING id`,
  );
}

/**
 * One run of the job: takes the lease, and names up to ten of the places that wait. Returns how many it named. A run that cannot have the lease does nothing, since another process has it.
 */
export async function nameWaitingPlaces(deps: NamingDeps): Promise<number> {
  if (!(await claimJob(deps.database, 'name-places', 50_000, Date.now()))) return 0;
  let named = 0;
  for (const each of await waiting(deps.database)) {
    const place = await getPlace(deps, each.accountId, each.id);
    if (!place) continue;
    const found = await deps.finder.reverse(place.lat, place.lng);
    if (found.status === 'ok' && found.candidate) {
      if (await name(deps, place, found.candidate)) named++;
    } else if (found.status === 'ok' || found.status === 'off') {
      // Nothing is known at the point, or there is no place search to ask: the name stays, and so does the person's chance to rename it.
      await tried(deps, each.id, each.accountId, true);
    } else {
      await tried(deps, each.id, each.accountId, each.unnamed >= MAX_TRIES);
    }
  }
  return named;
}
