import type { DayRecord, ItemRecord, StopRecord } from '../sync/trip-format';
import { type Today, today } from './today';

/**
 * Today for a trip as the device holds it (`LocalStore.tripView`): the stops with the zone of their place, the days, the items with the outbox laid over them, and the items this account has marked done. A thin adapter; the rules are
 * `today.ts`'s.
 */
export function todayOfTrip(
  view: {
    readonly stops: readonly StopRecord[];
    readonly days: readonly DayRecord[];
    readonly items: readonly ItemRecord[];
    readonly done: ReadonlySet<string>;
  },
  now: number,
  deviceZone: string,
): Today<ItemRecord> {
  return today<ItemRecord>({
    stops: view.stops.map((stop) => ({
      id: stop.id,
      arrive: stop.arrive,
      depart: stop.depart,
      position: stop.position,
      tz: stop.place.tz,
    })),
    days: view.days.map((day) => ({ id: day.id, stopId: day.stopId, date: day.date })),
    items: view.items,
    done: view.done,
    now,
    deviceZone,
  });
}
