import { sql } from 'drizzle-orm';
import type { Database } from '../db/client';
import { dbAll, dbGet, transaction } from '../db/exec';
import * as postgresSchema from '../db/schema/postgres';
import * as sqliteSchema from '../db/schema/sqlite';
import { removeFile } from '../media/files';
import { type MediaDeps, deleteMediaOf } from '../media/service';
import { deleteImportsOf, importDirBeside } from '../import/service';
import { deleteExportsOf, exportDirBeside } from '../portability/export';
import { deleteMailOf } from '../mail/outbox';
import { deleteCoreOf, enqueueCore } from './outbox';
import type { Sealer } from '../crypto/sealed';
import { deleteNoticesOf } from '../notices/notices';
import { deletePrefsOf } from '../notices/prefs';
import { deletePushOf } from '../push/subscriptions';
import { deletePlacesOf } from '../places/places';
import { type Delivery } from '../notices/notices';
import { endMembershipsOf } from '../trips/people';

/**
 * **Everything of an account is deleted by this, and only this** (DESIGN.md §23). One routine, in a fixed order, **safe to run again**: the two stores (the app's and the
 * sign-in store) cannot share a transaction, and files are not in a database at all, so a run that stopped part way is finished by running it again, and the row that makes the
 * account findable (the account itself, and later the link to a Sovereign identity) goes **last**, so that a run that stopped can still find it.
 *
 *  1. Their files: every file under `/data/media`, and then its row (`deleteMediaOf`: the files first, so that rows that name a file still there are found again); and their uploaded imports under `/data/imports`.
 *  2. What the app keeps of them in its store, in one transaction: their profile, their check-ins and places, what orders them (the stream's counter, the mutations applied and the
 *     tombstones), and their rate counters, and their part in trips (`endMembershipsOf`: handing a trip on, deleting an empty one, clearing what names them).
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
  /** To tell a member that a trip has passed to them (`organizer_passed`, DESIGN.md §23): the instance key and how notices reach people here. Without it a trip still passes, and nobody is told. */
  readonly notices?: { readonly sealer: Sealer; readonly delivery: () => Delivery } | undefined;
  /**
   * Present where the person deleted their account **from Waymark** and the people here sign in through a core: a line about it is left on their activity page there (DESIGN.md §19.4). It names the `sub` and no
   * account, since the account is going, so it is made after they are gone. Absent when the deletion came from the core, which knows.
   */
  readonly core?: {
    readonly sealer: Sealer;
    readonly subOf: (accountId: string) => Promise<string | undefined>;
  };
}

export interface Deleted {
  readonly files: number;
}

const appSchema = (database: Database) =>
  database.dialect === 'postgres' ? postgresSchema : sqliteSchema;

export async function deletePerson(deps: PeopleDeps, accountId: string): Promise<Deleted> {
  const { database, authDatabase } = deps;
  const app = appSchema(database);
  // Who they are at the core, while the link to it still exists.
  const sub = deps.core ? await deps.core.subOf(accountId) : undefined;

  // 1. Files, and then their rows.
  const files = await deleteMediaOf({ ...deps.media, database }, accountId);
  // Their uploaded imports, the files and then the rows.
  await deleteImportsOf({ database, dir: importDirBeside(deps.media.dir) }, accountId);
  // And the exports they asked for, the files and then the rows.
  await deleteExportsOf({ database, dir: exportDirBeside(deps.media.dir) }, accountId);

  // 2. What the app keeps of them, in one transaction of the app's store.
  let tripFiles: string[] = [];
  await transaction(database, async (tx) => {
    await dbAll(
      tx,
      sql`DELETE FROM ${app.profile} WHERE account_id = ${accountId} RETURNING account_id`,
    );
    // Their part in trips (DESIGN.md §11.4, §23): a trip with nobody else is deleted, one they alone organized passes on, and nothing keeps pointing at them. Before their own rows, so that what a deleted trip held is gone first.
    tripFiles = await endMembershipsOf(tx, { now: deps.now, notices: deps.notices }, accountId);
    // Their check-ins and places (a trip's places are the trip's, and go with it, §23), and what orders them: the stream, the mutations applied and the tombstones.
    await dbAll(tx, sql`DELETE FROM ${app.checkin} WHERE account_id = ${accountId} RETURNING id`);
    await dbAll(
      tx,
      sql`DELETE FROM ${app.checkinPhoto} WHERE account_id = ${accountId} RETURNING id`,
    );
    await deletePlacesOf(tx, accountId);
    // What they were told.
    await deleteNoticesOf(tx, accountId);
    await deletePrefsOf(tx, accountId);
    await deletePushOf(tx, accountId);
    // And the mail queued to them.
    await deleteMailOf(tx, accountId);
    await deleteCoreOf(tx, accountId);
    await dbAll(
      tx,
      sql`DELETE FROM ${app.accountStream} WHERE account_id = ${accountId} RETURNING account_id`,
    );
    await dbAll(
      tx,
      sql`DELETE FROM ${app.appliedMutation} WHERE account_id = ${accountId} RETURNING mutation_id`,
    );
    await dbAll(
      tx,
      sql`DELETE FROM ${app.tombstone} WHERE account_id = ${accountId} RETURNING row_id`,
    );
    // Counters are keyed `kind:account`.
    await dbAll(
      tx,
      sql`DELETE FROM ${app.rateBucket} WHERE "key" LIKE ${`%:${accountId}`} RETURNING "key"`,
    );
  });

  // The files of a trip that went with them (attachments): after the rows, as a trip's deletion does.
  for (const file of tripFiles) await removeFile(deps.media.dir, file);

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

  // The line is queued last, once everything of them is gone, and names the sub: it is not deleted with the account it was about.
  if (deps.core && sub)
    await enqueueCore(database, deps.core.sealer, deps.now(), {
      kind: 'activity',
      content: { title: 'Deleted your Waymark account', sub, key: `deleted:${sub}` },
    });

  return { files };
}
