import { describe, expect, it } from 'vitest';
import type { TodayDay, TodayStop } from '../today';
import { DEFAULT_PREFS, type ReminderItem, type ReminderPrefs, dueReminders } from './due';

/**
 * Which reminders are due (DESIGN.md §14.4): to the minute, in the zone of the stop, once per thing that is reminded of, never for an untimed item.
 */
const LISBON = 'Europe/Lisbon';
const at = (iso: string) => Date.parse(iso);
const stops: TodayStop[] = [
  { id: 's', arrive: '2026-05-10', depart: '2026-05-12', position: 'a', tz: LISBON },
];
const days: TodayDay[] = [
  { id: 'd10', stopId: 's', date: '2026-05-10' },
  { id: 'd11', stopId: 's', date: '2026-05-11' },
  { id: 'd12', stopId: 's', date: '2026-05-12' },
];
const item = (
  id: string,
  start: string | null,
  fixed: boolean,
  position: string,
  dayId = 'd11',
): ReminderItem => ({
  id,
  dayId,
  start,
  fixed,
  position,
});
const items = [
  item('lunch', '13:00', false, 'a1'),
  item('market', null, false, 'a2'),
  item('dinner', '19:00', true, 'a3'),
];
const due = (
  now: string,
  over: {
    prefs?: Partial<ReminderPrefs>;
    items?: ReminderItem[];
    done?: string[];
    zone?: string;
  } = {},
) =>
  dueReminders<ReminderItem>({
    stops,
    days,
    items: over.items ?? items,
    done: new Set(over.done ?? []),
    now: at(now),
    deviceZone: over.zone ?? LISBON,
    prefs: { ...DEFAULT_PREFS, ...over.prefs },
  });
const kinds = (list: ReturnType<typeof due>) => list.map((each) => `${each.kind}`);

describe('the start of a trip', () => {
  it('is reminded of from 18:00 the day before the first day, in the first stop’s zone, until it begins', () => {
    expect(kinds(due('2026-05-09T17:59:00+01:00'))).toEqual([]);
    expect(due('2026-05-09T18:00:00+01:00')).toEqual([
      { kind: 'trip_starts', key: 'trip_starts', date: '2026-05-10' },
    ]);
    expect(kinds(due('2026-05-09T23:59:00+01:00'))).toEqual(['trip_starts']);
    expect(kinds(due('2026-05-10T00:00:00+01:00'))).toEqual([]);
    expect(kinds(due('2026-05-08T12:00:00+01:00'))).toEqual([]);
  });

  it('is in the stop’s zone and not the device’s, and off when the member turned it off', () => {
    // 17:30 in Lisbon on the 9th is 01:30 in Tokyo on the 10th: a phone set to Tokyo does not make it early or late.
    expect(kinds(due('2026-05-09T17:30:00+01:00', { zone: 'Asia/Tokyo' }))).toEqual([]);
    expect(kinds(due('2026-05-09T18:30:00+01:00', { zone: 'Asia/Tokyo' }))).toEqual([
      'trip_starts',
    ]);
    expect(kinds(due('2026-05-09T19:00:00+01:00', { prefs: { tripStarts: false } }))).toEqual([]);
  });
});

describe('an item that is coming up', () => {
  it('is reminded of a lead time before it starts, once, for a fixed item', () => {
    expect(kinds(due('2026-05-11T18:29:59+01:00'))).toEqual([]);
    const found = due('2026-05-11T18:30:00+01:00');
    expect(found).toEqual([
      {
        kind: 'item_soon',
        key: `item_soon:dinner:${at('2026-05-11T19:00:00+01:00')}`,
        itemId: 'dinner',
        at: at('2026-05-11T19:00:00+01:00'),
        inMinutes: 30,
      },
    ]);
    expect(due('2026-05-11T18:59:00+01:00')[0]).toMatchObject({ inMinutes: 1 });
    // At its time it is no longer coming up.
    expect(kinds(due('2026-05-11T19:00:00+01:00'))).toEqual([]);
  });

  it('is for a flexible item only when the member asked, and never for an untimed item', () => {
    expect(kinds(due('2026-05-11T12:30:00+01:00'))).toEqual([]);
    expect(due('2026-05-11T12:30:00+01:00', { prefs: { flexible: true } })).toMatchObject([
      { itemId: 'lunch' },
    ]);
    // Whatever they chose, the market has no time.
    const all = due('2026-05-11T12:00:00+01:00', { prefs: { flexible: true, leadMin: 240 } });
    expect(all.flatMap((each) => ('itemId' in each ? [each.itemId] : []))).not.toContain('market');
  });

  it('follows the member’s lead time, within its limits, and their choice to have none', () => {
    expect(due('2026-05-11T18:45:00+01:00', { prefs: { leadMin: 15 } })).toMatchObject([
      { itemId: 'dinner', inMinutes: 15 },
    ]);
    expect(kinds(due('2026-05-11T18:44:00+01:00', { prefs: { leadMin: 15 } }))).toEqual([]);
    // Past the bounds it is the bound.
    expect(kinds(due('2026-05-11T18:56:00+01:00', { prefs: { leadMin: 1 } }))).toEqual([
      'item_soon',
    ]);
    expect(kinds(due('2026-05-11T14:59:00+01:00', { prefs: { leadMin: 99999 } }))).toEqual([]);
    expect(kinds(due('2026-05-11T15:00:00+01:00', { prefs: { leadMin: 99999 } }))).toEqual([
      'item_soon',
    ]);
    expect(kinds(due('2026-05-11T18:45:00+01:00', { prefs: { itemSoon: false } }))).toEqual([]);
  });

  it('is not for an item that is done, and not on a day that is not today', () => {
    expect(kinds(due('2026-05-11T18:45:00+01:00', { done: ['dinner'] }))).toEqual([]);
    expect(kinds(due('2026-05-10T18:45:00+01:00'))).toEqual([]);
  });

  it('has a new key when the item is moved to a new time, so it can remind again, and an item moved away is not reminded of', () => {
    const first = due('2026-05-11T18:45:00+01:00')[0];
    const moved = [
      item('dinner', '20:00', true, 'a3'),
      items[0] as ReminderItem,
      items[1] as ReminderItem,
    ];
    expect(kinds(due('2026-05-11T18:45:00+01:00', { items: moved }))).toEqual([]);
    const second = due('2026-05-11T19:45:00+01:00', { items: moved })[0];
    expect(second).toBeDefined();
    expect(second?.key).not.toBe(first?.key);
  });
});

describe('the plan of the day', () => {
  const plan = (now: string, prefs: Partial<ReminderPrefs> = { dayPlan: true }, list = items) =>
    due(now, { prefs: { ...prefs, itemSoon: false }, items: list });

  it('is from 08:00 to 20:00 on a trip day, if asked for, with the count and the first item', () => {
    expect(plan('2026-05-11T07:59:00+01:00')).toEqual([]);
    expect(plan('2026-05-11T08:00:00+01:00')).toEqual([
      {
        kind: 'day_plan',
        key: 'day_plan:2026-05-11',
        date: '2026-05-11',
        count: 3,
        firstItemId: 'lunch',
      },
    ]);
    expect(kinds(plan('2026-05-11T19:59:00+01:00'))).toEqual(['day_plan']);
    expect(plan('2026-05-11T20:00:00+01:00')).toEqual([]);
    expect(plan('2026-05-11T09:00:00+01:00', { dayPlan: false })).toEqual([]);
  });

  it('is not sent for a day with nothing planned, and is once for each day', () => {
    expect(plan('2026-05-12T09:00:00+01:00')).toEqual([]);
    expect(plan('2026-05-10T09:00:00+01:00')[0]?.key).not.toBe(
      plan('2026-05-11T09:00:00+01:00')[0]?.key,
    );
  });
});

describe('not on a trip day', () => {
  it('nothing is due after the trip, or on a trip without dates', () => {
    expect(kinds(due('2026-05-13T12:00:00+01:00', { prefs: { dayPlan: true } }))).toEqual([]);
    expect(
      dueReminders<ReminderItem>({
        stops: [],
        days: [],
        items: [],
        done: new Set(),
        now: 0,
        deviceZone: LISBON,
        prefs: DEFAULT_PREFS,
      }),
    ).toEqual([]);
  });
});
