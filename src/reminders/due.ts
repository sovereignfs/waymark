import { localTime, momentOf } from '../places/tz';
import { addDays } from '../trips/dates';
import { orderStops } from '../trips/dates';
import { type TodayInput, type TodayItem, today } from '../today';

/**
 * **Which reminders are due** (DESIGN.md §14.4), pure and the one implementation: from a trip's rows, one member's settings and Done marks, and the moment. The job (`server.ts`) asks this for each member of each trip every minute and sends
 * what it says, once (`reminder_sent`). Nothing here reads a clock or a database.
 *
 *  - **`trip_starts`**: from 18:00 the day before the first day, in the first stop's zone, until the trip begins.
 *  - **`item_soon`**: on a trip day, for a timed item not done, a lead time before it starts (30 minutes unless the member chose); **for fixed items, and for flexible ones only if the member asked**; **never for an untimed item**. Its key
 *    names the item **and the moment**, so an item moved to a new time can remind again, and one moved away from now does not.
 *  - **`day_plan`**: from 08:00 on a trip day, in the day's zone, until 20:00, if the member asked: the day's plan in one line.
 */
export interface ReminderPrefs {
  readonly tripStarts: boolean;
  readonly itemSoon: boolean;
  /** Minutes before a timed item. */
  readonly leadMin: number;
  /** Also remind for flexible items. */
  readonly flexible: boolean;
  readonly dayPlan: boolean;
}

export const DEFAULT_PREFS: ReminderPrefs = {
  tripStarts: true,
  itemSoon: true,
  leadMin: 30,
  flexible: false,
  dayPlan: false,
};
export const LEAD_MIN = { min: 5, max: 240 } as const;
export const TRIP_STARTS_AT = '18:00';
export const DAY_PLAN_FROM = '08:00';
export const DAY_PLAN_UNTIL = '20:00';

export interface ReminderItem extends TodayItem {
  readonly fixed: boolean;
}

export type Reminder =
  | { readonly kind: 'trip_starts'; readonly key: string; readonly date: string }
  | {
      readonly kind: 'item_soon';
      readonly key: string;
      readonly itemId: string;
      readonly at: number;
      /** Whole minutes to the start, rounded up. */
      readonly inMinutes: number;
    }
  | {
      readonly kind: 'day_plan';
      readonly key: string;
      readonly date: string;
      /** How many items the day has, and the id of the first in the order it is shown. */
      readonly count: number;
      readonly firstItemId: string | undefined;
    };

export function dueReminders<T extends ReminderItem>(
  input: TodayInput<T> & { readonly prefs: ReminderPrefs },
): Reminder[] {
  const { prefs, now } = input;
  const out: Reminder[] = [];
  const dated = orderStops(input.stops.map((stop) => ({ ...stop }))).filter(
    (stop) => stop.arrive !== null && stop.depart !== null,
  );
  const first = dated[0];

  if (prefs.tripStarts && first) {
    const zone = first.tz ?? input.deviceZone;
    const arrive = first.arrive as string;
    const from = momentOf(addDays(arrive, -1), TRIP_STARTS_AT, zone);
    const begins = momentOf(arrive, '00:00', zone);
    if (from !== undefined && begins !== undefined && from <= now && now < begins)
      out.push({ kind: 'trip_starts', key: 'trip_starts', date: arrive });
  }

  const view = today(input);
  if (view.state !== 'during' || view.date === null || view.zone === null) return out;

  if (prefs.itemSoon) {
    const lead = Math.min(LEAD_MIN.max, Math.max(LEAD_MIN.min, Math.floor(prefs.leadMin))) * 60_000;
    for (const day of view.days)
      for (const entry of day.items) {
        if (entry.at === null || entry.done) continue;
        if (!entry.item.fixed && !prefs.flexible) continue;
        if (entry.at - lead <= now && now < entry.at)
          out.push({
            kind: 'item_soon',
            key: `item_soon:${entry.item.id}:${entry.at}`,
            itemId: entry.item.id,
            at: entry.at,
            inMinutes: Math.ceil((entry.at - now) / 60_000),
          });
      }
  }

  if (prefs.dayPlan) {
    const time = localTime(now, view.zone);
    if (time >= DAY_PLAN_FROM && time < DAY_PLAN_UNTIL) {
      const items = view.days.flatMap((day) => day.items);
      // A day with nothing planned has no plan to say.
      if (items.length > 0)
        out.push({
          kind: 'day_plan',
          key: `day_plan:${view.date}`,
          date: view.date,
          count: items.length,
          firstItemId: items[0]?.item.id,
        });
    }
  }
  return out;
}
