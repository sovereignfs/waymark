import { describe, expect, it } from 'vitest';
import { type FigureCheckin, type FigurePlace, figures, placeFigures, yearOf } from './figures';

/**
 * Figures (DESIGN.md §9.5) against **a seed worked out by hand**: ten check-ins at seven places in four countries, over four years, with a New Year's Eve either side of a zone. Every number below was
 * counted from the table, not from the code.
 *
 *   id   place            at (UTC)           offset  local date     trip
 *   c1   p1 Flore (FR)    2025-12-31 23:30   +60     2026-01-01     A
 *   c2   p1               2026-03-10 10:00   +60     2026-03-10     B
 *   c3   p2 Eiffel (FR)   2026-03-10 15:00   +60     2026-03-10
 *   c4   p3 Sé (PT)       2026-05-01 12:00   +60     2026-05-01
 *   c5   p4 Zürich (CH)   2025-06-01 08:00   +120    2025-06-01
 *   c6   p5 Zurich (CH)   2025-06-02 08:00   +120    2025-06-02
 *   c7   p6 (no country)  2025-07-01 00:00   0       2025-07-01
 *   c8   p7 Tokyo (JP)    2026-11-01 00:00   +540    2026-11-01
 *   c9   p7               2026-12-31 20:00   +540    2027-01-01
 *   c10  p1               2024-02-02 12:00   +60     2024-02-02     A
 */
const at = (iso: string) => Date.parse(`${iso}Z`);
const CHECKINS: FigureCheckin[] = [
  { id: 'c1', placeId: 'p1', at: at('2025-12-31T23:30'), offsetMin: 60, tripId: 'A' },
  { id: 'c2', placeId: 'p1', at: at('2026-03-10T10:00'), offsetMin: 60, tripId: 'B' },
  { id: 'c3', placeId: 'p2', at: at('2026-03-10T15:00'), offsetMin: 60 },
  { id: 'c4', placeId: 'p3', at: at('2026-05-01T12:00'), offsetMin: 60 },
  { id: 'c5', placeId: 'p4', at: at('2025-06-01T08:00'), offsetMin: 120 },
  { id: 'c6', placeId: 'p5', at: at('2025-06-02T08:00'), offsetMin: 120 },
  { id: 'c7', placeId: 'p6', at: at('2025-07-01T00:00'), offsetMin: 0 },
  { id: 'c8', placeId: 'p7', at: at('2026-11-01T00:00'), offsetMin: 540 },
  { id: 'c9', placeId: 'p7', at: at('2026-12-31T20:00'), offsetMin: 540 },
  { id: 'c10', placeId: 'p1', at: at('2024-02-02T12:00'), offsetMin: 60, tripId: 'A' },
];
const PLACES: FigurePlace[] = [
  {
    id: 'p1',
    countryCode: 'FR',
    address: { city: 'Paris', region: 'Île-de-France', countryCode: 'FR' },
  },
  {
    id: 'p2',
    countryCode: 'FR',
    address: { city: 'Paris', region: 'Île-de-France', countryCode: 'FR' },
  },
  { id: 'p3', countryCode: 'PT', address: { city: 'Lisboa', region: 'Lisboa', countryCode: 'PT' } },
  { id: 'p4', countryCode: 'CH', address: { city: 'Zürich', region: 'Zürich', countryCode: 'CH' } },
  { id: 'p5', countryCode: 'CH', address: { city: 'Zurich', region: 'Zurich', countryCode: 'CH' } },
  { id: 'p6' },
  { id: 'p7', countryCode: 'JP', address: { city: 'Minato', region: 'Tokyo', countryCode: 'JP' } },
];
// 10 November 2026, noon UTC, for a reader an hour east of UTC: it is 2026 for them.
const OPTIONS = { now: at('2026-11-10T12:00'), offsetMin: 60 };

describe('the figures of a hand-worked seed', () => {
  const got = figures(CHECKINS, PLACES, OPTIONS);

  it('counts the check-ins, this year, and each year by the year it was made in, in its own zone', () => {
    expect(got.total).toBe(10);
    // c1 is 23:30 UTC on 31 December and 00:30 on 1 January where it was made: 2026. c9 is 2027 in Tokyo at 20:00 UTC.
    expect(got.perYear).toEqual([
      { year: 2027, checkins: 1 },
      { year: 2026, checkins: 5 },
      { year: 2025, checkins: 3 },
      { year: 2024, checkins: 1 },
    ]);
    expect(got.thisYear).toBe(5);
  });

  it('counts places once however many times they were visited, including one with no country', () => {
    expect(got.places).toBe(7);
  });

  it('counts countries, by their place’s country code, most visited first and then by code', () => {
    expect(got.countries.map((c) => [c.key, c.checkins])).toEqual([
      ['FR', 4],
      ['CH', 2],
      ['JP', 2],
      ['PT', 1],
    ]);
    expect(got.countries[0]).toEqual({ key: 'FR', name: 'FR', country: undefined, checkins: 4 });
  });

  it('counts regions of a country, one region spelled two ways as one', () => {
    expect(got.regions.map((r) => [r.key, r.checkins])).toEqual([
      ['FR/ile de france', 4],
      ['CH/zurich', 2],
      ['JP/tokyo', 2],
      ['PT/lisboa', 1],
    ]);
    // Called by the first check-in's spelling, in time order: Zürich (2025-06-01) before Zurich (2025-06-02).
    expect(got.regions.find((r) => r.key === 'CH/zurich')).toMatchObject({
      name: 'Zürich',
      country: 'CH',
    });
  });

  it('counts cities of a country, "Zürich" and "Zurich" as one', () => {
    expect(got.cities.map((c) => [c.key, c.name, c.checkins])).toEqual([
      ['FR/paris', 'Paris', 4],
      ['CH/zurich', 'Zürich', 2],
      ['JP/minato', 'Minato', 2],
      ['PT/lisboa', 'Lisboa', 1],
    ]);
  });

  it('reads one place: how many times, the first and the last, and its trips in the order they began', () => {
    expect(placeFigures('p1', CHECKINS)).toEqual({
      times: 3,
      first: at('2024-02-02T12:00'),
      last: at('2026-03-10T10:00'),
      trips: ['A', 'B'],
    });
    expect(placeFigures('p7', CHECKINS)).toEqual({
      times: 2,
      first: at('2026-11-01T00:00'),
      last: at('2026-12-31T20:00'),
      trips: [],
    });
    expect(placeFigures('nowhere', CHECKINS)).toEqual({
      times: 0,
      first: undefined,
      last: undefined,
      trips: [],
    });
  });
});

describe('the same rows give the same figures', () => {
  it('whatever order they come in, which is what makes the device and the server agree', () => {
    const want = figures(CHECKINS, PLACES, OPTIONS);
    let seed = 7;
    const shuffled = <T>(items: readonly T[]) => {
      const out = [...items];
      for (let i = out.length - 1; i > 0; i--) {
        seed = (seed * 1103515245 + 12345) % 2147483648;
        const j = seed % (i + 1);
        [out[i], out[j]] = [out[j] as T, out[i] as T];
      }
      return out;
    };
    for (let i = 0; i < 25; i++) {
      expect(figures(shuffled(CHECKINS), shuffled(PLACES), OPTIONS)).toEqual(want);
      expect(placeFigures('p1', shuffled(CHECKINS))).toEqual(placeFigures('p1', CHECKINS));
    }
  });

  it('whatever zone the machine is in: a year is read from the moment and its own offset, not from where it is counted', () => {
    expect(yearOf(at('2025-12-31T23:30'), 60)).toBe(2026);
    expect(yearOf(at('2025-12-31T23:30'), 0)).toBe(2025);
    expect(yearOf(at('2026-01-01T00:30'), -60)).toBe(2025);
    expect(yearOf(at('2026-12-31T20:00'), 540)).toBe(2027);
    // And what "this year" is depends on the reader's offset alone.
    const late = { now: at('2026-12-31T23:30'), offsetMin: 0 };
    expect(figures(CHECKINS, PLACES, late).thisYear).toBe(5); // 2026
    expect(figures(CHECKINS, PLACES, { ...late, offsetMin: 60 }).thisYear).toBe(1); // already 2027 for a reader an hour east
  });

  it('for a person with nothing, and for check-ins at a place the device does not hold', () => {
    expect(figures([], [], OPTIONS)).toEqual({
      total: 0,
      thisYear: 0,
      perYear: [],
      places: 0,
      countries: [],
      regions: [],
      cities: [],
    });
    const lost = figures(
      [{ id: 'x', placeId: 'unknown', at: at('2026-01-01T00:00'), offsetMin: 0 }],
      [],
      OPTIONS,
    );
    expect(lost).toMatchObject({ total: 1, places: 1, countries: [], regions: [], cities: [] });
  });

  it('counts a city only within its country: two Parises are two', () => {
    const places: FigurePlace[] = [
      { id: 'fr', countryCode: 'FR', address: { city: 'Paris' } },
      { id: 'us', countryCode: 'US', address: { city: 'Paris', region: 'Texas' } },
    ];
    const checkins: FigureCheckin[] = [
      { id: '1', placeId: 'fr', at: 1, offsetMin: 0 },
      { id: '2', placeId: 'us', at: 2, offsetMin: 0 },
    ];
    expect(figures(checkins, places, OPTIONS).cities.map((c) => c.key)).toEqual([
      'FR/paris',
      'US/paris',
    ]);
  });
});

describe('nothing that rewards', () => {
  it('has the figures of §9.5 and no streak, badge, point or rank, in a person’s or a place’s', () => {
    expect(Object.keys(figures(CHECKINS, PLACES, OPTIONS)).sort()).toEqual([
      'cities',
      'countries',
      'perYear',
      'places',
      'regions',
      'thisYear',
      'total',
    ]);
    expect(Object.keys(placeFigures('p1', CHECKINS)).sort()).toEqual([
      'first',
      'last',
      'times',
      'trips',
    ]);
    const everything = JSON.stringify([
      figures(CHECKINS, PLACES, OPTIONS),
      placeFigures('p1', CHECKINS),
    ]);
    expect(everything).not.toMatch(
      /streak|badge|points?|rank|mayor|leaderboard|level|achievement/i,
    );
  });
});
