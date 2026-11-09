import { sql } from 'drizzle-orm';
import type { Database } from '../db/client';
import { dbGet } from '../db/exec';
import * as postgresAuth from '../db/schema/postgres/auth';
import * as sqliteAuth from '../db/schema/sqlite/auth';

/** How many accounts there are. The sign-up policy and the sign-up page both ask. */
export async function countUsers(database: Database): Promise<number> {
  const table = database.dialect === 'postgres' ? postgresAuth.user : sqliteAuth.user;
  const row = await dbGet<{ n: number | string }>(
    database,
    sql`SELECT COUNT(*) AS n FROM ${table}`,
  );
  return Number(row?.n ?? 0);
}
