import type { CheckinView, PlaceView } from '../actions/types';
import { yearOf } from '../figures/figures';
import { normalizeName } from '../places/match';
import { TRIP_ID } from '../trips/format';

/**
 * The timeline (DESIGN.md §20.6), apart from how it looks: **every check-in, newest first, grouped by the day it was in its own zone**, each row the place, the time in its zone, the note's first line and the
 * first photo; **filters in the query** (year, category, country, and a search over place names and notes, all on the device); and the window of rows that need drawing, so that **a decade of check-ins
 * scrolls as smoothly as ten**. Pure and the same on the device and in a test. A year, and so a day, is the check-in's own (`at` and the offset then), as the figures read it (`figures.ts`): the timeline's
 * counts for a year are the figures' counts, and a test holds them so.
 */
export interface Filters {
  /** A year, as the figures count it. */
  readonly year?: number | undefined;
  readonly category?: string | undefined;
  /** A country code, upper case. */
  readonly country?: string | undefined;
  /** A trip's id: only the check-ins linked to that trip (DESIGN.md §20.6). */
  readonly trip?: string | undefined;
  /** What was typed in the search: words that all must be in a place's name or a note, in any order. */
  readonly q: string;
}

export const NO_FILTERS: Filters = { q: '' };

/** The filters a query asks for. Anything that is not one is no filter: a stray or hostile query shows everything and runs nothing. */
export function parseFilters(search: string | URLSearchParams): Filters {
  const params = typeof search === 'string' ? new URLSearchParams(search) : search;
  const year = /^\d{4}$/.test(params.get('year') ?? '') ? Number(params.get('year')) : undefined;
  const category = (params.get('category') ?? '').trim().slice(0, 60) || undefined;
  const country = /^[A-Za-z]{2}$/.test(params.get('country') ?? '')
    ? (params.get('country') as string).toUpperCase()
    : undefined;
  const trip = TRIP_ID.test(params.get('trip') ?? '') ? (params.get('trip') as string) : undefined;
  const q = (params.get('q') ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
  return { year, category, country, trip, q };
}

/** The query that says these filters, to be put with the rest of an address (`checkin` and the like are kept by the caller). */
export function filterParams(filters: Filters): Record<string, string> {
  const out: Record<string, string> = {};
  if (filters.year !== undefined) out.year = String(filters.year);
  if (filters.category) out.category = filters.category;
  if (filters.country) out.country = filters.country;
  if (filters.trip) out.trip = filters.trip;
  if (filters.q) out.q = filters.q;
  return out;
}

export const isFiltered = (filters: Filters): boolean =>
  filters.year !== undefined ||
  !!filters.category ||
  !!filters.country ||
  !!filters.trip ||
  filters.q !== '';

/** The check-in's own local date, `YYYY-MM-DD`: its moment on the clock where it was made. */
export const localDateOf = (checkin: Pick<CheckinView, 'at' | 'offsetMin'>): string =>
  new Date(checkin.at + checkin.offsetMin * 60_000).toISOString().slice(0, 10);

/** Its local time, `HH:MM`. */
export const localTimeOf = (checkin: Pick<CheckinView, 'at' | 'offsetMin'>): string =>
  new Date(checkin.at + checkin.offsetMin * 60_000).toISOString().slice(11, 16);

const countryOf = (place: PlaceView | undefined): string =>
  (place?.countryCode ?? place?.address?.countryCode ?? '').toUpperCase();

/** What a check-in is searched by: its place's name, its note and its companions, without case, accents or punctuation. */
function haystack(checkin: CheckinView, place: PlaceView | undefined): string {
  return ` ${normalizeName(`${place?.name ?? ''} ${checkin.note ?? ''} ${checkin.companions.join(' ')}`)} `;
}

/** The check-ins that meet the filters. Order is kept. */
export function filterCheckins(
  checkins: readonly CheckinView[],
  places: ReadonlyMap<string, PlaceView>,
  filters: Filters,
): CheckinView[] {
  const words = normalizeName(filters.q).split(' ').filter(Boolean);
  return checkins.filter((checkin) => {
    const place = places.get(checkin.placeId);
    if (filters.year !== undefined && yearOf(checkin.at, checkin.offsetMin) !== filters.year)
      return false;
    if (filters.category && (place?.category ?? '') !== filters.category) return false;
    if (filters.country && countryOf(place) !== filters.country) return false;
    if (filters.trip && checkin.tripId !== filters.trip) return false;
    if (words.length > 0) {
      const text = haystack(checkin, place);
      if (!words.every((word) => text.includes(word))) return false;
    }
    return true;
  });
}

/** What the filters can be set to, from what the person has: years newest first, categories and countries by name. */
export function filterOptions(
  checkins: readonly CheckinView[],
  places: ReadonlyMap<string, PlaceView>,
): { years: number[]; categories: string[]; countries: string[] } {
  const years = new Set<number>();
  const categories = new Set<string>();
  const countries = new Set<string>();
  for (const checkin of checkins) {
    years.add(yearOf(checkin.at, checkin.offsetMin));
    const place = places.get(checkin.placeId);
    if (place?.category) categories.add(place.category);
    const country = countryOf(place);
    if (country) countries.add(country);
  }
  return {
    years: [...years].sort((a, b) => b - a),
    categories: [...categories].sort((a, b) => a.localeCompare(b)),
    countries: [...countries].sort(),
  };
}

export interface Row {
  readonly kind: 'row';
  readonly checkin: CheckinView;
  readonly place: PlaceView | undefined;
  readonly time: string;
  /** The first line of the note, or nothing. */
  readonly line: string;
  /** The id of the first photo, if there is one. */
  readonly photo: string | undefined;
}
export interface DayHeader {
  readonly kind: 'day';
  /** `YYYY-MM-DD`. */
  readonly date: string;
  /** How many different places the day had. */
  readonly places: number;
  readonly checkins: number;
}
export type Item = Row | DayHeader;

/** The heights of what is drawn, in pixels: fixed, which is what lets a window be worked out without measuring ten thousand rows. */
export const ROW_HEIGHT = 72;
export const DAY_HEIGHT = 44;
export const heightOf = (item: Item): number => (item.kind === 'day' ? DAY_HEIGHT : ROW_HEIGHT);

/** The first line of a note: up to the first line break, trimmed. */
export const firstLine = (note: string | undefined): string =>
  (note ?? '').split(/\r?\n/, 1)[0]?.trim() ?? '';

/**
 * The timeline as items to draw: **newest first by the clock where each was made, a day header for each day with that day's place count**, and the rows of the day newest first. A tie is ordered by id, so every device draws the same.
 */
export function buildItems(
  checkins: readonly CheckinView[],
  places: ReadonlyMap<string, PlaceView>,
): Item[] {
  // By the clock where each was made, so that a day is one run of rows: ordered by the moment alone, check-ins in different zones would cut one day into pieces. The same wall-clock time is ordered by the moment, then by id.
  const wall = (c: CheckinView) => c.at + c.offsetMin * 60_000;
  const ordered = [...checkins].sort(
    (a, b) => wall(b) - wall(a) || b.at - a.at || a.id.localeCompare(b.id),
  );
  const items: Item[] = [];
  let header: { index: number; date: string; places: Set<string>; count: number } | undefined;
  const close = () => {
    if (!header) return;
    items[header.index] = {
      kind: 'day',
      date: header.date,
      places: header.places.size,
      checkins: header.count,
    };
  };
  for (const checkin of ordered) {
    const date = localDateOf(checkin);
    if (!header || header.date !== date) {
      close();
      header = { index: items.length, date, places: new Set(), count: 0 };
      items.push({ kind: 'day', date, places: 0, checkins: 0 });
    }
    header.places.add(checkin.placeId);
    header.count++;
    items.push({
      kind: 'row',
      checkin,
      place: places.get(checkin.placeId),
      time: localTimeOf(checkin),
      line: firstLine(checkin.note),
      photo: checkin.photos?.[0],
    });
  }
  close();
  return items;
}

/** Where each item starts, and the whole height: prefix sums, once for a list, so that the window is a search and not a sum. */
export function layout(items: readonly Item[]): { offsets: number[]; total: number } {
  const offsets = new Array<number>(items.length);
  let at = 0;
  for (let i = 0; i < items.length; i++) {
    offsets[i] = at;
    at += heightOf(items[i] as Item);
  }
  return { offsets, total: at };
}

/** The first item whose bottom is below `y`: a binary search over the offsets. */
function firstBelow(offsets: readonly number[], items: readonly Item[], y: number): number {
  let low = 0;
  let high = items.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if ((offsets[mid] as number) + heightOf(items[mid] as Item) <= y) low = mid + 1;
    else high = mid;
  }
  return low;
}

/** The items that need drawing for a viewport scrolled `top` pixels and `height` tall, with `overscan` pixels beyond each edge so that a fast scroll shows no gap: `[start, end)`. */
export function windowOf(
  items: readonly Item[],
  offsets: readonly number[],
  top: number,
  height: number,
  overscan = 400,
): { start: number; end: number } {
  if (items.length === 0) return { start: 0, end: 0 };
  const start = firstBelow(offsets, items, Math.max(0, top - overscan));
  let end = firstBelow(offsets, items, top + height + overscan);
  end = Math.min(items.length, end + 1);
  return { start, end };
}

/** Which row to scroll to so that a check-in is in view: its top offset, or `undefined` when it is not in this list. */
export function offsetOfCheckin(
  items: readonly Item[],
  offsets: readonly number[],
  id: string,
): number | undefined {
  const at = items.findIndex((item) => item.kind === 'row' && item.checkin.id === id);
  return at < 0 ? undefined : offsets[at];
}

/** The check-in a path names: `/c/<id>`, with an id that is one, and nothing else. */
export function checkinIdOf(path: string): string | undefined {
  return /^\/c\/([A-Za-z0-9_-]{1,64})\/?$/.exec(path)?.[1];
}

/** The query to carry from the timeline to a check-in and back: the filters, and nothing else (the sheet's `checkin` and its id are not part of where a person is). */
export function carriedQuery(search: string | URLSearchParams): string {
  const params = new URLSearchParams(typeof search === 'string' ? search : search.toString());
  const keep = new URLSearchParams();
  for (const key of ['year', 'category', 'country', 'q']) {
    const value = params.get(key);
    if (value) keep.set(key, value);
  }
  const query = keep.toString();
  return query === '' ? '' : `?${query}`;
}

/** The icon for a place's category (§20.6): a few that are plain, and a pin for anything else. */
export function categoryIcon(
  category: string | undefined,
): 'coffee' | 'beer' | 'wine' | 'pizza' | 'map-pin' {
  const c = normalizeName(category ?? '');
  if (/\b(cafe|coffee)\b/.test(c)) return 'coffee';
  if (/\b(bar|pub|brewery)\b/.test(c)) return 'beer';
  if (/\b(wine|winery)\b/.test(c)) return 'wine';
  if (/\b(restaurant|pizza|pizzeria|food)\b/.test(c)) return 'pizza';
  return 'map-pin';
}
