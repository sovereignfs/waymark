import { sql } from 'drizzle-orm';
import type { Database } from '../db/client';
import { dbAll } from '../db/exec';
import { tableOf } from './trip';

/**
 * **One order for the two locks a change to check-ins and a change to a trip may both want** (DESIGN.md §5.2): the account's stream counter first, a trip's row after. The path that applies a check-in (`src/sync/apply.ts`) and the job that links
 * them again take the counter and then the trip; a transaction that starts from the trip (leaving, removing, deleting a trip, an account being deleted) and then writes people's streams would take them the other way round, and on PostgreSQL two that
 * meet could each wait for the other. Such a transaction calls this **first**, for every account whose stream it is about to write: a statement that changes nothing and takes the row, in the order of the ids, so that they too meet in one order.
 * It reads and writes nothing of anyone's, so it is safe before the permission is known: a transaction that turns out not to be allowed has changed nothing.
 */
export async function lockStreams(tx: Database, accountIds: readonly string[]): Promise<void> {
  for (const accountId of [...new Set(accountIds)].sort())
    await dbAll(
      tx,
      sql`UPDATE ${tableOf(tx, 'account_stream')} SET seq = seq WHERE account_id = ${accountId} RETURNING account_id`,
    );
}
