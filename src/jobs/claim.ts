import { type SQL, sql } from 'drizzle-orm';
import type { Database } from '../db/client';
import { dbAll } from '../db/exec';
import * as postgresSchema from '../db/schema/postgres';
import * as sqliteSchema from '../db/schema/sqlite';

/**
 * **The only coordination between processes that share a database** (DESIGN.md §5): a conditional update whose affected rows say whether *this*
 * process won the right to do a piece of work. Only the one whose `UPDATE` returned a row does it, so two processes ticking at once, or a restart
 * that overlaps a stop, cannot do it twice. No lock: a session lock is not allowed through a transaction pooler, and SQLite has none.
 *
 * The statement is the caller's, because what is claimed and when it is free again differs for each job, and it must end in `RETURNING` something
 * (any column): both dialects return the rows an `UPDATE … RETURNING` changed, which is how "did I win" is told without a row count that the
 * two drivers report differently. It must repeat, in its `WHERE`, whatever made the work due: the caller's earlier look at the database may
 * be stale by the time the update runs.
 *
 * ```ts
 * const won = await claim(db, sql`UPDATE account_settings SET last_digest_on = ${today}
 *                                  WHERE account_id = ${id} AND (last_digest_on IS NULL OR last_digest_on < ${today})
 *                                  RETURNING account_id`);
 * ```
 */
export async function claim(database: Database, update: SQL): Promise<boolean> {
  const rows = await dbAll<unknown>(database, update);
  return rows.length > 0;
}

const jobClaimTable = (database: Database) =>
  database.dialect === 'postgres' ? postgresSchema.jobClaim : sqliteSchema.jobClaim;

/**
 * The lease of a job that has no row to claim: free when nobody holds it or the last one has run out, taken for `leaseMs` from `now`, in one
 * statement, so that of any number of processes that ask at once, one is told yes. The lease is a time and not a lock, so a process that is killed holding it
 * costs only the wait until it ends, and nothing is held across a restart.
 */
export async function claimJob(
  database: Database,
  job: string,
  leaseMs: number,
  now: number,
): Promise<boolean> {
  const table = jobClaimTable(database);
  return claim(
    database,
    sql`INSERT INTO ${table} (job, claimed_until) VALUES (${job}, ${now + leaseMs})
        ON CONFLICT (job) DO UPDATE SET claimed_until = ${now + leaseMs}
        WHERE ${table}.claimed_until <= ${now}
        RETURNING job`,
  );
}
