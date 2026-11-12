import { sql } from 'drizzle-orm';
import type { Database } from '../db/client';
import { dbAll } from '../db/exec';
import * as postgresSchema from '../db/schema/postgres';
import * as sqliteSchema from '../db/schema/sqlite';
import { KINDS, type NoticeKind } from './kinds';

/**
 * Which notices a person wants by which channel (DESIGN.md §17.2, §21). **The bell is always on and is not a preference**: a notice is always in the app. Beyond it, a person chooses by kind and channel; today
 * the one channel is `email`, and core's bell (14.1) and Web Push (12.4) join when those tasks make them. A kind and channel the person has not changed is at its default, here; a change is a row
 * (`notice_pref`) and a row is the only thing that overrides a default, so a default can be changed in a later version for everyone who never chose. `core` is the bell of a Sovereign core the person signs in through
 * (14.1): it is offered, and acts, only where the people here sign in through a core; the person's choice is kept either way.
 */
export const CHANNELS = ['email', 'core', 'push'] as const;
export type Channel = (typeof CHANNELS)[number];

/** What a person is told of, in words, for Settings (the sentence a notice itself says is its own). */
export const KIND_LABELS: Readonly<Record<NoticeKind, string>> = {
  import_finished: 'An import from Swarm has finished',
  organizer_passed: 'A trip has passed to you because its last Organizer deleted their account',
  trip_ready: 'A trip you are in is marked ready, or moved back to planning',
  trip_dates: 'The dates of a ready trip you are in change',
  role_changed: 'Your part in a trip is changed by an Organizer',
  checkin_shared: 'A Traveler shares a check-in with a trip you are in',
  edit_replaced: 'Someone else changed an item right after you, and their change stands',
  trip_starts: 'A trip you are going on starts tomorrow',
  item_soon: 'A timed item on your trip is coming up',
  day_plan: 'The day’s plan, each morning of a trip',
};

/** The default for each kind and channel. An import takes a while and people leave: email is on. */
export const DEFAULTS: Readonly<Record<NoticeKind, Readonly<Record<Channel, boolean>>>> = {
  import_finished: { email: true, core: true, push: false },
  // Said in the bell and by core's bell: not worth a mail of its own.
  organizer_passed: { email: false, core: true, push: false },
  // The bell and core's bell, not mail: a trip changes often and its people are in it.
  trip_ready: { email: false, core: true, push: false },
  trip_dates: { email: false, core: true, push: false },
  role_changed: { email: false, core: true, push: false },
  // Off by default, in every channel: a member is told of a shared check-in only if they turned it on (DESIGN.md §17.1).
  checkin_shared: { email: false, core: false, push: false },
  // Said in the bell and by core's bell: your own words were replaced, which you should be able to find.
  edit_replaced: { email: false, core: true, push: false },
  // Trip Mode's reminders (DESIGN.md §14.4). The bell always; a trip's start is also emailed; a reminder is worth little unless it reaches the device, so push is on for all three (it applies only to a person who turned push on).
  trip_starts: { email: true, core: true, push: true },
  item_soon: { email: false, core: true, push: true },
  day_plan: { email: false, core: true, push: true },
};

export const isChannel = (value: unknown): value is Channel =>
  typeof value === 'string' && (CHANNELS as readonly string[]).includes(value);
export const isKind = (value: unknown): value is NoticeKind =>
  typeof value === 'string' && (KINDS as readonly string[]).includes(value);

const table = (database: Database) =>
  database.dialect === 'postgres' ? postgresSchema.noticePref : sqliteSchema.noticePref;

export type Prefs = Record<NoticeKind, Record<Channel, boolean>>;

/** Every kind and channel for a person, the default where they have not chosen. */
export async function listPrefs(database: Database, accountId: string): Promise<Prefs> {
  const rows = await dbAll<{ kind: string; channel: string; enabled: number | string }>(
    database,
    sql`SELECT kind, channel, enabled FROM ${table(database)} WHERE account_id = ${accountId}`,
  );
  const out = Object.fromEntries(
    KINDS.map((kind) => [kind, { ...DEFAULTS[kind] }]),
  ) as unknown as Prefs;
  for (const row of rows)
    if (isKind(row.kind) && isChannel(row.channel))
      out[row.kind][row.channel] = Number(row.enabled) === 1;
  return out;
}

/** Whether a person wants this kind by this channel: their choice, or the default. One statement, so it can be asked inside the transaction of the change that raises the notice. */
export async function wants(
  database: Database,
  accountId: string,
  kind: NoticeKind,
  channel: Channel,
): Promise<boolean> {
  const rows = await dbAll<{ enabled: number | string }>(
    database,
    sql`SELECT enabled FROM ${table(database)}
        WHERE account_id = ${accountId} AND kind = ${kind} AND channel = ${channel}`,
  );
  return rows[0] ? Number(rows[0].enabled) === 1 : DEFAULTS[kind][channel];
}

/** Records a person's choice. Choosing again replaces it; choosing what the default is keeps a row (the default may change, the choice should not). */
export async function setPref(
  database: Database,
  accountId: string,
  kind: NoticeKind,
  channel: Channel,
  on: boolean,
  now: number,
): Promise<void> {
  await dbAll(
    database,
    sql`INSERT INTO ${table(database)} (account_id, kind, channel, enabled, updated_at)
        VALUES (${accountId}, ${kind}, ${channel}, ${on ? 1 : 0}, ${now})
        ON CONFLICT (account_id, kind, channel) DO UPDATE SET enabled = ${on ? 1 : 0}, updated_at = ${now}
        RETURNING kind`,
  );
}

/** Deletes a person's choices (`People.deletePerson`, in its transaction). Returns how many. */
export async function deletePrefsOf(database: Database, accountId: string): Promise<number> {
  const rows = await dbAll<{ kind: string }>(
    database,
    sql`DELETE FROM ${table(database)} WHERE account_id = ${accountId} RETURNING kind`,
  );
  return rows.length;
}
