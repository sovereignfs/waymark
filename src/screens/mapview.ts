import type { CheckinView, PlaceView } from '../actions/types';
import { type PlaceStat, placeStats } from './placelist';
import { type Filters, filterCheckins } from './timeline';

/**
 * The map of everywhere (DESIGN.md §8.2, §20.7), apart from the map itself: **the places the filtered check-ins are at, each once with its visits**, and the list of the same. The filters are the timeline's (`timeline.ts`),
 * read from the same query, so a year, a country, a category, a trip or a search means the same on both screens. A marker is a place and not a check-in: a place checked in at a hundred times is one marker that says so,
 * which keeps a decade of check-ins a few hundred markers, and the map's clustering does the rest. Pure, and the same on the device and in a test: the list and the markers are made from the same rows.
 */
export interface MapPlace extends PlaceStat {
  /** The most recent check-in there (the filtered ones), to open from the marker. */
  readonly lastCheckinId: string;
}

export function mapPlacesOf(
  checkins: readonly CheckinView[],
  places: readonly PlaceView[],
  filters: Filters,
): MapPlace[] {
  const placeMap = new Map(places.map((place) => [place.id, place]));
  const shown = filterCheckins(checkins, placeMap, filters);
  const latest = new Map<string, CheckinView>();
  for (const checkin of shown) {
    const have = latest.get(checkin.placeId);
    if (!have || checkin.at > have.at || (checkin.at === have.at && checkin.id > have.id))
      latest.set(checkin.placeId, checkin);
  }
  const used = places.filter((place) => latest.has(place.id));
  return placeStats(used, shown).flatMap((stat) => {
    const last = latest.get(stat.place.id);
    return last ? [{ ...stat, lastCheckinId: last.id }] : [];
  });
}

export interface PlaceMarker {
  readonly id: string;
  readonly lat: number;
  readonly lng: number;
  readonly label: string;
}

/** What a marker says: the place and how often. */
export const markerLabel = (stat: PlaceStat): string =>
  `${stat.place.name}, ${stat.visits === 1 ? '1 visit' : `${stat.visits} visits`}`;

export const markersOf = (places: readonly MapPlace[]): PlaceMarker[] =>
  places.map((each) => ({
    id: each.place.id,
    lat: each.place.lat,
    lng: each.place.lng,
    label: markerLabel(each),
  }));

/** The map fits again when what it shows changes: a different set of places, not a different selection. */
export const fitKeyOf = (places: readonly MapPlace[]): string =>
  `${places.length}:${places[0]?.place.id ?? ''}:${places.at(-1)?.place.id ?? ''}`;
