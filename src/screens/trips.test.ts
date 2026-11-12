import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { TripEntry } from '../local/db';
import { TRIP_COLORS } from '../trips/format';
import { definedTokens } from '../ui/design-tokens';
import {
  DOT,
  actionFor,
  cardOf,
  cardsOf,
  chipCounts,
  datesText,
  daysText,
  groupTrips,
  initials,
  sidebarTrips,
} from './trips';

/** The trips list and the sidebar's section (DESIGN.md §20.2, §20.9), decided on the device from the rows it holds. */
const at = (iso: string) => Date.parse(iso);
const NOW = at('2026-06-15T12:00:00Z');

interface Spec {
  id: string;
  name?: string;
  start?: string | null;
  end?: string | null;
  ready?: boolean;
  role?: string;
  going?: boolean;
  stops?: { name: string; tz?: string | null; position?: string }[];
  members?: string[];
  updated?: number;
  color?: string;
}
function entry(spec: Spec): TripEntry {
  const stops = spec.stops ?? [{ name: 'Lisbon', tz: 'Europe/Lisbon' }];
  return {
    id: spec.id,
    role: spec.role ?? 'organizer',
    cursor: 1,
    floor: 0,
    head: 1,
    sets: {
      trip: {
        id: spec.id,
        name: spec.name ?? spec.id,
        color: spec.color ?? 'accent',
        startDate: spec.start === undefined ? '2026-06-10' : spec.start,
        endDate: spec.end === undefined ? '2026-06-20' : spec.end,
        readyAt: spec.ready === false ? null : 1,
        going: spec.going ?? true,
        updatedAt: spec.updated ?? 1,
      },
      stops: stops.map((stop, index) => ({
        id: `${spec.id}-s${index}`,
        arrive: spec.start ?? null,
        depart: spec.end ?? null,
        position: stop.position ?? `0000${index + 1}000`,
        place: { name: stop.name, tz: stop.tz === undefined ? 'Europe/Lisbon' : stop.tz },
      })),
      members: (spec.members ?? ['Ada Lovelace']).map((name) => ({ name })),
      days: [],
      links: [],
      done: [],
    },
  } as unknown as TripEntry;
}

describe('a card', () => {
  it('has the name, colour, dates, days, stops in order, people and one action', () => {
    const card = cardOf(
      entry({
        id: 'japan',
        name: 'Japan 2027',
        start: '2026-06-10',
        end: '2026-06-20',
        color: 'info',
        stops: [
          { name: 'Kyoto', position: '00002000' },
          { name: 'Tokyo', position: '00001000' },
          { name: 'Osaka', position: '00003000' },
        ],
        members: ['Ada Lovelace', 'Grace Hopper'],
      }),
      NOW,
    );
    expect(card).toMatchObject({
      id: 'japan',
      name: 'Japan 2027',
      color: 'info',
      status: 'ongoing',
      days: 11,
      stops: ['Kyoto', 'Tokyo', 'Osaka'].sort(
        (a, b) => ['Tokyo', 'Kyoto', 'Osaka'].indexOf(a) - ['Tokyo', 'Kyoto', 'Osaka'].indexOf(b),
      ),
      people: [{ name: 'Ada Lovelace' }, { name: 'Grace Hopper' }],
      action: { label: 'Open Trip Mode', href: '/t/japan/today' },
    });
  });

  it('is none for a trip the device has not been given the rows of', () => {
    expect(
      cardOf({ id: 'x', role: 'traveler', cursor: 0, floor: 0, head: 0, sets: undefined }, NOW),
    ).toBeUndefined();
    expect(
      cardsOf(
        [
          entry({ id: 'a' }),
          { id: 'x', role: 'traveler', cursor: 0, floor: 0, head: 0, sets: undefined },
        ],
        NOW,
      ),
    ).toHaveLength(1);
  });

  it('has a status from the dates and the clock, in the first stop’s zone and not the reader’s', () => {
    // 22:00 UTC on 14 June is 10:00 on the 15th in Auckland and 23:00 on the 14th in Lisbon.
    const now = at('2026-06-14T22:00:00Z');
    const trip = (tz: string) =>
      entry({ id: 't', start: '2026-06-15', end: '2026-06-20', stops: [{ name: 'Stop', tz }] });
    expect(cardOf(trip('Pacific/Auckland'), now)?.status).toBe('ongoing');
    expect(cardOf(trip('Europe/Lisbon'), now)?.status).toBe('upcoming');
    expect(cardOf(entry({ id: 'u', start: '2026-06-20', end: '2026-06-25' }), NOW)?.status).toBe(
      'upcoming',
    );
    expect(cardOf(entry({ id: 'c', start: '2026-05-01', end: '2026-05-09' }), NOW)?.status).toBe(
      'completed',
    );
    expect(cardOf(entry({ id: 'p', ready: false }), NOW)).toMatchObject({ status: 'planning' });
    expect(cardOf(entry({ id: 'n', start: null, end: null, ready: true }), NOW)).toMatchObject({
      status: 'planning',
      days: null,
    });
  });

  it('says it is planning with dates that have passed, so the person can still mark it ready', () => {
    expect(
      cardOf(entry({ id: 'p', start: '2026-05-01', end: '2026-05-09', ready: false }), NOW),
    ).toMatchObject({
      status: 'planning',
      datesPassed: true,
    });
  });
});

describe('the action', () => {
  it('is Continue planning, View plan, Open Trip Mode or Open journal by status', () => {
    expect(actionFor('a', 'planning', 'organizer', true)).toEqual({
      label: 'Continue planning',
      href: '/t/a?view=plan',
    });
    expect(actionFor('a', 'upcoming', 'traveler', true)).toEqual({
      label: 'View plan',
      href: '/t/a?view=plan',
    });
    expect(actionFor('a', 'ongoing', 'traveler', true)).toEqual({
      label: 'Open Trip Mode',
      href: '/t/a/today',
    });
    expect(actionFor('a', 'completed', 'organizer', true)).toEqual({
      label: 'Open journal',
      href: '/t/a?view=journal',
    });
  });

  it('gives a Follower the plan and the journal and no Trip Mode, and a member who is not going none either', () => {
    expect(actionFor('a', 'ongoing', 'follower', false)).toEqual({
      label: 'View plan',
      href: '/t/a?view=plan',
    });
    expect(actionFor('a', 'planning', 'follower', false)).toEqual({
      label: 'View plan',
      href: '/t/a?view=plan',
    });
    expect(actionFor('a', 'ongoing', 'organizer', false)).toEqual({
      label: 'View plan',
      href: '/t/a?view=plan',
    });
    expect(actionFor('a', 'completed', 'follower', false).label).toBe('Open journal');
  });
});

describe('the groups', () => {
  const cards = cardsOf(
    [
      entry({ id: 'done-old', name: 'Old', start: '2025-01-01', end: '2025-01-05' }),
      entry({ id: 'done-new', name: 'Newer', start: '2026-05-01', end: '2026-05-05' }),
      entry({ id: 'plan-b', name: 'Beta', ready: false, start: null, end: null, updated: 5 }),
      entry({ id: 'plan-a', name: 'Alpha', ready: false, start: null, end: null, updated: 9 }),
      entry({ id: 'up-late', name: 'Late', start: '2026-09-01', end: '2026-09-05' }),
      entry({ id: 'up-soon', name: 'Soon', start: '2026-07-01', end: '2026-07-05' }),
      entry({ id: 'on', name: 'Now', start: '2026-06-14', end: '2026-06-16' }),
    ],
    NOW,
  );

  it('are ongoing, upcoming by date, planning, and completed newest first', () => {
    const groups = groupTrips(cards, 'all', '');
    expect(groups.map((g) => g.status)).toEqual(['ongoing', 'upcoming', 'planning', 'completed']);
    expect(groups.map((g) => g.trips.map((t) => t.id))).toEqual([
      ['on'],
      ['up-soon', 'up-late'],
      ['plan-a', 'plan-b'],
      ['done-new', 'done-old'],
    ]);
  });

  it('are narrowed by a chip, and by a search over the name and the stops', () => {
    expect(groupTrips(cards, 'upcoming', '').map((g) => g.status)).toEqual(['upcoming']);
    expect(groupTrips(cards, 'ongoing', '')[0]?.trips.map((t) => t.id)).toEqual(['on']);
    expect(groupTrips(cards, 'all', 'soon').flatMap((g) => g.trips.map((t) => t.id))).toEqual([
      'up-soon',
    ]);
    // A stop’s name finds the trip; case, accents and word order do not matter.
    const withStops = cardsOf(
      [entry({ id: 'j', name: 'Trip', stops: [{ name: 'Kyōto' }, { name: 'Osaka' }] })],
      NOW,
    );
    expect(groupTrips(withStops, 'all', 'OSAKA kyoto')).toHaveLength(1);
    expect(groupTrips(withStops, 'all', 'paris')).toEqual([]);
    expect(groupTrips(cards, 'completed', 'soon')).toEqual([]);
  });

  it('are counted for the chips', () => {
    expect(chipCounts(cards)).toEqual({
      all: 7,
      planning: 2,
      upcoming: 2,
      ongoing: 1,
      completed: 2,
    });
  });

  it('are the same whatever order the rows are held in', () => {
    const reversed = cardsOf(
      [...cards].reverse().map((c) =>
        entry({
          id: c.id,
          name: c.name,
          start: c.startDate,
          end: c.endDate,
          ready: c.status !== 'planning',
          updated: c.updatedAt,
        }),
      ),
      NOW,
    );
    expect(groupTrips(reversed, 'all', '').map((g) => g.trips.map((t) => t.id))).toEqual(
      groupTrips(cards, 'all', '').map((g) => g.trips.map((t) => t.id)),
    );
  });
});

describe('the sidebar’s section', () => {
  it('is ongoing, upcoming, planning and the latest three completed', () => {
    const cards = cardsOf(
      [
        entry({ id: 'c1', start: '2025-01-01', end: '2025-01-02' }),
        entry({ id: 'c2', start: '2025-02-01', end: '2025-02-02' }),
        entry({ id: 'c3', start: '2025-03-01', end: '2025-03-02' }),
        entry({ id: 'c4', start: '2025-04-01', end: '2025-04-02' }),
        entry({ id: 'p', ready: false, start: null, end: null }),
        entry({ id: 'u', start: '2026-08-01', end: '2026-08-02' }),
        entry({ id: 'o', start: '2026-06-14', end: '2026-06-16' }),
      ],
      NOW,
    );
    expect(sidebarTrips(cards).map((c) => c.id)).toEqual(['o', 'u', 'p', 'c4', 'c3', 'c2']);
    expect(sidebarTrips([])).toEqual([]);
  });
});

describe('words', () => {
  it('says the dates once when both ends are in the year, and the days', () => {
    expect(datesText('2026-06-10', '2026-06-20')).toMatch(
      /10.*Jun.*–.*20.*Jun.*2026|Jun.*10.*–.*Jun.*20.*2026/,
    );
    expect(datesText('2026-12-30', '2027-01-02')).toMatch(/2026.*2027/);
    expect(datesText('2026-06-10', '2026-06-10')).toMatch(/2026/);
    expect(datesText(null, null)).toBe('No dates yet');
    expect(daysText(11)).toBe('11 days');
    expect(daysText(1)).toBe('1 day');
    expect(daysText(null)).toBe('');
  });
  it('makes two letters of a name', () => {
    expect(initials('Ada Lovelace')).toBe('AL');
    expect(initials('  grace   brewster  hopper ')).toBe('GH');
    expect(initials('Plato')).toBe('P');
    expect(initials('')).toBe('');
  });
});

describe('the dot', () => {
  it('has a design-system token for every colour a trip can have', () => {
    const root = path.resolve(__dirname, '../..');
    const files = ['primitives', 'semantic', 'theme-presets'].map((name) =>
      readFileSync(path.join(root, `node_modules/@sovereignfs/ui/dist/tokens/${name}.css`), 'utf8'),
    );
    const defined = definedTokens(files);
    expect(Object.keys(DOT).sort()).toEqual([...TRIP_COLORS].sort());
    for (const value of Object.values(DOT)) {
      const name = /var\((--sv-[a-z0-9-]+)\)/.exec(value)?.[1];
      expect(name && defined.has(name), value).toBe(true);
    }
  });
});
