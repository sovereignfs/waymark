import { sql } from 'drizzle-orm';
import type { Database } from '../db/client';
import { dbAll, dbGet } from '../db/exec';
import * as postgresAuth from '../db/schema/postgres/auth';
import * as sqliteAuth from '../db/schema/sqlite/auth';
import { SOVEREIGN_PROVIDER_ID } from '../auth/config';

/**
 * A Sovereign identity is its `sub`, kept as the `account_id` of a sign-in row whose provider is Sovereign (DESIGN.md §19.1): it is looked up only for what needs
 * it, which is a notice from core (§19.2). The account it belongs to is the row's `user_id`, which is what everything of a person is owned by.
 */
const tables = (database: Database) =>
  database.dialect === 'postgres' ? postgresAuth : sqliteAuth;

/** The account a Sovereign identity is linked to, or null: nobody here has signed in with it (or the account has since been deleted). */
export async function accountOfSub(authDatabase: Database, sub: string): Promise<string | null> {
  const auth = tables(authDatabase);
  const row = await dbGet<{ user_id: string }>(
    authDatabase,
    sql`SELECT user_id FROM ${auth.account} WHERE provider_id = ${SOVEREIGN_PROVIDER_ID} AND account_id = ${sub}`,
  );
  return row?.user_id ?? null;
}

/** The `sub` an account is linked to on the core, or null when it signed in another way: where a notification to the person is addressed. */
export async function subOfAccount(
  authDatabase: Database,
  accountId: string,
): Promise<string | null> {
  const auth = tables(authDatabase);
  const row = await dbGet<{ account_id: string }>(
    authDatabase,
    sql`SELECT account_id FROM ${auth.account} WHERE provider_id = ${SOVEREIGN_PROVIDER_ID} AND user_id = ${accountId}`,
  );
  return row?.account_id ?? null;
}

/** Ends every session an account has, on every device, and says how many there were. Running it again ends none and fails at nothing. */
export async function endSessionsOf(authDatabase: Database, accountId: string): Promise<number> {
  const auth = tables(authDatabase);
  const ended = await dbAll(
    authDatabase,
    sql`DELETE FROM ${auth.session} WHERE user_id = ${accountId} RETURNING id`,
  );
  return ended.length;
}
