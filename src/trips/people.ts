import { sql } from 'drizzle-orm';
import { tableOf } from '../access/trip';
import type { Sealer } from '../crypto/sealed';
import type { Database } from '../db/client';
import { dbAll } from '../db/exec';
import { type Delivery, raiseNotice } from '../notices/notices';
import { removeTripRows } from './trips';

/**
 * What becomes of a person's part in trips when their account is deleted (DESIGN.md §11.4, §23), run by `People.deletePerson` **in its transaction**:
 *
 *  - **A trip with nobody else in it is deleted** with everything it holds.
 *  - **A trip where they were the only Organizer passes** to its longest-standing Traveler, and with none to its longest-standing Follower, who becomes its Organizer and is told (`organizer_passed`), so that a trip always has one.
 *  - **Their membership ends** (the row goes: the person is gone, not only away), and **`created_by` and `added_by` that name them are cleared**, so that nothing points at an account that is not there. What they wrote in a shared
 *    plan stays, as the trip's.
 *
 * Safe to run again: a second run finds no membership of theirs.
 */
export interface TripFarewellDeps {
  readonly now: () => number;
  /** To tell the one who becomes Organizer. Without it the trip still passes, and nobody is told. */
  readonly notices?: { readonly sealer: Sealer; readonly delivery: () => Delivery } | undefined;
}

export async function endMembershipsOf(
  tx: Database,
  deps: TripFarewellDeps,
  accountId: string,
): Promise<string[]> {
  const now = deps.now();
  /** The files of trips that went with their last member: removed by the caller after its transaction. */
  const files: string[] = [];
  const memberTable = tableOf(tx, 'trip_member');
  const mine = await dbAll<{ tripId: string; role: string }>(
    tx,
    sql`SELECT trip_id AS "tripId", role FROM ${memberTable} WHERE account_id = ${accountId} AND left_at IS NULL ORDER BY trip_id`,
  );
  for (const membership of mine) {
    const others = await dbAll<{ accountId: string; role: string }>(
      tx,
      sql`SELECT account_id AS "accountId", role FROM ${memberTable}
          WHERE trip_id = ${membership.tripId} AND account_id <> ${accountId} AND left_at IS NULL
          ORDER BY CASE role WHEN 'organizer' THEN 0 WHEN 'traveler' THEN 1 ELSE 2 END, joined_at, account_id`,
    );
    if (others.length === 0) {
      // Nobody else: the trip goes, with everything it holds.
      await dbAll(
        tx,
        sql`DELETE FROM ${tableOf(tx, 'trip')} WHERE id = ${membership.tripId} RETURNING id`,
      );
      files.push(...(await removeTripRows(tx, membership.tripId, now)));
      continue;
    }
    const next = others[0];
    if (membership.role === 'organizer' && next && next.role !== 'organizer') {
      // The only Organizer: the longest-standing Traveler (or, with none, Follower) takes over.
      const passed = await dbAll<{ accountId: string }>(
        tx,
        sql`UPDATE ${memberTable} SET role = 'organizer', seq = seq + 1
            WHERE trip_id = ${membership.tripId} AND account_id = ${next.accountId} AND left_at IS NULL
            RETURNING account_id AS "accountId"`,
      );
      await dbAll(
        tx,
        sql`UPDATE ${tableOf(tx, 'trip')} SET seq = seq + 1, updated_at = ${now} WHERE id = ${membership.tripId} RETURNING id`,
      );
      if (passed.length > 0 && deps.notices)
        await raiseNotice(
          tx,
          deps.notices.sealer,
          now,
          {
            to: next.accountId,
            by: accountId,
            kind: 'organizer_passed',
            tripId: membership.tripId,
            content: {
              title: 'You are now an Organizer of a trip',
              detail:
                'Its last Organizer deleted their account, so the trip has passed to you. Open it to see who is in it.',
              href: `/trips/${membership.tripId}`,
            },
          },
          deps.notices.delivery(),
        );
    }
  }
  // Every row of theirs, left ones too, and what names them.
  await dbAll(
    tx,
    sql`DELETE FROM ${memberTable} WHERE account_id = ${accountId} RETURNING trip_id`,
  );
  await dbAll(
    tx,
    sql`UPDATE ${memberTable} SET added_by = NULL WHERE added_by = ${accountId} RETURNING trip_id`,
  );
  // What they planned and attached stays, as the trip's: only the names go.
  await dbAll(
    tx,
    sql`UPDATE ${tableOf(tx, 'attachment')} SET created_by = NULL WHERE created_by = ${accountId} RETURNING id`,
  );
  await dbAll(
    tx,
    sql`UPDATE ${tableOf(tx, 'item')} SET created_by = NULL WHERE created_by = ${accountId} RETURNING id`,
  );
  await dbAll(
    tx,
    sql`UPDATE ${tableOf(tx, 'item')} SET updated_by = NULL WHERE updated_by = ${accountId} RETURNING id`,
  );
  await dbAll(
    tx,
    sql`UPDATE ${tableOf(tx, 'trip')} SET created_by = NULL WHERE created_by = ${accountId} RETURNING id`,
  );
  return files;
}
