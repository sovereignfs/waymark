import { describe, expect, it } from 'vitest';
import type { CheckinView, PlaceView } from '../actions/types';
import { figures } from '../figures/figures';
import {
  DAY_HEIGHT,
  ROW_HEIGHT,
  buildItems,
  carriedQuery,
  categoryIcon,
  checkinIdOf,
  filterCheckins,
  filterOptions,
  filterParams,
  firstLine,
  isFiltered,
  layout,
  localDateOf,
  localTimeOf,
  offsetOfCheckin,
  parseFilters,
  windowOf,
} from './timeline';

/**
 * The timeline (DESIGN.md §20.6) without a browser: days in each check-in's own zone, the filters of the query, the counts the figures give, and the window of rows that is drawn for **a decade**.
 */
const place = (id: string, name: string, over: Partial<PlaceView> = {}): PlaceView => ({
  id,
  name,
  lat: 0,
  lng: 0,
  source: 'manual',
  tz: null,
  countryCode: null,
  version: 1,
  ...over,
});
const checkin = (
  id: string,
  placeId: string,
  at: number,
  offsetMin: number,
  over: Partial<CheckinView> = {},
): CheckinView => ({
  id,
  placeId,
  at,
  tz: 'Europe/Lisbon',
  offsetMin,
  companions: [],
  tripId: null,
  linkSource: null,
  share: 'trip',
  source: 'live',
  version: 1,
  ...over,
});
const at = (iso: string) => Date.parse(`${iso}Z`);
const PLACES = [
  place('flore', 'Café de Flore', { category: 'Cafe', countryCode: 'FR' }),
  place('eiffel', 'Tour Eiffel', { category: 'Landmark', countryCode: 'FR' }),
  place('se', 'Sé de Lisboa', { category: 'Church', countryCode: 'PT' }),
  place('tokyo', 'Tokyo Tower', { category: 'Landmark', countryCode: 'JP' }),
];
const MAP = new Map(PLACES.map((p) => [p.id, p]));
const CHECKINS = [
  checkin('c1', 'flore', at('2025-12-31T23:30'), 60, {
    note: 'New Year coffee\nsecond line',
    companions: ['Ada'],
  }),
  checkin('c2', 'flore', at('2026-03-10T10:00'), 60),
  checkin('c3', 'eiffel', at('2026-03-10T15:00'), 60, { note: 'The view' }),
  checkin('c4', 'se', at('2026-05-01T12:00'), 60, { photos: ['p1', 'p2'] }),
  checkin('c5', 'tokyo', at('2026-12-31T20:00'), 540),
];

describe('days, in each check-in’s own zone', () => {
  it('reads the date and the time on the clock where it was made, not in UTC and not on the reader’s', () => {
    expect(localDateOf(CHECKINS[0] as CheckinView)).toBe('2026-01-01'); // 23:30 UTC, 00:30 in Lisbon in summer: a new year
    expect(localTimeOf(CHECKINS[0] as CheckinView)).toBe('00:30');
    expect(localDateOf(CHECKINS[4] as CheckinView)).toBe('2027-01-01');
    expect(localTimeOf(CHECKINS[4] as CheckinView)).toBe('05:00');
  });

  it('are newest first, each with its check-ins newest first and its count of places', () => {
    const items = buildItems(CHECKINS, MAP);
    expect(
      items.map((i) => (i.kind === 'day' ? `# ${i.date} ${i.checkins}/${i.places}` : i.checkin.id)),
    ).toEqual([
      '# 2027-01-01 1/1',
      'c5',
      '# 2026-05-01 1/1',
      'c4',
      '# 2026-03-10 2/2',
      'c3',
      'c2',
      '# 2026-01-01 1/1',
      'c1',
    ]);
  });

  it('count a place once for a day, however many times it was visited, and order a tie by the moment and then the id', () => {
    const twice = [
      checkin('b', 'flore', at('2026-03-10T10:00'), 60),
      checkin('a', 'flore', at('2026-03-10T10:00'), 60),
      checkin('c', 'se', at('2026-03-10T08:00'), 60),
    ];
    const items = buildItems(twice, MAP);
    expect(items[0]).toMatchObject({ kind: 'day', checkins: 3, places: 2 });
    expect(items.flatMap((i) => (i.kind === 'row' ? [i.checkin.id] : []))).toEqual(['a', 'b', 'c']);
  });

  it('have rows of the place, the time, the first line of the note and the first photo', () => {
    const rows = buildItems(CHECKINS, MAP).flatMap((i) => (i.kind === 'row' ? [i] : []));
    expect(rows.find((r) => r.checkin.id === 'c1')).toMatchObject({
      time: '00:30',
      line: 'New Year coffee',
      photo: undefined,
      place: { name: 'Café de Flore' },
    });
    expect(rows.find((r) => r.checkin.id === 'c4')).toMatchObject({ photo: 'p1', line: '' });
    expect(firstLine('  one \r\ntwo')).toBe('one');
    expect(firstLine(undefined)).toBe('');
    expect(buildItems([], MAP)).toEqual([]);
  });

  it('still show a check-in whose place the device does not hold', () => {
    const lost = buildItems([checkin('x', 'gone', at('2026-01-01T10:00'), 0)], MAP);
    expect(lost[1]).toMatchObject({ kind: 'row', place: undefined });
  });
});

describe('the filters of the query', () => {
  it('are read from it, and anything that is not one is no filter', () => {
    expect(parseFilters('year=2026&category=Cafe&country=fr&q=%20the%20%20view%20')).toEqual({
      year: 2026,
      category: 'Cafe',
      country: 'FR',
      q: 'the view',
    });
    expect(parseFilters(new URLSearchParams('year=26&country=FRA&q='))).toEqual({
      year: undefined,
      category: undefined,
      country: undefined,
      q: '',
    });
    for (const hostile of [
      'year=2026;drop&country=%3Cscript%3E',
      'year=-1',
      'year=2026.5',
      'country=1',
      'checkin=new',
      'year[]=2026',
    ]) {
      const parsed = parseFilters(hostile);
      expect([parsed.year, parsed.country, parsed.category], hostile).toEqual([
        undefined,
        undefined,
        undefined,
      ]);
    }
    expect(parseFilters('q=' + 'x'.repeat(500)).q).toHaveLength(200);
  });

  it('are written back as a query, with only what is set, and say whether anything is', () => {
    expect(filterParams({ year: 2026, q: 'a b', country: 'PT', category: 'Church' })).toEqual({
      year: '2026',
      category: 'Church',
      country: 'PT',
      q: 'a b',
    });
    expect(filterParams({ q: '' })).toEqual({});
    expect(isFiltered({ q: '' })).toBe(false);
    expect(isFiltered({ q: 'x' })).toBe(true);
    expect(isFiltered({ q: '', year: 2025 })).toBe(true);
  });

  it('keep the check-ins of a year, a category, a country, and a search over the place, the note and who was there, all together', () => {
    const ids = (f: Parameters<typeof filterCheckins>[2]) =>
      filterCheckins(CHECKINS, MAP, f).map((c) => c.id);
    expect(ids({ q: '', year: 2026 })).toEqual(
      ['c2', 'c3', 'c4', 'c5'].filter((id) => id !== 'c5').concat([]).length
        ? ['c1', 'c2', 'c3', 'c4']
        : [],
    );
    expect(ids({ q: '', category: 'Landmark' })).toEqual(['c3', 'c5']);
    expect(ids({ q: '', country: 'FR' })).toEqual(['c1', 'c2', 'c3']);
    expect(ids({ q: 'FLORE' })).toEqual(['c1', 'c2']);
    expect(ids({ q: 'view eiffel' })).toEqual(['c3']); // every word, in any order, in the name or the note
    expect(ids({ q: 'ada' })).toEqual(['c1']); // a companion
    expect(ids({ q: 'cafe', country: 'FR', year: 2026 })).toEqual(['c1', 'c2']);
    expect(ids({ q: 'nothing like this' })).toEqual([]);
    expect(ids({ q: '' })).toEqual(['c1', 'c2', 'c3', 'c4', 'c5']);
  });

  it('read a year as the figures do: the year it was where it was made', () => {
    // c1 is 31 December in UTC and 1 January where it was made, c5 is 31 December in UTC and 1 January in Tokyo.
    expect(filterCheckins(CHECKINS, MAP, { q: '', year: 2025 })).toEqual([]);
    expect(filterCheckins(CHECKINS, MAP, { q: '', year: 2027 }).map((c) => c.id)).toEqual(['c5']);
  });

  it('are offered what the person has: years newest first, categories and countries by name', () => {
    expect(filterOptions(CHECKINS, MAP)).toEqual({
      years: [2027, 2026],
      categories: ['Cafe', 'Church', 'Landmark'],
      countries: ['FR', 'JP', 'PT'],
    });
    expect(filterOptions([], MAP)).toEqual({ years: [], categories: [], countries: [] });
  });

  it('agree with the figures: the count a filter leaves is the count the figures give for it', () => {
    const got = figures(CHECKINS, PLACES, { now: at('2026-11-10T12:00'), offsetMin: 60 });
    for (const year of got.perYear)
      expect(
        filterCheckins(CHECKINS, MAP, { q: '', year: year.year }),
        String(year.year),
      ).toHaveLength(year.checkins);
    for (const country of got.countries)
      expect(
        filterCheckins(CHECKINS, MAP, { q: '', country: country.key }),
        country.key,
      ).toHaveLength(country.checkins);
    expect(filterCheckins(CHECKINS, MAP, { q: '' })).toHaveLength(got.total);
  });
});

/** A decade: ten thousand check-ins over ten years at three hundred places, in several zones, from a generator that is the same each time. */
function decade() {
  let seed = 42;
  const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const places = Array.from({ length: 300 }, (_, i) =>
    place(`p${i}`, `Place ${i}`, {
      category: ['Cafe', 'Park', 'Museum', 'Bar'][i % 4] as string,
      countryCode: ['FR', 'PT', 'JP', 'US', 'DE'][i % 5] as string,
    }),
  );
  const start = Date.UTC(2016, 0, 1);
  const span = 10 * 365 * 86_400_000;
  const checkins = Array.from({ length: 10_000 }, (_, i) =>
    checkin(
      `c${i}`,
      `p${Math.floor(rand() * 300)}`,
      start + Math.floor(rand() * span),
      [0, 60, 120, 540, -300][i % 5] as number,
      rand() < 0.3 ? { note: `Note ${i}` } : {},
    ),
  );
  return { places, checkins, map: new Map(places.map((p) => [p.id, p])) };
}

describe('a decade of check-ins', () => {
  const { places, checkins, map } = decade();

  it('is built into items quickly and filtered quickly, and the filters agree with the figures for every year and country', () => {
    const begun = performance.now();
    const items = buildItems(checkins, map);
    const built = performance.now() - begun;
    expect(items.filter((i) => i.kind === 'row')).toHaveLength(10_000);
    expect(built).toBeLessThan(1000);
    const filtering = performance.now();
    filterCheckins(checkins, map, { q: 'place 1 note', year: 2020, country: 'PT' });
    expect(performance.now() - filtering).toBeLessThan(500);
    const got = figures(checkins, places, { now: Date.UTC(2026, 0, 1), offsetMin: 0 });
    for (const year of got.perYear)
      expect(filterCheckins(checkins, map, { q: '', year: year.year }).length).toBe(year.checkins);
    for (const country of got.countries)
      expect(filterCheckins(checkins, map, { q: '', country: country.key }).length).toBe(
        country.checkins,
      );
    // Days are in order and each check-in is under the day it was in.
    let last = '9999-99-99';
    for (const item of items) {
      if (item.kind === 'day') {
        expect(item.date < last).toBe(true);
        last = item.date;
      } else expect(localDateOf(item.checkin)).toBe(last);
    }
  });

  it('draws a handful of rows at any scroll position, with no gap and none missing, from the top to the very bottom', () => {
    const items = buildItems(checkins, map);
    const { offsets, total } = layout(items);
    expect(total).toBe(
      items.reduce((sum, item) => sum + (item.kind === 'day' ? DAY_HEIGHT : ROW_HEIGHT), 0),
    );
    const viewport = 800;
    for (const top of [
      0,
      1,
      500,
      12_345,
      Math.floor(total / 2),
      total - viewport,
      total - 1,
      total + 5000,
    ]) {
      const { start, end } = windowOf(items, offsets, top, viewport);
      expect(end - start, `at ${top}`).toBeLessThan(40);
      // Everything that is in view is in the window.
      for (let i = 0; i < items.length; i++) {
        const itemTop = offsets[i] as number;
        const bottom = itemTop + (items[i]?.kind === 'day' ? DAY_HEIGHT : ROW_HEIGHT);
        if (bottom > top && itemTop < top + viewport)
          expect(i >= start && i < end, `item ${i} at ${top}`).toBe(true);
        if (i > end + 2 && itemTop > top + viewport + 1000) break;
      }
    }
  });

  it('finds where a check-in is, to scroll to it, and says nothing for one that is not in the list', () => {
    const items = buildItems(checkins, map);
    const { offsets } = layout(items);
    const target = items.find((i) => i.kind === 'row' && i.checkin.id === 'c4321');
    expect(offsetOfCheckin(items, offsets, 'c4321')).toBe(offsets[items.indexOf(target as never)]);
    expect(offsetOfCheckin(items, offsets, 'nope')).toBeUndefined();
  });
});

describe('the address of a check-in, and what is carried to it', () => {
  it('is /c/<id> with an id that is one, and nothing else', () => {
    expect(checkinIdOf('/c/abc-123')).toBe('abc-123');
    expect(checkinIdOf('/c/abc-123/')).toBe('abc-123');
    for (const path of [
      '/c',
      '/c/',
      '/c/a/b',
      '/checkins',
      '/c/../x',
      '/c/a b',
      '/x/c/abc',
      `/c/${'a'.repeat(65)}`,
    ])
      expect(checkinIdOf(path), path).toBeUndefined();
  });

  it('carries the filters from the timeline to a check-in and back, and not the sheet’s query', () => {
    expect(carriedQuery('year=2026&checkin=edit&of=abc&q=a%20b&x=1')).toBe('?year=2026&q=a+b');
    expect(carriedQuery('checkin=new')).toBe('');
    expect(carriedQuery(new URLSearchParams('country=PT'))).toBe('?country=PT');
  });

  it('has an icon for a few categories and a pin for the rest', () => {
    expect([
      categoryIcon('Cafe'),
      categoryIcon('Coffee shop'),
      categoryIcon('Pub'),
      categoryIcon('Wine bar'),
      categoryIcon('Restaurant'),
      categoryIcon('Landmark'),
      categoryIcon(undefined),
    ]).toEqual(['coffee', 'coffee', 'beer', 'beer', 'pizza', 'map-pin', 'map-pin']);
  });
});

describe('the window of a small or empty list', () => {
  it('is nothing for nothing, and all of a short list', () => {
    expect(windowOf([], [], 0, 800)).toEqual({ start: 0, end: 0 });
    const items = buildItems(CHECKINS, MAP);
    const { offsets } = layout(items);
    expect(windowOf(items, offsets, 0, 800)).toEqual({ start: 0, end: items.length });
  });
});
