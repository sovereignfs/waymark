import { describe, expect, it } from 'vitest';
import type { DayRecord, ItemRecord, StopRecord, TripSets } from '../sync/trip-format';
import type { LinkView } from '../trips/links';
import {
  VIEWS,
  headerActions,
  isEditor,
  itemTitle,
  linksOf,
  overviewOf,
  viewOf,
  viewsFor,
} from './trip';

/** A trip's page (DESIGN.md §20.10) without a browser: the views a role has, what the header offers each role, and what the Overview says from the rows a device holds. */
const at = (iso: string) => Date.parse(iso);
const ZONE = 'Europe/Lisbon';

const stop = (
  id: string,
  name: string,
  arrive: string | null,
  depart: string | null,
  position: string,
  lat = 38.7,
  lng = -9.1,
): StopRecord =>
  ({
    id,
    place: {
      id: `p-${id}`,
      name,
      lat,
      lng,
      address: undefined,
      category: undefined,
      tz: ZONE,
      countryCode: 'PT',
    },
    arrive,
    depart,
    position,
    note: undefined,
    version: 1,
  }) as StopRecord;
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
  over: Partial<ItemRecord> & { placeName?: string; lat?: number; lng?: number } = {},
): ItemRecord => {
  const { placeName, lat, lng, ...rest } = over;
  return {
    id,
    dayId,
    title: undefined,
    notes: undefined,
    kind: 'activity',
    start: null,
    end: null,
    fixed: false,
    position: `0000${id.length}`,
    place: placeName
      ? {
          id: `p-${id}`,
          name: placeName,
          lat: lat ?? 0,
          lng: lng ?? 0,
          address: undefined,
          category: undefined,
          tz: ZONE,
          countryCode: 'PT',
        }
      : undefined,
    createdBy: null,
    updatedBy: null,
    version: 1,
    seq: 1,
    ...rest,
  } as ItemRecord;
};
const link = (id: string, kind: 'tally' | 'other', position: string): LinkView => ({
  id,
  kind,
  title: id,
  url: `https://example.org/${id}`,
  position,
});

const STOPS = [
  stop('s2', 'Sintra', '2026-06-12', '2026-06-13', '00002000', 38.8, -9.38),
  stop('s1', 'Lisbon', '2026-06-10', '2026-06-12', '00001000'),
];
const DAYS = [
  day('d10', 's1', '2026-06-10'),
  day('d11', 's1', '2026-06-11'),
  day('d12', 's2', '2026-06-12'),
  day('d13', 's2', '2026-06-13'),
];
const sets = (over: Partial<TripSets['trip']> = {}, extra: Partial<TripSets> = {}): TripSets =>
  ({
    trip: {
      id: 't',
      name: 'Portugal',
      color: 'accent',
      startDate: '2026-06-10',
      endDate: '2026-06-13',
      readyAt: 1,
      ...over,
    },
    members: [],
    stops: STOPS,
    days: DAYS,
    links: [],
    done: [],
    ...extra,
  }) as unknown as TripSets;
const view = (s: TripSets, items: ItemRecord[] = [], done: string[] = [], sharedCount = 0) => ({
  sets: s,
  items,
  days: s.days,
  done: new Set(done),
  sharedCount,
});

describe('the views', () => {
  it('are six, and a Follower has no Files', () => {
    expect(VIEWS).toEqual(['overview', 'plan', 'map', 'journal', 'files', 'people']);
    expect(viewsFor('organizer')).toEqual(VIEWS);
    expect(viewsFor('traveler')).toEqual(VIEWS);
    expect(viewsFor('follower')).toEqual(['overview', 'plan', 'map', 'journal', 'people']);
  });

  it('are asked for by ?view=, and anything else is the Overview', () => {
    expect(viewOf('view=plan', 'traveler')).toBe('plan');
    expect(viewOf('view=files', 'organizer')).toBe('files');
    expect(viewOf('', 'organizer')).toBe('overview');
    expect(viewOf('view=nonsense', 'organizer')).toBe('overview');
    expect(viewOf('view=PLAN', 'organizer')).toBe('overview');
    expect(viewOf('view[]=plan', 'organizer')).toBe('overview');
    // A view the role does not have is not shown by asking for it.
    expect(viewOf('view=files', 'follower')).toBe('overview');
    expect(viewOf(new URLSearchParams('view=journal'), 'follower')).toBe('journal');
  });
});

describe('the header', () => {
  const base = { status: 'planning' as const, going: true, readyAt: null, hasDatedStop: true };
  it('gives an Organizer Mark ready while planning, and the menu', () => {
    expect(headerActions({ ...base, role: 'organizer' })).toEqual({
      markReady: 'enabled',
      backToPlanning: false,
      tripMode: false,
      menu: true,
    });
  });

  it('holds Mark ready back until a stop has dates', () => {
    expect(headerActions({ ...base, role: 'organizer', hasDatedStop: false }).markReady).toBe(
      'disabled',
    );
  });

  it('gives an Organizer Back to planning, and no Mark ready, once the trip is ready (also when it is over)', () => {
    for (const status of ['upcoming', 'ongoing', 'completed'] as const) {
      const got = headerActions({ ...base, role: 'organizer', status, readyAt: 5, going: false });
      expect(got.markReady, status).toBe('hidden');
      expect(got.backToPlanning, status).toBe(true);
    }
  });

  it('gives a Traveler and a Follower none of the Organizer’s actions', () => {
    for (const role of ['traveler', 'follower']) {
      for (const readyAt of [null, 5])
        expect(headerActions({ ...base, role, readyAt }), `${role} ${readyAt}`).toEqual({
          markReady: 'hidden',
          backToPlanning: false,
          tripMode: false,
          menu: false,
        });
    }
  });

  it('offers Trip Mode on an ongoing trip to an Organizer or Traveler who is going, and to no one else', () => {
    const ongoing = { ...base, status: 'ongoing' as const, readyAt: 5 };
    expect(headerActions({ ...ongoing, role: 'organizer' }).tripMode).toBe(true);
    expect(headerActions({ ...ongoing, role: 'traveler' }).tripMode).toBe(true);
    expect(headerActions({ ...ongoing, role: 'follower' }).tripMode).toBe(false);
    expect(headerActions({ ...ongoing, role: 'traveler', going: false }).tripMode).toBe(false);
    for (const status of ['planning', 'upcoming', 'completed'] as const)
      expect(headerActions({ ...ongoing, status, role: 'traveler' }).tripMode, status).toBe(false);
  });

  it('is what editors are: Organizers and Travelers', () => {
    expect(['organizer', 'traveler', 'follower', 'x'].map(isEditor)).toEqual([
      true,
      true,
      false,
      false,
    ]);
  });
});

describe('the links', () => {
  it('put Tally’s first, and keep the others in the order they were put', () => {
    const got = linksOf([
      link('b', 'other', '00002'),
      link('t', 'tally', '00003'),
      link('a', 'other', '00001'),
    ]);
    expect(got.map((l) => l.id)).toEqual(['t', 'a', 'b']);
  });
});

describe('the Overview', () => {
  it('lists the stops in order with the days each covers', () => {
    const o = overviewOf(view(sets()), at('2026-06-01T12:00:00Z'), ZONE);
    expect(o.stops.map((s) => [s.name, s.days])).toEqual([
      ['Lisbon', 3],
      ['Sintra', 2],
    ]);
    expect(
      overviewOf(view(sets({}, { stops: [stop('x', 'Undated', null, null, '1')] })), 0, ZONE)
        .stops[0]?.days,
    ).toBeNull();
  });

  it('counts days, stops, distinct places and the check-ins shared with the trip', () => {
    const items = [
      item('a', 'd10', { placeName: 'Pastéis de Belém', lat: 38.6975, lng: -9.2033 }),
      // The same place written another way, and a few metres off: one place.
      item('bb', 'd11', { placeName: 'Pasteis de Belem', lat: 38.6976, lng: -9.2034 }),
      item('ccc', 'd11', { placeName: 'Castelo', lat: 38.7139, lng: -9.1335 }),
      item('dddd', 'd12', { title: 'Free time' }),
      // The same place as a stop.
      item('eeeee', 'd10', { placeName: 'Lisbon', lat: 38.7, lng: -9.1 }),
    ];
    const o = overviewOf(view(sets(), items, [], 4), at('2026-06-01T12:00:00Z'), ZONE);
    expect(o.figures).toEqual({ days: 4, stops: 2, places: 4, shared: 4 });
    // Lisbon, Sintra, Belém, Castelo.
  });

  it('has no days while the trip has no dates', () => {
    const o = overviewOf(
      view(sets({ startDate: null, endDate: null }, { stops: [], days: [] })),
      0,
      ZONE,
    );
    expect(o.figures).toEqual({ days: null, stops: 0, places: 0, shared: 0 });
  });

  it('says when the trip starts before it has, and that it ended after', () => {
    expect(overviewOf(view(sets()), at('2026-06-01T12:00:00Z'), ZONE).next).toEqual({
      kind: 'starts',
      date: '2026-06-10',
    });
    expect(overviewOf(view(sets()), at('2026-07-01T12:00:00Z'), ZONE).next).toEqual({
      kind: 'ended',
      date: '2026-06-13',
    });
  });

  it('has nothing to do for a trip with no dates', () => {
    const planning = sets(
      { startDate: null, endDate: null },
      { stops: [stop('s', 'Somewhere', null, null, '1')], days: [] },
    );
    expect(overviewOf(view(planning), 0, ZONE).next).toEqual({ kind: 'undated' });
  });

  it('is, while the trip is on, Today’s next item: the first not done, timed by its time', () => {
    const items = [
      item('a', 'd11', { title: 'Breakfast', start: '09:00' }),
      item('bb', 'd11', { title: 'Tram 28', start: '14:00' }),
    ];
    // 10:00 in Lisbon on the 11th (UTC+1 in June).
    const now = at('2026-06-11T09:00:00Z');
    expect(overviewOf(view(sets(), items), now, ZONE).next).toEqual({
      kind: 'item',
      title: 'Tram 28',
      dayDate: '2026-06-11',
      inMinutes: 240,
      timed: true,
    });
    // Done is the reader's own mark: with the later one done as well, nothing is left today.
    expect(overviewOf(view(sets(), items, ['bb']), now, ZONE).next.kind).toBe('nothing');
    // An item with no title is its place.
    expect(itemTitle(item('x', 'd11', { placeName: 'Castelo' }))).toBe('Castelo');
    expect(itemTitle(item('x', 'd11'))).toBe('Something planned');
  });

  it('is on the date in the stop’s zone and not the device’s', () => {
    const items = [item('a', 'd11', { title: 'Early', start: '08:00' })];
    // 23:30 UTC on the 10th is already the 11th in Lisbon (UTC+1): the 11th’s item is next, not "starts".
    const now = at('2026-06-10T23:30:00Z');
    expect(overviewOf(view(sets(), items), now, 'Pacific/Honolulu').next).toMatchObject({
      kind: 'item',
      title: 'Early',
    });
  });
});
