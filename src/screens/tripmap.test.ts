import { describe, expect, it } from 'vitest';
import type { DayRecord, ItemRecord, StopRecord } from '../sync/trip-format';
import type { SharedCheckin } from '../sharing/read';
import { tripMapOf } from './tripmap';

/** A trip's map (DESIGN.md §8.2, §20.10) without a map: the rows, which are the list and the markers at once. */
const stop = (
  id: string,
  name: string,
  arrive: string | null,
  depart: string | null,
  lat: number,
  lng: number,
): StopRecord =>
  ({
    id,
    place: { id: `p-${id}`, name, lat, lng, tz: 'Europe/Lisbon', countryCode: 'PT' },
    arrive,
    depart,
    position: id,
    version: 1,
  }) as unknown as StopRecord;
const day = (id: string, stopId: string, date: string): DayRecord => ({
  id,
  stopId,
  date,
  title: undefined,
  notes: undefined,
  version: 1,
});
const item = (
  id: string,
  dayId: string,
  position: string,
  over: Record<string, unknown> = {},
): ItemRecord =>
  ({
    id,
    dayId,
    title: id,
    kind: 'activity',
    start: null,
    end: null,
    fixed: false,
    position,
    place: undefined,
    ...over,
  }) as unknown as ItemRecord;
const at = (place: string, lat: number, lng: number) => ({
  id: `p-${place}`,
  name: place,
  lat,
  lng,
});
const shared = (
  id: string,
  authorId: string,
  whenIso: string,
  name: string,
  lat: number,
  lng: number,
): SharedCheckin =>
  ({
    id,
    authorId,
    seq: 1,
    place: { name, lat, lng },
    at: Date.parse(whenIso),
    tz: 'Europe/Lisbon',
    offsetMin: 60,
    companions: [],
    photos: [],
  }) as unknown as SharedCheckin;

const STOPS = [
  stop('b', 'Sintra', '2026-06-12', '2026-06-13', 38.8, -9.38),
  stop('a', 'Lisbon', '2026-06-10', '2026-06-12', 38.72, -9.14),
  stop('c', 'Porto', null, null, 41.15, -8.61),
];
const DAYS = [day('d10', 'a', '2026-06-10'), day('d11', 'a', '2026-06-11')];
const ITEMS = [
  item('late', 'd10', '1', { start: '18:00', place: at('Bar', 38.71, -9.13) }),
  item('note', 'd10', '2', { place: undefined }),
  item('early', 'd10', '3', { start: '09:00', place: at('Café', 38.72, -9.14) }),
  item('castle', 'd10', '4', { place: at('Castelo', 38.713, -9.133) }),
  item('other-day', 'd11', '1', { place: at('Elsewhere', 38.7, -9.1) }),
];
const NAMES = new Map([['grace', 'Grace']]);
const SHARED = [
  shared('s2', 'grace', '2026-06-10T17:30:00Z', 'Miradouro', 38.716, -9.13),
  shared('s1', 'grace', '2026-06-10T08:05:00Z', 'Pastelaria', 38.69, -9.2),
  shared('s3', 'grace', '2026-06-11T12:00:00Z', 'Other day', 38.7, -9.1),
];
const input = { stops: STOPS, days: DAYS, items: ITEMS, shared: SHARED, names: NAMES };

describe('the whole trip', () => {
  const got = tripMapOf(input, { kind: 'trip' });

  it('is the stops in order, numbered, joined by a line, then the shared check-ins by time', () => {
    expect(got.rows.map((row) => row.id)).toEqual([
      'stop:a',
      'stop:b',
      'stop:c',
      'shared:s1',
      'shared:s2',
      'shared:s3',
    ]);
    expect(got.rows.slice(0, 3).map((row) => row.label)).toEqual([
      '1. Lisbon',
      '2. Sintra',
      '3. Porto',
    ]);
    expect(got.line).toEqual([
      { lat: 38.72, lng: -9.14 },
      { lat: 38.8, lng: -9.38 },
      { lat: 41.15, lng: -8.61 },
    ]);
    expect(got.rows[3]?.detail).toBe('Grace, 09:05, checked in');
  });

  it('has the list and the markers the same: every row with a point is a marker and no other', () => {
    expect(got.markers.map((marker) => marker.id)).toEqual(
      got.rows.filter((row) => row.point).map((row) => row.id),
    );
    expect(got.markers.filter((marker) => marker.tone === 'success')).toHaveLength(3);
  });
});

describe('one day', () => {
  const got = tripMapOf(input, { kind: 'day', dayId: 'd10' });

  it('is that day’s items in plan order (timed ones by time), numbered, with the line through them in that order', () => {
    const items = got.rows.filter((row) => row.kind === 'item' && row.number !== undefined);
    // Stored: late(18) note early(09) castle; shown: early, note, late, castle (the timed ones by time, in the timed slots); the note has no place.
    expect(items.map((row) => row.label)).toEqual(['1. early', '2. late', '3. castle']);
    expect(got.line).toEqual([
      { lat: 38.72, lng: -9.14 },
      { lat: 38.71, lng: -9.13 },
      { lat: 38.713, lng: -9.133 },
    ]);
  });

  it('lists what has no place, without a number and not on the map, after the rest', () => {
    const last = got.rows.at(-1);
    expect(last).toMatchObject({ id: 'item:note', label: 'note' });
    expect(last?.number).toBeUndefined();
    expect(last?.point).toBeUndefined();
    expect(last?.detail).toContain('not on the map');
    expect(got.markers.map((marker) => marker.id)).not.toContain('item:note');
  });

  it('has that day’s shared check-ins only, by their own clock, as the second kind of marker', () => {
    const marks = got.markers.filter((marker) => marker.tone === 'success');
    expect(marks.map((marker) => marker.id)).toEqual(['shared:s1', 'shared:s2']);
    // 00:30 local on the next day is that day’s in its own zone, not the viewer’s.
    const late = shared('s9', 'grace', '2026-06-10T23:30:00Z', 'Late', 38.7, -9.1);
    expect(
      tripMapOf({ ...input, shared: [late] }, { kind: 'day', dayId: 'd10' }).rows.some(
        (row) => row.id === 'shared:s9',
      ),
    ).toBe(false);
    expect(
      tripMapOf({ ...input, shared: [late] }, { kind: 'day', dayId: 'd11' }).rows.some(
        (row) => row.id === 'shared:s9',
      ),
    ).toBe(true);
  });

  it('has the list and the markers the same', () => {
    expect(got.markers.map((marker) => marker.id)).toEqual(
      got.rows.filter((row) => row.point).map((row) => row.id),
    );
  });

  it('is an empty day when it has nothing, and the whole trip for a day that is not there', () => {
    expect(
      tripMapOf({ ...input, items: [], shared: [] }, { kind: 'day', dayId: 'd11' }).rows,
    ).toEqual([]);
    expect(tripMapOf(input, { kind: 'day', dayId: 'nope' }).rows[0]?.id).toBe('stop:a');
  });
});

describe('what makes the map fit again', () => {
  it('is the view and how many points it has', () => {
    const a = tripMapOf(input, { kind: 'trip' }).fitKey;
    const b = tripMapOf(input, { kind: 'day', dayId: 'd10' }).fitKey;
    const c = tripMapOf(input, { kind: 'day', dayId: 'd11' }).fitKey;
    expect(new Set([a, b, c]).size).toBe(3);
    expect(tripMapOf(input, { kind: 'trip' }).fitKey).toBe(a);
  });
});
