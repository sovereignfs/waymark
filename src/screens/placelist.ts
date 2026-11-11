import type { CheckinView, PlaceView } from '../actions/types';
import { normalizeName } from '../places/match';
import { searchPlaces } from '../places/search';

/**
 * The places screen, apart from how it looks (DESIGN.md §20.8): **a person's places by how often they have been, with a search**, and what a place's page says of itself: how many times, the first and the last
 * visit, and its check-ins newest first. Pure, on the rows the device holds, and read the way the figures read them (a place is one record and a visit is a check-in at it, §7.1). Nothing here asks the
 * server: the list is painted from the device's store.
 */
export interface PlaceStat {
  readonly place: PlaceView;
  /** Check-ins at the place. A place with none (made by hand and never used) is still listed, last. */
  readonly visits: number;
  /** The moment of the first and of the last, or undefined for none. */
  readonly first: Pick<CheckinView, 'at' | 'offsetMin'> | undefined;
  readonly last: Pick<CheckinView, 'at' | 'offsetMin'> | undefined;
}

/** The place a path names: `/places/<id>`, with an id that is one, and nothing else. */
export function placeIdOf(path: string): string | undefined {
  return /^\/places\/([A-Za-z0-9_-]{1,64})\/?$/.exec(path)?.[1];
}

/** Every place with its count and its first and last visit, **most visited first**; equal counts by the latest visit, then by name, then by id, so the order is the same on every device. */
export function placeStats(
  places: readonly PlaceView[],
  checkins: readonly CheckinView[],
): PlaceStat[] {
  const seen = new Map<string, { visits: number; first?: CheckinView; last?: CheckinView }>();
  for (const checkin of checkins) {
    const each = seen.get(checkin.placeId) ?? { visits: 0 };
    each.visits += 1;
    if (!each.first || checkin.at < each.first.at) each.first = checkin;
    if (!each.last || checkin.at > each.last.at) each.last = checkin;
    seen.set(checkin.placeId, each);
  }
  const stats = places.map((place): PlaceStat => {
    const each = seen.get(place.id);
    return {
      place,
      visits: each?.visits ?? 0,
      first: each?.first && { at: each.first.at, offsetMin: each.first.offsetMin },
      last: each?.last && { at: each.last.at, offsetMin: each.last.offsetMin },
    };
  });
  return stats.sort(
    (a, b) =>
      b.visits - a.visits ||
      (b.last?.at ?? 0) - (a.last?.at ?? 0) ||
      normalizeName(a.place.name).localeCompare(normalizeName(b.place.name)) ||
      a.place.id.localeCompare(b.place.id),
  );
}

/** The stats whose place's name, category or address hold every word of what was typed (any order, no case or accents); the order is kept. An empty search is all of them. */
export function filterStats(stats: readonly PlaceStat[], query: string): PlaceStat[] {
  if (normalizeName(query) === '') return [...stats];
  const found = new Set(
    searchPlaces(
      stats.map((stat) => stat.place),
      query,
      { limit: stats.length },
    ).map((each) => each.place.id),
  );
  return stats.filter((stat) => found.has(stat.place.id));
}

/** The check-ins at a place, newest first (the same moment by id, so the order is the same everywhere). */
export function checkinsAt(checkins: readonly CheckinView[], placeId: string): CheckinView[] {
  return checkins
    .filter((each) => each.placeId === placeId)
    .sort((a, b) => b.at - a.at || a.id.localeCompare(b.id));
}

/** "You've been here 4 times" (§20.8): what the place's page says about how often. */
export function visitsSentence(visits: number): string {
  if (visits === 0) return "You haven't checked in here yet";
  if (visits === 1) return "You've been here once";
  return `You've been here ${visits} times`;
}

/** The rows of a list of fixed height that need drawing for a scroll position, with a few either side so that fast scrolling shows no gap. */
export function windowRows(
  count: number,
  rowHeight: number,
  top: number,
  height: number,
  overscan = 6,
): { start: number; end: number } {
  if (count <= 0 || rowHeight <= 0) return { start: 0, end: 0 };
  const first = Math.floor(Math.max(0, top) / rowHeight);
  const last = Math.ceil((Math.max(0, top) + Math.max(0, height)) / rowHeight);
  return {
    start: Math.max(0, Math.min(count, first - overscan)),
    end: Math.max(0, Math.min(count, last + overscan)),
  };
}

/** The line under a place's name in the list: its category and where it is, as far as it is known. */
export function placeLine(place: Pick<PlaceView, 'category' | 'address'>): string {
  const where = [place.address?.city, place.address?.country].filter(Boolean).join(', ');
  return [place.category, where].filter(Boolean).join(' · ');
}
