import { sql } from 'drizzle-orm';
import { tableOf } from '../access/trip';
import type { Database } from '../db/client';
import { dbAll } from '../db/exec';

/**
 * What a trip's stream says was deleted (DESIGN.md §15.3): a row of a trip that goes (a stop, a day, an item, a trip place, a link, an attachment, the copy of a shared check-in, a member's row) leaves **its table, its id and the
 * trip's number at the deletion** in `trip_tombstone`, with no content, **in the transaction of the deletion**, so that a device that was away learns of it by its cursor. A row made again under its id takes its tombstone away.
 * A deleted *trip* leaves none: its members are told that it is gone (`pullTrips`).
 *
 * `seq` is the number the change took in the trip's own counter (`trip.seq`), which the caller already holds.
 */
export async function recordGone(
  tx: Database,
  tripId: string,
  table: string,
  ids: readonly string[],
  seq: number,
  now: number,
): Promise<void> {
  for (const id of ids)
    await dbAll(
      tx,
      sql`INSERT INTO ${tableOf(tx, 'trip_tombstone')} (trip_id, table_name, row_id, seq, deleted_at)
          VALUES (${tripId}, ${table}, ${id}, ${seq}, ${now})
          ON CONFLICT (trip_id, table_name, row_id) DO UPDATE SET seq = excluded.seq, deleted_at = excluded.deleted_at
          RETURNING row_id`,
    );
}

/** A row made again under the id it had: it is not gone. */
export const clearGone = (tx: Database, tripId: string, table: string, id: string) =>
  dbAll(
    tx,
    sql`DELETE FROM ${tableOf(tx, 'trip_tombstone')} WHERE trip_id = ${tripId} AND table_name = ${table} AND row_id = ${id} RETURNING row_id`,
  );
