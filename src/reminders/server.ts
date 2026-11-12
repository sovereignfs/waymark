import { sql } from 'drizzle-orm';
import { tableOf } from '../access/trip';
import { DEFAULT_LIMITS, type LimitSettings } from '../config';
import type { Sealer } from '../crypto/sealed';
import type { Database } from '../db/client';
import { dbAll, transaction } from '../db/exec';
import { type Delivery, raiseNotice } from '../notices/notices';
import { localTime } from '../places/tz';
import { type ItemView, type StopView, readPlan } from '../trips/plan';
import { type Reminder, type ReminderItem, dueReminders } from './due';
import { prefsOfMember } from './prefs';

/**
 * **Sending the reminders that are due** (DESIGN.md §14.4), once a minute. For each ready trip that is on or about to be, and each member who goes (an Organizer or a Traveler), the pure rules (`due.ts`) say what is due now from the trip's rows as
 * that member reads them, their settings and their Done marks; **each is sent once**: a row in `reminder_sent` keyed by the person and what it is about is written in the same transaction as the notice, and its primary key decides which of two
 * workers sends it, so a reminder is never sent twice and a worker that dies between the two sends none half. An item moved to a new time has a new key, so it reminds again. A reminder is a notice (`trip_starts`, `item_soon`, `day_plan`), so it
 * reaches the person through the bell, Web Push, email and core's bell as they chose, kind by kind.
 *
 * The words say what and when; they name the item (they are in the bell, sealed, and in the person's own mail), and the push carries only the kind and the path.
 */
export interface ReminderDeps {
  readonly database: Database;
  readonly sealer: Sealer;
  readonly now: () => number;
  readonly limits?: LimitSettings | undefined;
  readonly delivery?: (() => Delivery) | undefined;
}

/** How long a sent reminder is remembered: far past the longest a reminder stays due. */
export const KEEP_MS = 30 * 24 * 3_600_000;

const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export interface Sent {
  readonly sent: number;
}

export async function sendReminders(deps: ReminderDeps): Promise<Sent> {
  const now = deps.now();
  const t = (name: string) => tableOf(deps.database, name);
  const limits = deps.limits ?? DEFAULT_LIMITS;
  // Trips that are ready and within two days of now by their dates: whatever zone they are in, this holds every trip that can be on its day or the eve of it.
  const rows = await dbAll<{ id: string; sealed: Uint8Array | ArrayBuffer }>(
    deps.database,
    sql`SELECT id, sealed FROM ${t('trip')}
        WHERE ready_at IS NOT NULL AND start_date <= ${isoDay(now + 2 * 86_400_000)} AND end_date >= ${isoDay(now - 2 * 86_400_000)}
        ORDER BY id`,
  );
  const trips = rows.map((row) => ({
    id: row.id,
    name: deps.sealer.unseal(
      'trip',
      row.id,
      row.sealed instanceof Uint8Array ? row.sealed : new Uint8Array(row.sealed),
    ).name,
  }));
  let sent = 0;
  for (const trip of trips) {
    const members = await dbAll<{ accountId: string }>(
      deps.database,
      sql`SELECT account_id AS "accountId" FROM ${t('trip_member')}
          WHERE trip_id = ${trip.id} AND left_at IS NULL AND role IN ('organizer', 'traveler') AND going
          ORDER BY account_id`,
    );
    for (const member of members) {
      const plan = await readPlan(
        { database: deps.database, sealer: deps.sealer, now: deps.now, limits },
        member.accountId,
        trip.id,
      );
      if (!plan) continue;
      const prefs = await prefsOfMember(deps.database, trip.id, member.accountId);
      const done = new Set(
        (
          await dbAll<{ id: string }>(
            deps.database,
            sql`SELECT item_id AS id FROM ${t('item_done')} WHERE trip_id = ${trip.id} AND account_id = ${member.accountId}`,
          )
        ).map((row) => row.id),
      );
      const items = plan.stops.flatMap((stop) => stop.days.flatMap((day) => day.items));
      const due = dueReminders<ReminderItem & ItemView>({
        stops: plan.stops.map((stop) => stopOf(stop)),
        days: plan.stops.flatMap((stop) =>
          stop.days.map((day) => ({ id: day.id, stopId: stop.id, date: day.date })),
        ),
        items: items.map((item) => ({ ...item })),
        done,
        now,
        deviceZone: 'UTC',
        prefs,
      });
      for (const reminder of due)
        if (await send(deps, trip, member.accountId, reminder, items, plan.stops, now)) sent += 1;
    }
  }
  return { sent };
}

const stopOf = (stop: StopView) => ({
  id: stop.id,
  arrive: stop.arrive,
  depart: stop.depart,
  position: stop.position,
  tz: stop.place.tz,
});

/** Sends one reminder if it has not been: the key and the notice in one transaction. Returns whether this call sent it. */
async function send(
  deps: ReminderDeps,
  trip: { id: string; name: string },
  accountId: string,
  reminder: Reminder,
  items: readonly ItemView[],
  stops: readonly StopView[],
  now: number,
): Promise<boolean> {
  const t = (name: string) => tableOf(deps.database, name);
  return transaction(deps.database, async (tx) => {
    const taken = await dbAll<{ key: string }>(
      tx,
      sql`INSERT INTO ${t('reminder_sent')} (trip_id, account_id, key, sent_at)
          VALUES (${trip.id}, ${accountId}, ${reminder.key}, ${now})
          ON CONFLICT (trip_id, account_id, key) DO NOTHING
          RETURNING key`,
    );
    if (taken.length === 0) return false;
    const itemById = new Map(items.map((item) => [item.id, item]));
    const label = (id: string | undefined): string => {
      const item = id ? itemById.get(id) : undefined;
      return item?.title ?? item?.place?.name ?? 'Something';
    };
    const zoneOf = (id: string | undefined): string => {
      const day = id
        ? stops.find((stop) => stop.days.some((each) => each.items.some((item) => item.id === id)))
        : undefined;
      return day?.place.tz ?? 'UTC';
    };
    const content =
      reminder.kind === 'trip_starts'
        ? {
            title: `“${trip.name}” starts tomorrow`,
            detail: `It begins on ${reminder.date}. Open Trip Mode for the plan.`,
          }
        : reminder.kind === 'item_soon'
          ? {
              title: `${label(reminder.itemId)} in ${reminder.inMinutes} ${reminder.inMinutes === 1 ? 'minute' : 'minutes'}`,
              detail: `At ${localTime(reminder.at, zoneOf(reminder.itemId))} on “${trip.name}”.`,
            }
          : {
              title: `Today on “${trip.name}”`,
              detail: `${reminder.count} ${reminder.count === 1 ? 'thing' : 'things'} planned${reminder.firstItemId ? `, starting with ${label(reminder.firstItemId)}` : ''}.`,
            };
    await raiseNotice(
      tx,
      deps.sealer,
      now,
      {
        to: accountId,
        by: 'reminders',
        kind: reminder.kind,
        tripId: trip.id,
        content: { ...content, href: `/t/${trip.id}/today` },
      },
      deps.delivery?.() ?? {},
    );
    return true;
  });
}

/** Forgets reminders sent more than a month ago. */
export async function pruneSent(database: Database, now: number): Promise<number> {
  const gone = await dbAll<{ key: string }>(
    database,
    sql`DELETE FROM ${tableOf(database, 'reminder_sent')} WHERE sent_at < ${now - KEEP_MS} RETURNING key`,
  );
  return gone.length;
}
