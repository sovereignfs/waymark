import { localDate, momentOf } from '../places/tz';
import { comparePositions } from '../position';
import { orderStops } from '../trips/dates';

/**
 * **Today** (DESIGN.md §14.1), pure and the one implementation: the device runs it from a trip's rows, the person's _Done_ marks and the moment, and a test holds it to the fixtures. Nothing here reads a clock, a database or the
 * device: `now` and `deviceZone` are given.
 *
 *  - **Today's date is the date in the current stop's zone**, never the device's: a person in Lisbon with the phone still set to Tokyo is on the Lisbon date. The current stop is the one whose dates contain the date as *its own* zone
 *    says it is; on a travel day (a date shared by the stop being left and the one arrived at) both stops qualify, the later is the current one, and **both days are shown, departing then arriving**.
 *  - **Items are in plan order, and timed ones by time**: the timed items are put in time order in the places the timed items had, and an untimed item stays where the plan put it.
 *  - **Next** is the first item, in that order, that is not done and is either timed with a start still ahead, or untimed and after the last item that is done. A timed item whose time has passed and was not marked done is not next
 *    (it stays in the list, undone); the countdown is whole minutes, rounded up, to a timed next item.
 *  - **A day with nothing in it is an empty day**, not an error; a trip that has not begun, has ended, is between its stops or has no dates says so.
 */
export interface TodayStop {
  readonly id: string;
  readonly arrive: string | null;
  readonly depart: string | null;
  readonly position: string;
  /** The zone of the stop's place; where the place has none, the device's. */
  readonly tz: string | null;
}
export interface TodayDay {
  readonly id: string;
  readonly stopId: string;
  readonly date: string;
}
export interface TodayItem {
  readonly id: string;
  readonly dayId: string;
  readonly start: string | null;
  readonly position: string;
}

export type TodayState =
  /** The trip has no dates. */
  | 'planning'
  /** Its first day has not come. */
  | 'before'
  /** Today is one of its days. */
  | 'during'
  /** Today is between two of its stops, on no stop's day. */
  | 'between'
  /** Its last day has passed. */
  | 'after';

export interface TodayItemView<T extends TodayItem> {
  readonly item: T;
  readonly done: boolean;
  /** The moment it starts, in the zone of its day's stop; none for an untimed item. */
  readonly at: number | null;
}
export interface TodayDayView<T extends TodayItem> {
  readonly day: TodayDay;
  readonly zone: string;
  readonly items: readonly TodayItemView<T>[];
}
export interface Next<T extends TodayItem> {
  readonly item: T;
  readonly dayId: string;
  readonly at: number | null;
  /** Whole minutes to a timed item, rounded up; none for an untimed one. */
  readonly inMinutes: number | null;
}
export interface Today<T extends TodayItem> {
  readonly state: TodayState;
  /** Today's date, in the current stop's zone (none unless `during`). */
  readonly date: string | null;
  readonly zone: string | null;
  /** The stops that are current: one, or two on a travel day (leaving, then arriving). */
  readonly stopIds: readonly string[];
  readonly days: readonly TodayDayView<T>[];
  readonly next: Next<T> | undefined;
  /** `during` with nothing planned for today. */
  readonly empty: boolean;
  /** For `before`: the first date. For `after`: the last. */
  readonly edge: string | undefined;
}

export interface TodayInput<T extends TodayItem> {
  readonly stops: readonly TodayStop[];
  readonly days: readonly TodayDay[];
  readonly items: readonly T[];
  readonly done: ReadonlySet<string>;
  readonly now: number;
  readonly deviceZone: string;
}

/** A day's items in the order they are shown: the plan's, with the timed ones in time order in the slots the timed ones had. */
export function displayOrder<T extends TodayItem>(items: readonly T[]): T[] {
  const planned = [...items].sort(
    (a, b) => comparePositions(a.position, b.position) || a.id.localeCompare(b.id),
  );
  const slots = planned.flatMap((item, index) => (item.start === null ? [] : [index]));
  const timed = slots
    .map((index) => planned[index] as T)
    .sort(
      (a, b) =>
        (a.start as string).localeCompare(b.start as string) ||
        comparePositions(a.position, b.position) ||
        a.id.localeCompare(b.id),
    );
  const out = [...planned];
  for (const [i, slot] of slots.entries()) out[slot] = timed[i] as T;
  return out;
}

export function today<T extends TodayItem>(input: TodayInput<T>): Today<T> {
  const zoneOf = (stop: TodayStop) => stop.tz ?? input.deviceZone;
  const dated = orderStops(
    input.stops.map((stop) => ({ ...stop, arrive: stop.arrive, depart: stop.depart })),
  ).filter((stop) => stop.arrive !== null && stop.depart !== null);
  const none = (state: TodayState, edge?: string): Today<T> => ({
    state,
    date: null,
    zone: null,
    stopIds: [],
    days: [],
    next: undefined,
    empty: false,
    edge,
  });
  const first = dated[0];
  const last = dated.at(-1);
  if (!first || !last) return none('planning');

  if (localDate(input.now, zoneOf(first)) < (first.arrive as string))
    return none('before', first.arrive as string);
  if (localDate(input.now, zoneOf(last)) > (last.depart as string))
    return none('after', last.depart as string);

  // The stops whose dates contain the date as their own zone says it is.
  const current = dated.filter((stop) => {
    const date = localDate(input.now, zoneOf(stop));
    return (stop.arrive as string) <= date && date <= (stop.depart as string);
  });
  const primary = current.at(-1);
  if (!primary) return none('between');
  const zone = zoneOf(primary);
  const date = localDate(input.now, zone);

  const stopById = new Map(dated.map((stop) => [stop.id, stop]));
  const todays = input.days
    .filter((day) => day.date === date && current.some((stop) => stop.id === day.stopId))
    .sort((a, b) => {
      const stopA = stopById.get(a.stopId) as TodayStop;
      const stopB = stopById.get(b.stopId) as TodayStop;
      // Departing, then arriving.
      return (
        (stopA.arrive as string).localeCompare(stopB.arrive as string) || a.id.localeCompare(b.id)
      );
    });

  const views: TodayDayView<T>[] = todays.map((day) => {
    const dayZone = zoneOf(stopById.get(day.stopId) as TodayStop);
    const own = input.items.filter((item) => item.dayId === day.id);
    return {
      day,
      zone: dayZone,
      items: displayOrder(own).map((item) => ({
        item,
        done: input.done.has(item.id),
        at: item.start === null ? null : (momentOf(day.date, item.start, dayZone) ?? null),
      })),
    };
  });

  const flat = views.flatMap((view) =>
    view.items.map((entry) => ({ ...entry, dayId: view.day.id })),
  );
  let lastDone = -1;
  for (const [index, entry] of flat.entries()) if (entry.done) lastDone = index;
  let next: Next<T> | undefined;
  for (const [index, entry] of flat.entries()) {
    if (entry.done) continue;
    const ahead = entry.at !== null ? entry.at > input.now : index > lastDone;
    if (!ahead) continue;
    next = {
      item: entry.item,
      dayId: entry.dayId,
      at: entry.at,
      inMinutes: entry.at === null ? null : Math.ceil((entry.at - input.now) / 60_000),
    };
    break;
  }
  return {
    state: 'during',
    date,
    zone,
    stopIds: current.map((stop) => stop.id),
    days: views,
    next,
    empty: flat.length === 0,
    edge: undefined,
  };
}
