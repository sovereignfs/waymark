/**
 * The rules of a trip's dates (DESIGN.md §10.3, §10.4), pure: no database, no clock, no time zone. **A date is `YYYY-MM-DD` and is a day of the calendar, in no zone** (a stop's dates are in its place's zone, which only says which
 * day it is there). Everything here is done on the calendar's own arithmetic, so that daylight saving and the date line cannot move a day.
 *
 *  - A stop has both its dates or neither; the departure is not before the arrival; it is **at most 90 days**.
 *  - A trip has **at most 365 days** (each stop's days counted, so a travel day shared by two stops is two).
 *  - Stops **do not overlap**, except that one stop's departure may be the next one's arrival (a travel day belongs to both), and a date is in at most two stops.
 *  - **Days follow the stop's dates**: a day for each date from arrival to departure.
 *  - The trip's dates are its first stop's arrival and its last stop's departure.
 */
export const MAX_STOP_DAYS = 90;
export const MAX_TRIP_DAYS = 365;

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 86_400_000;

/** The calendar's day number of a date (days since 1970-01-01), or `undefined` for what is not a real date. */
export function dayNumber(date: unknown): number | undefined {
  if (typeof date !== 'string') return undefined;
  const match = DATE.exec(date);
  if (!match) return undefined;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (year < 1900 || year > 2200) return undefined;
  const ms = Date.UTC(year, month - 1, day);
  const back = new Date(ms);
  // A date that rolled over (the 31st of April) is not a date.
  if (
    back.getUTCFullYear() !== year ||
    back.getUTCMonth() !== month - 1 ||
    back.getUTCDate() !== day
  )
    return undefined;
  return Math.round(ms / DAY_MS);
}

export const isDate = (date: unknown): date is string => dayNumber(date) !== undefined;

/** The date `days` after (or before, if negative) a date. */
export function addDays(date: string, days: number): string {
  const number = dayNumber(date);
  if (number === undefined) throw new RangeError('not a date');
  return new Date((number + days) * DAY_MS).toISOString().slice(0, 10);
}

/** Every date from `arrive` to `depart`, inclusive, in order. */
export function datesOf(arrive: string, depart: string): string[] {
  const from = dayNumber(arrive);
  const to = dayNumber(depart);
  if (from === undefined || to === undefined || to < from) return [];
  return Array.from({ length: to - from + 1 }, (_, i) => addDays(arrive, i));
}

export interface DatedStop {
  readonly id: string;
  readonly arrive: string | null;
  readonly depart: string | null;
  readonly position: string;
}

export type DatesProblem =
  | { readonly reason: 'invalid'; readonly sentence: string }
  | { readonly reason: 'limit'; readonly sentence: string }
  | { readonly reason: 'overlap'; readonly sentence: string };

/** A stop's two dates as given: both or neither, real, in order, and not more than 90 days. Returns the dates (null, null for none), or what is wrong, in a sentence that does not repeat them. */
export function checkStopDates(
  arrive: unknown,
  depart: unknown,
): { ok: true; arrive: string | null; depart: string | null } | ({ ok: false } & DatesProblem) {
  const none = (value: unknown) => value === undefined || value === null || value === '';
  if (none(arrive) && none(depart)) return { ok: true, arrive: null, depart: null };
  if (none(arrive) || none(depart))
    return {
      ok: false,
      reason: 'invalid',
      sentence: 'A stop has an arrival and a departure, or neither.',
    };
  const from = dayNumber(arrive);
  const to = dayNumber(depart);
  if (from === undefined || to === undefined)
    return {
      ok: false,
      reason: 'invalid',
      sentence: 'A date is a day of the calendar, written YYYY-MM-DD.',
    };
  if (to < from)
    return { ok: false, reason: 'invalid', sentence: 'A stop cannot leave before it arrives.' };
  if (to - from + 1 > MAX_STOP_DAYS)
    return { ok: false, reason: 'limit', sentence: `A stop is at most ${MAX_STOP_DAYS} days.` };
  return { ok: true, arrive: arrive as string, depart: depart as string };
}

/** Stops in the order the trip keeps them: the dated ones by their dates (then arrival, departure, position, id), and the undated ones after them, by position. */
export function orderStops<T extends DatedStop>(stops: readonly T[]): T[] {
  return [...stops].sort((a, b) => {
    if ((a.arrive === null) !== (b.arrive === null)) return a.arrive === null ? 1 : -1;
    if (a.arrive !== null && b.arrive !== null) {
      if (a.arrive !== b.arrive) return a.arrive < b.arrive ? -1 : 1;
      if (a.depart !== b.depart) return (a.depart ?? '') < (b.depart ?? '') ? -1 : 1;
    }
    if (a.position !== b.position) return a.position < b.position ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/** What a whole set of stops must satisfy, in a sentence for the first thing wrong: no overlap but a shared boundary, a date in at most two stops, at most 365 days. */
export function checkStops(stops: readonly DatedStop[]): DatesProblem | undefined {
  const dated = orderStops(stops).filter((stop) => stop.arrive !== null && stop.depart !== null);
  let total = 0;
  const perDate: Record<string, number> = {};
  for (const stop of dated) {
    const dates = datesOf(stop.arrive as string, stop.depart as string);
    total += dates.length;
    for (const date of dates) perDate[date] = (perDate[date] ?? 0) + 1;
  }
  for (let i = 1; i < dated.length; i += 1) {
    const before = dated[i - 1] as DatedStop;
    const stop = dated[i] as DatedStop;
    if ((before.depart as string) > (stop.arrive as string))
      return {
        reason: 'overlap',
        sentence: 'Stops cannot overlap, except that one may leave the day the next arrives.',
      };
  }
  if (Object.values(perDate).some((count) => count > 2))
    return {
      reason: 'overlap',
      sentence:
        'A day can belong to at most two stops: the one that leaves and the one that arrives.',
    };
  if (total > MAX_TRIP_DAYS)
    return { reason: 'limit', sentence: `A trip is at most ${MAX_TRIP_DAYS} days.` };
  return undefined;
}

/** The trip's dates from its stops: the first arrival and the last departure, or none while no stop has dates. */
export function tripDates(stops: readonly DatedStop[]): {
  start: string | null;
  end: string | null;
} {
  let start: string | null = null;
  let end: string | null = null;
  for (const stop of stops) {
    if (stop.arrive === null || stop.depart === null) continue;
    if (start === null || stop.arrive < start) start = stop.arrive;
    if (end === null || stop.depart > end) end = stop.depart;
  }
  return { start, end };
}

/**
 * What changes in a stop's days when its dates change: the dates that are new (a day is made), the dates that are no longer in it (a day is removed, and is refused if it has items) and the dates that stay (the day is kept, with
 * its title, notes and items).
 */
export function reconcileDays(
  current: readonly string[],
  next: readonly string[],
): { add: string[]; remove: string[]; keep: string[] } {
  const have = new Set(current);
  const want = new Set(next);
  return {
    add: next.filter((date) => !have.has(date)),
    remove: current.filter((date) => !want.has(date)),
    keep: next.filter((date) => have.has(date)),
  };
}
