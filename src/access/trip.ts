import { type SQL, sql } from 'drizzle-orm';
import type { Database } from '../db/client';
import type { Role } from '../trips/format';

/**
 * **The permission on a trip is in the statement** (DESIGN.md §5.2). A trip's rows carry `trip_id`, and every read and write of them names it **together with the caller's membership and the role the operation needs**, as a
 * condition of the same statement, never checked first and then touched:
 *
 *   SELECT … FROM trip t WHERE t.id = ? AND <memberOf(…, t.id, MEMBERS)>
 *
 * One fragment, `memberOf`, and one list of role sets, so that no statement spells the rule for itself. A refusal reads as not found: a trip that is not yours is a trip that is not there, and the answer for it is the answer for none.
 */
export const ORGANIZERS: readonly Role[] = ['organizer'];
/** Who may edit a trip's plan: Organizers, and Travelers, who are going. */
export const EDITORS: readonly Role[] = ['organizer', 'traveler'];
/** Who may read a trip: every member. */
export const MEMBERS: readonly Role[] = ['organizer', 'traveler', 'follower'];

const memberTable = (database: Database) =>
  sql.raw(database.dialect === 'postgres' ? 'waymark.trip_member' : 'trip_member');

/** The tables of the trip's own rows by dialect, for a statement that is not drizzle's. */
export const tableOf = (database: Database, name: string): SQL =>
  sql.raw(database.dialect === 'postgres' ? `waymark.${name}` : name);

/**
 * "`accountId` is an active member of the trip `tripId` (an expression: a bound id, or a column such as `t.id`) in one of `roles`": `EXISTS (SELECT 1 FROM trip_member …)`. Active is `left_at IS NULL`, so a person who has left,
 * or has been removed, is no longer anything to the trip. The roles are fixed lists in this file and are bound as values.
 */
export function memberOf(
  database: Database,
  tripId: SQL,
  accountId: string,
  roles: readonly Role[],
): SQL {
  const list = sql.join(
    roles.map((role) => sql`${role}`),
    sql`, `,
  );
  return sql`EXISTS (SELECT 1 FROM ${memberTable(database)} m WHERE m.trip_id = ${tripId} AND m.account_id = ${accountId} AND m.role IN (${list}) AND m.left_at IS NULL)`;
}
