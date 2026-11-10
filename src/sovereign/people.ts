import { sql } from 'drizzle-orm';
import type { Database } from '../db/client';
import { dbAll, dbGet, transaction } from '../db/exec';
import * as postgresSchema from '../db/schema/postgres';
import * as sqliteSchema from '../db/schema/sqlite';
import { type MediaDeps, deleteMediaOf } from '../media/service';
import { deletePlacesOf } from '../places/places';

/**
 * **Everything of an account is deleted by this, and only this** (DESIGN.md §23). One routine, in a fixed order, **safe to run again**: the two stores (the app's and the
 * sign-in store) cannot share a transaction, and files are not in a database at all, so a run that stopped part way is finished by running it again, and the row that makes the
 * account findable (the account itself, and later the link to a Sovereign identity) goes **last**, so that a run that stopped can still find it.
 *
 *  1. Their files: every file under `/data/media`, and then its row (`deleteMediaOf`: the files first, so that rows that name a file still there are found again).
 *  2. What the app keeps of them in its store, in one transaction: their profile and their rate counters. (Places, check-ins, import jobs, notices, settings, mail queued to them and
 *     the rest join here with the tasks that make their tables; the trip rules, handing a trip on or deleting an empty one and clearing `created_by`, with 10.4.)
 *  3. The sign-in store: sessions, sign-ins (password, passkeys, second factors and later a Sovereign identity), pending verifications, and then the account.
 *
 * `people.test.ts` seeds a row in every table for the person and for a second person, finds nothing of the first after, and the second's intact, and **fails for a table that is in
 * none of its lists**: a new table that holds something of a person is deleted here, in the same change as the table.
 */
export interface PeopleDeps {
  /** The app's store. */
  readonly database: Database;
  /** The sign-in store (the same database as the app's, or another). */
  readonly authDatabase: Database;
  /** The media store, whose files go with the person. */
  readonly media: MediaDeps;
  readonly now: () => number;
}

export interface Deleted {
  readonly files: number;
}

const appSchema = (database: Database) =>
  database.dialect === 'postgres' ? postgresSchema : sqliteSchema;

export async function deletePerson(deps: PeopleDeps, accountId: string): Promise<Deleted> {
  const { database, authDatabase } = deps;
  const app = appSchema(database);

  // 1. Files, and then their rows.
  const files = await deleteMediaOf({ ...deps.media, database }, accountId);

  // 2. What the app keeps of them, in one transaction of the app's store.
  await transaction(database, async (tx) => {
    await dbAll(
      tx,
      sql`DELETE FROM ${app.profile} WHERE account_id = ${accountId} RETURNING account_id`,
    );
    // Their places (a trip's are the trip's, and go with it, §23).
    await deletePlacesOf(tx, accountId);
    // Counters are keyed `kind:account`.
    await dbAll(
      tx,
      sql`DELETE FROM ${app.rateBucket} WHERE "key" LIKE ${`%:${accountId}`} RETURNING "key"`,
    );
  });

  // 3. The sign-in store. The address is read first, for the verifications that are named by it; the account goes last.
  const auth = authDatabase.dialect === 'postgres' ? postgresSchema : sqliteSchema;
  const user = await dbGet<{ email: string }>(
    authDatabase,
    sql`SELECT email FROM ${auth.user} WHERE id = ${accountId}`,
  );
  await dbAll(
    authDatabase,
    sql`DELETE FROM ${auth.session} WHERE user_id = ${accountId} RETURNING id`,
  );
  await dbAll(
    authDatabase,
    sql`DELETE FROM ${auth.account} WHERE user_id = ${accountId} RETURNING id`,
  );
  // Second factors and passkeys, before the account they belong to, by name and not by what the store cascades.
  await dbAll(
    authDatabase,
    sql`DELETE FROM ${auth.twoFactor} WHERE user_id = ${accountId} RETURNING id`,
  );
  await dbAll(
    authDatabase,
    sql`DELETE FROM ${auth.passkey} WHERE user_id = ${accountId} RETURNING id`,
  );
  if (user)
    await dbAll(
      authDatabase,
      sql`DELETE FROM ${auth.verification} WHERE LOWER(identifier) = ${user.email.toLowerCase()} RETURNING id`,
    );
  await dbAll(authDatabase, sql`DELETE FROM ${auth.user} WHERE id = ${accountId} RETURNING id`);

  return { files };
}
