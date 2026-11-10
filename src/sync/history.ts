import { sql } from 'drizzle-orm';
import type { Database } from '../db/client';
import { dbAll, transaction } from '../db/exec';
import * as postgresSchema from '../db/schema/postgres';
import * as sqliteSchema from '../db/schema/sqlite';

/**
 * **Keeping the history small** (DESIGN.md §15.8): tombstones and the record of applied mutations are what lets a device that was away learn what was deleted and lets a retry be told from a new
 * mutation, and neither grows for ever. After **90 days** they go.
 *
 *  - A **tombstone** that goes raises the stream's **floor** to its number, in the same transaction, so a device that has not heard of the stream since before it (a cursor older than the floor) is
 *    **sent its outbox and then given a fresh snapshot** (`pull.ts`): it may have missed a delete, and the snapshot is the whole truth. Nothing it recorded is lost: the outbox is applied first.
 *  - An **applied-mutation record** that goes means a mutation older than 90 days, sent again, is applied as new: a put of a whole row says what the row is, so that is the same row again, and the
 *    outbox of a device that was away for three months is the person's own work, to be kept before it is trusted to be stale.
 *
 * It runs under a lease (`claimJob`), so that of several processes one does, and removes only what is already of no use.
 */
export const KEEP_MS = 90 * 24 * 60 * 60 * 1000;

const schemaOf = (database: Database) =>
  database.dialect === 'postgres' ? postgresSchema : sqliteSchema;

export interface Pruned {
  readonly tombstones: number;
  readonly mutations: number;
  /** The accounts whose floor rose. */
  readonly raised: number;
}

export async function pruneHistory(
  database: Database,
  now: number,
  keepMs = KEEP_MS,
): Promise<Pruned> {
  const s = schemaOf(database);
  const cutoff = now - keepMs;
  return transaction(database, async (tx) => {
    // The floor first, from what is about to go: the highest number of an old tombstone, for each account.
    const old = await dbAll<{ accountId: string; top: number | string }>(
      tx,
      sql`SELECT account_id AS "accountId", MAX(seq) AS top FROM ${s.tombstone} WHERE deleted_at < ${cutoff} GROUP BY account_id`,
    );
    let raised = 0;
    for (const row of old) {
      const top = Number(row.top);
      const changed = await dbAll<{ accountId: string }>(
        tx,
        sql`UPDATE ${s.accountStream} SET floor = ${top} WHERE account_id = ${row.accountId} AND floor < ${top} RETURNING account_id AS "accountId"`,
      );
      raised += changed.length;
    }
    const tombstones = await dbAll<{ id: string }>(
      tx,
      sql`DELETE FROM ${s.tombstone} WHERE deleted_at < ${cutoff} RETURNING row_id AS id`,
    );
    const mutations = await dbAll<{ id: string }>(
      tx,
      sql`DELETE FROM ${s.appliedMutation} WHERE applied_at < ${cutoff} RETURNING mutation_id AS id`,
    );
    return { tombstones: tombstones.length, mutations: mutations.length, raised };
  });
}
