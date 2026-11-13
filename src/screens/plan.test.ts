import { describe, expect, it } from 'vitest';
import { displayOrder } from '../today';
import type { DayRecord, ItemRecord, StopRecord } from '../sync/trip-format';
import {
  KIND_ICON,
  KIND_LABEL,
  beforeFor,
  dayChoices,
  dayDropId,
  daysOfStop,
  dropOf,
  nudgeOf,
  selectedDay,
  selectedStop,
  tripPlaces,
} from './plan';
import { ITEM_KINDS } from '../trips/item-format';

/** The Plan view's rules (DESIGN.md §10.5, §20.10) without a browser: the days of a stop with their items as shown, and where a drop puts an item. */
const stop = (
  id: string,
  name: string,
  arrive: string | null,
  depart: string | null,
  position = id,
): StopRecord =>
  ({
    id,
    place: { id: `p-${id}`, name, lat: 0, lng: 0, tz: 'Europe/Lisbon', countryCode: 'PT' },
    arrive,
    depart,
    position,
    version: 1,
  }) as unknown as StopRecord;
const day = (id: string, stopId: string, date: string, title?: string): DayRecord => ({
  id,
  stopId,
  date,
  title,
  notes: undefined,
  version: 1,
});
const item = (
  id: string,
  dayId: string,
  position: string,
  start: string | null = null,
): ItemRecord =>
  ({
    id,
    dayId,
    title: id,
    notes: undefined,
    kind: 'activity',
    start,
    end: null,
    fixed: false,
    position,
    place: undefined,
    createdBy: null,
    updatedBy: null,
    version: 1,
    seq: 1,
  }) as unknown as ItemRecord;

const STOPS = [
  stop('b', 'Sintra', '2026-06-12', '2026-06-13'),
  stop('a', 'Lisbon', '2026-06-10', '2026-06-12'),
];
const DAYS = [
  day('d12', 'a', '2026-06-12'),
  day('d10', 'a', '2026-06-10', 'Arrival'),
  day('d11', 'a', '2026-06-11'),
  day('e12', 'b', '2026-06-12'),
];
const ITEMS = [
  item('late', 'd10', '3', '18:00'),
  item('walk', 'd10', '2'),
  item('early', 'd10', '1', '09:00'),
  item('free', 'd10', '4'),
  item('only', 'd11', '1'),
  item('sintra', 'e12', '1'),
];
const plan = () => daysOfStop(DAYS, ITEMS, 'a');
const ids = (day: { items: readonly ItemRecord[] }) => day.items.map((each) => each.id);

describe('the stop shown', () => {
  it('is the one asked for, else the first by dates, else none', () => {
    expect(selectedStop(STOPS, 'b')?.id).toBe('b');
    expect(selectedStop(STOPS, null)?.id).toBe('a');
    expect(selectedStop(STOPS, 'nope')?.id).toBe('a');
    expect(selectedStop([], 'a')).toBeUndefined();
  });
});

describe('the days of a stop', () => {
  it('are by date, with the items as they are shown: timed ones in time order in the timed slots', () => {
    const got = plan();
    expect(got.map((each) => each.day.id)).toEqual(['d10', 'd11', 'd12']);
    // Stored: early(09) walk late(18) free; shown: the same, the timed ones being in order already.
    expect(ids(got[0] as never)).toEqual(['early', 'walk', 'late', 'free']);
    expect(ids(got[2] as never)).toEqual([]);
    expect(ids(daysOfStop(DAYS, ITEMS, 'b')[0] as never)).toEqual(['sintra']);
  });
});

describe('where a drop puts an item', () => {
  /** Applies a drop to the rows, as `moveItem` does, and returns the plan as it is then shown. */
  function applied(activeId: string, overId: string) {
    const drop = dropOf(plan(), activeId, overId);
    if (!drop) return undefined;
    const moving = ITEMS.find((each) => each.id === activeId) as ItemRecord;
    const others = ITEMS.filter((each) => each.dayId === drop.dayId && each.id !== activeId).sort(
      (a, b) => a.position.localeCompare(b.position),
    );
    const at =
      drop.before === null ? others.length : others.findIndex((each) => each.id === drop.before);
    const stored = [
      ...others.slice(0, at),
      { ...moving, dayId: drop.dayId },
      ...others.slice(at),
    ].map((each, index) => ({
      ...each,
      position: String(index).padStart(4, '0'),
    }));
    const rest = ITEMS.filter((each) => each.dayId !== drop.dayId && each.id !== activeId);
    return daysOfStop(DAYS, [...rest, ...stored], 'a');
  }

  it('shows an untimed item where it was dropped on the same day', () => {
    // "free" dropped on "walk": it takes walk's place.
    expect(ids(applied('free', 'walk')?.[0] as never)).toEqual(['early', 'free', 'walk', 'late']);
    // "walk" dropped on "free": it takes the last place.
    expect(ids(applied('walk', 'free')?.[0] as never)).toEqual(['early', 'late', 'free', 'walk']);
  });

  it('shows an item on another day just before the one it is dropped on, and at the end when dropped on the day', () => {
    expect(ids(applied('walk', 'only')?.[1] as never)).toEqual(['walk', 'only']);
    expect(ids(applied('walk', dayDropId('d11'))?.[1] as never)).toEqual(['only', 'walk']);
    // Out of the day it left, and into an empty one.
    expect(ids(applied('walk', dayDropId('d12'))?.[2] as never)).toEqual(['walk']);
    expect(ids(applied('walk', dayDropId('d12'))?.[0] as never)).toEqual(['early', 'late', 'free']);
  });

  it('is nothing when the item is dropped where it is, or on something that is not there', () => {
    expect(dropOf(plan(), 'walk', 'walk')).toBeUndefined();
    expect(dropOf(plan(), 'walk', 'nope')).toBeUndefined();
    expect(dropOf(plan(), 'nope', 'walk')).toBeUndefined();
    expect(dropOf(plan(), 'walk', dayDropId('nope'))).toBeUndefined();
  });

  it('puts a timed item where its time says, wherever it was dropped, and the rest are not disturbed', () => {
    // "late" (18:00) dropped first on the day: the time still puts it after "early".
    const got = applied('late', 'free');
    expect(ids(got?.[0] as never)).toEqual(['early', 'walk', 'free', 'late']);
  });

  it('moves up and down by one place, and not past the edge', () => {
    expect(nudgeOf(plan(), 'free', 'up')).toBeDefined();
    expect(nudgeOf(plan(), 'early', 'up')).toBeUndefined();
    expect(nudgeOf(plan(), 'free', 'down')).toBeUndefined();
    expect(nudgeOf(plan(), 'nope', 'down')).toBeUndefined();
  });

  it('finds the place that shows an item at each index of a day, for every index', () => {
    const others = ITEMS.filter((each) => each.dayId === 'd10' && each.id !== 'free');
    const moving = ITEMS.find((each) => each.id === 'free') as ItemRecord;
    for (let index = 0; index <= others.length; index++) {
      const before = beforeFor(others, moving, index);
      const sorted = [...others].sort((a, b) => a.position.localeCompare(b.position));
      const at = before === null ? sorted.length : sorted.findIndex((each) => each.id === before);
      const shown = displayOrder(
        [...sorted.slice(0, at), moving, ...sorted.slice(at)].map((each, i) => ({
          ...each,
          position: String(i).padStart(4, '0'),
        })),
      ).findIndex((each) => each.id === 'free');
      // The untimed item is shown where it was asked, except that the timed slots decide where they are.
      expect(shown, `index ${index}`).toBe(index);
    }
  });
});

describe('the day a narrow screen shows', () => {
  it('is the one asked for, else today’s in the stop’s own zone, else the first, and none for a stop with no days', () => {
    const got = plan();
    expect(selectedDay(got, 'd11')?.day.id).toBe('d11');
    expect(selectedDay(got, 'd11', '2026-06-12')?.day.id).toBe('d11');
    expect(selectedDay(got, null, '2026-06-11')?.day.id).toBe('d11');
    // A day that is not this stop’s is not shown; today outside the stop is the first.
    expect(selectedDay(got, 'e12', '2026-07-01')?.day.id).toBe('d10');
    expect(selectedDay(got, undefined)?.day.id).toBe('d10');
    expect(selectedDay([], 'd10', '2026-06-10')).toBeUndefined();
  });
});

describe('the lists', () => {
  it('name each day by date, its title and its stop, in the order of the trip', () => {
    const got = dayChoices(STOPS, DAYS);
    expect(got.map((each) => each.id)).toEqual(['d10', 'd11', 'd12', 'e12']);
    expect(got[0]?.label).toContain('Arrival');
    expect(got[0]?.label).toContain('Lisbon');
    expect(got[3]?.label).toContain('Sintra');
  });

  it('list the trip’s places once each', () => {
    const withPlace = {
      ...item('x', 'd10', '9'),
      place: { id: 'p-a', name: 'Lisbon' },
    } as unknown as ItemRecord;
    const other = {
      ...item('y', 'd10', '9'),
      place: { id: 'castle', name: 'Castle' },
    } as unknown as ItemRecord;
    expect(tripPlaces(STOPS, [withPlace, other]).map((each) => each.name)).toEqual([
      'Castle',
      'Lisbon',
      'Sintra',
    ]);
  });

  it('have a label and an icon for every kind', () => {
    for (const kind of ITEM_KINDS) {
      expect(KIND_LABEL[kind]).toBeTruthy();
      expect(KIND_ICON[kind]).toBeTruthy();
    }
  });
});
