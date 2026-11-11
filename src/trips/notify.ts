import { sql } from 'drizzle-orm';
import { tableOf } from '../access/trip';
import type { Sealer } from '../crypto/sealed';
import type { Database } from '../db/client';
import { dbAll } from '../db/exec';
import { type Delivery, raiseNotice } from '../notices/notices';
import type { NoticeKind } from '../notices/kinds';

/**
 * Telling a trip's members of a change to it (DESIGN.md §17.1): **a notice for every active member except the person who made the change**, raised **in the transaction of the change** (`tx`), so that a notice and the change stand or
 * fall together and nothing is raised for a change that was rolled back. What a notice says is Waymark's own words and the trip's name (which every member already sees), and a link to the trip: never a place, a note or a person's name.
 * The bell always; the channels beyond it are what each person chose (`delivery`).
 */
export interface NotifyDeps {
  readonly sealer: Sealer;
  readonly now: () => number;
  /** How notices also reach people on this server; absent, the bell alone. */
  readonly delivery?: (() => Delivery) | undefined;
}

export async function notifyMembers(
  tx: Database,
  deps: NotifyDeps,
  tripId: string,
  by: string,
  kind: NoticeKind,
  content: { title: string; detail?: string },
): Promise<number> {
  const members = await dbAll<{ accountId: string }>(
    tx,
    sql`SELECT account_id AS "accountId" FROM ${tableOf(tx, 'trip_member')} WHERE trip_id = ${tripId} AND left_at IS NULL AND account_id <> ${by} ORDER BY account_id`,
  );
  const delivery = deps.delivery?.() ?? {};
  let told = 0;
  for (const member of members) {
    const id = await raiseNotice(
      tx,
      deps.sealer,
      deps.now(),
      { to: member.accountId, by, kind, tripId, content: { ...content, href: `/trips/${tripId}` } },
      delivery,
    );
    if (id !== undefined) told += 1;
  }
  return told;
}
