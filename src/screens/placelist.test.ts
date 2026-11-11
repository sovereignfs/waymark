import { describe, expect, it } from 'vitest';
import type { CheckinView, PlaceView } from '../actions/types';
import {
  checkinsAt,
  filterStats,
  placeIdOf,
  placeLine,
  placeStats,
  visitsSentence,
  windowRows,
} from './placelist';

const place = (id: string, name: string, over: Partial<PlaceView> = {}): PlaceView => ({
  id,
  name,
  lat: 0,
  lng: 0,
  source: 'manual',
  tz: 'UTC',
  countryCode: null,
  version: 1,
  ...over,
});
const checkin = (id: string, placeId: string, at: number): CheckinView => ({
  id,
  placeId,
  at,
  tz: 'UTC',
  offsetMin: 0,
  companions: [],
  tripId: null,
  linkSource: null,
  share: 'trip',
  source: 'live',
  version: 1,
});

const DAY = 86_400_000;
const PLACES = [
  place('a', 'Café Central', { category: 'Café', address: { city: 'Vienna', country: 'Austria' } }),
  place('b', 'Sé de Lisboa', { category: 'Church', address: { city: 'Lisbon' } }),
  place('c', 'Home'),
  place('d', 'Zürich Hauptbahnhof'),
];
const CHECKINS = [
  checkin('1', 'a', 10 * DAY),
  checkin('2', 'a', 30 * DAY),
  checkin('3', 'a', 20 * DAY),
  checkin('4', 'b', 40 * DAY),
  checkin('5', 'c', 5 * DAY),
  checkin('6', 'c', 50 * DAY),
];

describe('the places by how often', () => {
  const stats = placeStats(PLACES, CHECKINS);

  it('counts the visits, with the first and the last, most visited first, then by the latest visit, with the unused last', () => {
    expect(stats.map((s) => [s.place.id, s.visits])).toEqual([
      ['a', 3],
      ['c', 2],
      ['b', 1],
      ['d', 0],
    ]);
    const a = stats[0];
    expect(a?.first?.at).toBe(10 * DAY);
    expect(a?.last?.at).toBe(30 * DAY);
    expect(stats[3]?.first).toBeUndefined();
  });

  it('is the same whatever order the rows come in', () => {
    const reversed = placeStats([...PLACES].reverse(), [...CHECKINS].reverse());
    expect(reversed.map((s) => s.place.id)).toEqual(stats.map((s) => s.place.id));
  });

  it('breaks a tie by the latest visit, then by name', () => {
    const tie = placeStats(
      [place('x', 'Beta'), place('y', 'Alpha'), place('z', 'Gamma')],
      [checkin('1', 'x', 1), checkin('2', 'y', 1), checkin('3', 'z', 2)],
    );
    expect(tie.map((s) => s.place.id)).toEqual(['z', 'y', 'x']);
  });

  it('ignores a check-in at a place the device does not hold', () => {
    expect(placeStats(PLACES, [checkin('9', 'nowhere', 1)]).every((s) => s.visits === 0)).toBe(
      true,
    );
  });
});

describe('searching the places', () => {
  const stats = placeStats(PLACES, CHECKINS);
  const ids = (q: string) => filterStats(stats, q).map((s) => s.place.id);

  it('finds by name, category and address, every word in any order, with no case or accents, keeping the order', () => {
    expect(ids('')).toEqual(['a', 'c', 'b', 'd']);
    expect(ids('central')).toEqual(['a']);
    expect(ids('vienna cafe')).toEqual(['a']);
    expect(ids('SE LISBOA')).toEqual(['b']);
    expect(ids('zurich')).toEqual(['d']);
    expect(ids('church lisbon')).toEqual(['b']);
    expect(ids('nothing like this')).toEqual([]);
  });

  it('treats a hostile search as words, not as a pattern: punctuation is no word, so it narrows nothing', () => {
    expect(ids('.*')).toEqual(['a', 'c', 'b', 'd']);
    expect(ids('(((')).toEqual(['a', 'c', 'b', 'd']);
    expect(ids('cafe.*')).toEqual(['a']);
    expect(ids('[a-z]+ central')).toEqual([]);
  });
});

describe('a place’s page', () => {
  it('reads the place an address names, and nothing else', () => {
    expect(placeIdOf('/places/abc-123')).toBe('abc-123');
    expect(placeIdOf('/places/abc-123/')).toBe('abc-123');
    for (const bad of ['/places', '/places/', '/places/a/b', '/places/a b', '/c/abc', '/places/..'])
      expect(placeIdOf(bad)).toBeUndefined();
  });

  it('lists the check-ins there, newest first', () => {
    expect(checkinsAt(CHECKINS, 'a').map((c) => c.id)).toEqual(['2', '3', '1']);
    expect(checkinsAt(CHECKINS, 'd')).toEqual([]);
  });

  it('says how often in a sentence', () => {
    expect(visitsSentence(0)).toBe("You haven't checked in here yet");
    expect(visitsSentence(1)).toBe("You've been here once");
    expect(visitsSentence(4)).toBe("You've been here 4 times");
  });

  it('puts a category and where a place is on one line, whichever of them it has', () => {
    expect(placeLine(PLACES[0] as PlaceView)).toBe('Café · Vienna, Austria');
    expect(placeLine(PLACES[2] as PlaceView)).toBe('');
  });
});

describe('the rows to draw', () => {
  it('draws the rows in view and a few either side, never more than there are', () => {
    expect(windowRows(10_000, 64, 0, 640)).toEqual({ start: 0, end: 16 });
    expect(windowRows(10_000, 64, 6400, 640)).toEqual({ start: 94, end: 116 });
    expect(windowRows(10_000, 64, 64 * 9990, 640)).toEqual({ start: 9984, end: 10_000 });
    expect(windowRows(0, 64, 0, 640)).toEqual({ start: 0, end: 0 });
    expect(windowRows(5, 64, 0, 10_000)).toEqual({ start: 0, end: 5 });
  });

  it('is a few dozen rows at any scroll position of ten thousand', () => {
    for (const top of [0, 1, 63, 64, 123_456, 639_000, 9_999_999]) {
      const { start, end } = windowRows(10_000, 64, top, 800);
      expect(end - start).toBeLessThan(40);
    }
  });
});
