import { describe, expect, it } from 'vitest';
import type { CheckinView, PlaceView } from '../actions/types';
import { fitKeyOf, mapPlacesOf, markerLabel, markersOf } from './mapview';
import { NO_FILTERS, parseFilters } from './timeline';

/** The map of everywhere (DESIGN.md §20.7) without a map: the places the filtered check-ins are at, each once. */
const place = (
  id: string,
  name: string,
  lat: number,
  lng: number,
  over: Partial<PlaceView> = {},
): PlaceView =>
  ({
    id,
    name,
    lat,
    lng,
    source: 'manual',
    tz: 'Europe/Paris',
    countryCode: 'FR',
    version: 1,
    ...over,
  }) as PlaceView;
const at = (iso: string) => Date.parse(`${iso}Z`);
const checkin = (
  id: string,
  placeId: string,
  when: string,
  over: Partial<CheckinView> = {},
): CheckinView =>
  ({
    id,
    placeId,
    at: at(when),
    tz: 'Europe/Paris',
    offsetMin: 60,
    companions: [],
    tripId: null,
    linkSource: null,
    share: 'trip',
    source: 'live',
    version: 1,
    ...over,
  }) as CheckinView;

const PLACES = [
  place('flore', 'Café de Flore', 48.85, 2.33, { category: 'Cafe' }),
  place('eiffel', 'Tour Eiffel', 48.86, 2.29, { category: 'Landmark' }),
  place('tokyo', 'Tokyo Tower', 35.66, 139.75, { countryCode: 'JP', category: 'Landmark' }),
  place('unused', 'Never been', 0, 0),
];
const CHECKINS = [
  checkin('c1', 'flore', '2025-03-01T10:00'),
  checkin('c2', 'flore', '2026-03-02T10:00'),
  checkin('c3', 'flore', '2026-03-09T10:00', { note: 'rain' }),
  checkin('c4', 'eiffel', '2026-03-03T10:00', { tripId: 'trip-1' }),
  checkin('c5', 'tokyo', '2026-05-01T10:00'),
];

describe('the places on the map', () => {
  it('are each place once with how often, most visited first (then the latest), and not a place nobody checked in at', () => {
    const got = mapPlacesOf(CHECKINS, PLACES, NO_FILTERS);
    expect(got.map((each) => [each.place.id, each.visits])).toEqual([
      ['flore', 3],
      ['tokyo', 1],
      ['eiffel', 1],
    ]);
    expect(got[0]?.lastCheckinId).toBe('c3');
    expect(got.some((each) => each.place.id === 'unused')).toBe(false);
  });

  it('are narrowed by the timeline’s filters, the visits counting only the check-ins that match', () => {
    expect(
      mapPlacesOf(CHECKINS, PLACES, parseFilters('year=2026')).map((e) => [e.place.id, e.visits]),
    ).toEqual([
      ['flore', 2],
      ['tokyo', 1],
      ['eiffel', 1],
    ]);
    expect(
      mapPlacesOf(CHECKINS, PLACES, parseFilters('country=JP')).map((e) => e.place.id),
    ).toEqual(['tokyo']);
    expect(
      mapPlacesOf(CHECKINS, PLACES, parseFilters('category=Landmark')).map((e) => e.place.id),
    ).toEqual(['tokyo', 'eiffel']);
    expect(
      mapPlacesOf(CHECKINS, PLACES, parseFilters('q=rain')).map((e) => [e.place.id, e.visits]),
    ).toEqual([['flore', 1]]);
    expect(
      mapPlacesOf(CHECKINS, PLACES, parseFilters('trip=0a1b2c3d-1111-4222-8333-444455556666')),
    ).toEqual([]);
  });

  it('are the markers and the list at once: the same rows, one marker for each, saying the place and how often', () => {
    const got = mapPlacesOf(CHECKINS, PLACES, NO_FILTERS);
    const markers = markersOf(got);
    expect(markers.map((m) => m.id)).toEqual(got.map((e) => e.place.id));
    expect(markers[0]).toMatchObject({ lat: 48.85, lng: 2.33, label: 'Café de Flore, 3 visits' });
    expect(markerLabel(got[2] as never)).toBe('Tour Eiffel, 1 visit');
  });

  it('are the same whatever order the rows come in, and fit again only when the set changes', () => {
    const a = mapPlacesOf(CHECKINS, PLACES, NO_FILTERS);
    const b = mapPlacesOf([...CHECKINS].reverse(), [...PLACES].reverse(), NO_FILTERS);
    expect(b.map((e) => e.place.id)).toEqual(a.map((e) => e.place.id));
    expect(fitKeyOf(a)).toBe(fitKeyOf(b));
    expect(fitKeyOf(a)).not.toBe(
      fitKeyOf(mapPlacesOf(CHECKINS, PLACES, parseFilters('country=JP'))),
    );
  });

  it('are a few hundred markers for a decade of check-ins, built quickly', () => {
    const places = Array.from({ length: 400 }, (_, i) =>
      place(`p${i}`, `Place ${i}`, (i % 80) - 40, (i % 160) - 80),
    );
    const checkins = Array.from({ length: 10_000 }, (_, i) =>
      checkin(`c${i}`, `p${i % 400}`, `${2016 + (i % 10)}-06-15T12:00`),
    );
    const started = performance.now();
    const got = mapPlacesOf(checkins, places, NO_FILTERS);
    expect(performance.now() - started).toBeLessThan(1000);
    expect(got).toHaveLength(400);
    expect(got.reduce((sum, e) => sum + e.visits, 0)).toBe(10_000);
  });
});
