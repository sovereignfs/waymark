import { sql } from 'drizzle-orm';
import { EDITORS, memberOf, tableOf } from '../access/trip';
import type { Database } from '../db/client';
import { dbAll, dbGet } from '../db/exec';
import { TRIP_ID, TripError } from '../trips/format';
import { DEFAULT_PREFS, LEAD_MIN, type ReminderPrefs } from './due';

/**
 * A member's settings for a trip's reminders (DESIGN.md §14.4, §10.8): theirs, for this trip, read and changed by them alone while they are an Organizer or a Traveler of it. **The permission is in the statement**: a Follower, a former member, a
 * stranger and a trip that is not there all read as `undefined` (not found). A value that is not one is refused in a sentence that repeats nothing.
 */
export interface PrefsDeps {
  readonly database: Database;
  readonly now: () => number;
}

interface Row {
  tripStarts: boolean | number;
  itemSoon: boolean | number;
  leadMin: number | string;
  flexible: boolean | number;
  dayPlan: boolean | number;
}
const COLUMNS = sql.raw(
  `trip_starts AS "tripStarts", item_soon AS "itemSoon", lead_min AS "leadMin", flexible, day_plan AS "dayPlan"`,
);
const prefsOf = (row: Row): ReminderPrefs => ({
  tripStarts: Boolean(row.tripStarts),
  itemSoon: Boolean(row.itemSoon),
  leadMin: Number(row.leadMin),
  flexible: Boolean(row.flexible),
  dayPlan: Boolean(row.dayPlan),
});

/** The member's settings for the trip (the defaults where they have changed none), or `undefined` for someone who may not have any. */
export async function readPrefs(
  deps: PrefsDeps,
  accountId: string,
  tripId: string,
): Promise<ReminderPrefs | undefined> {
  if (!TRIP_ID.test(tripId)) return undefined;
  const t = (name: string) => tableOf(deps.database, name);
  const allowed = await dbGet<{ id: string }>(
    deps.database,
    sql`SELECT t.id AS id FROM ${t('trip')} t WHERE t.id = ${tripId} AND ${memberOf(deps.database, sql`t.id`, accountId, EDITORS)}`,
  );
  if (!allowed) return undefined;
  const row = await dbGet<Row>(
    deps.database,
    sql`SELECT ${COLUMNS} FROM ${t('reminder_pref')} WHERE trip_id = ${tripId} AND account_id = ${accountId}`,
  );
  return row ? prefsOf(row) : DEFAULT_PREFS;
}

/** The settings a member has changed for a trip, without asking who is asking: for the job that sends reminders, which has already chosen the members who go. The defaults where there is no row. */
export async function prefsOfMember(
  database: Database,
  tripId: string,
  accountId: string,
): Promise<ReminderPrefs> {
  const row = await dbGet<Row>(
    database,
    sql`SELECT ${COLUMNS} FROM ${tableOf(database, 'reminder_pref')} WHERE trip_id = ${tripId} AND account_id = ${accountId}`,
  );
  return row ? prefsOf(row) : DEFAULT_PREFS;
}

export type PrefsPatch = Partial<Record<keyof ReminderPrefs, unknown>>;
const KEYS = ['tripStarts', 'itemSoon', 'leadMin', 'flexible', 'dayPlan'] as const;

export async function setPrefs(
  deps: PrefsDeps,
  accountId: string,
  tripId: string,
  patch: PrefsPatch,
): Promise<ReminderPrefs | undefined> {
  if (!TRIP_ID.test(tripId)) return undefined;
  const current = await readPrefs(deps, accountId, tripId);
  if (!current) return undefined;
  if (!KEYS.some((key) => key in patch)) throw new TripError('There is nothing to change.');
  const next: Record<string, boolean | number> = { ...current };
  for (const key of ['tripStarts', 'itemSoon', 'flexible', 'dayPlan'] as const) {
    if (!(key in patch)) continue;
    if (typeof patch[key] !== 'boolean') throw new TripError('A reminder is on or off.');
    next[key] = patch[key];
  }
  if ('leadMin' in patch) {
    const lead = patch.leadMin;
    if (
      typeof lead !== 'number' ||
      !Number.isInteger(lead) ||
      lead < LEAD_MIN.min ||
      lead > LEAD_MIN.max
    )
      throw new TripError(
        `A reminder comes ${LEAD_MIN.min} to ${LEAD_MIN.max} minutes before, in whole minutes.`,
      );
    next.leadMin = lead;
  }
  const t = (name: string) => tableOf(deps.database, name);
  // Written only while the person is still an Organizer or a Traveler of the trip: the permission is in this statement as well.
  const written = await dbAll<Row>(
    deps.database,
    sql`INSERT INTO ${t('reminder_pref')} (trip_id, account_id, trip_starts, item_soon, lead_min, flexible, day_plan, updated_at)
        SELECT ${tripId}, ${accountId}, ${next.tripStarts as boolean}, ${next.itemSoon as boolean}, ${next.leadMin as number}, ${next.flexible as boolean}, ${next.dayPlan as boolean}, ${deps.now()}
        WHERE ${memberOf(deps.database, sql`${tripId}`, accountId, EDITORS)}
        ON CONFLICT (trip_id, account_id) DO UPDATE
          SET trip_starts = excluded.trip_starts, item_soon = excluded.item_soon, lead_min = excluded.lead_min,
              flexible = excluded.flexible, day_plan = excluded.day_plan, updated_at = excluded.updated_at
        RETURNING ${COLUMNS}`,
  );
  return written[0] ? prefsOf(written[0]) : undefined;
}
