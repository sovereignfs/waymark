import { describe, expect, it } from 'vitest';
import { type TodayDay, type TodayItem, type TodayStop, displayOrder, today } from './today';

/**
 * Today (DESIGN.md §14.1): fixtures across the date line, at 23:59 and 00:01 local, on a travel day, and with the device in another zone than the stop's.
 */
interface Item extends TodayItem {
  readonly title: string;
}
const at = (iso: string) => Date.parse(iso);

const LISBON = 'Europe/Lisbon';
const stop = (
  id: string,
  arrive: string,
  depart: string,
  tz: string | null,
  position = id,
): TodayStop => ({
  id,
  arrive,
  depart,
  position,
  tz,
});
const day = (id: string, stopId: string, date: string): TodayDay => ({ id, stopId, date });
const item = (
  id: string,
  dayId: string,
  start: string | null,
  position: string,
  title = id,
): Item => ({
  id,
  dayId,
  start,
  position,
  title,
});

/** One stop in Lisbon, 10 to 12 May, with a day for each. */
const iberia = {
  stops: [stop('lisbon', '2026-05-10', '2026-05-12', LISBON)],
  days: [
    day('d10', 'lisbon', '2026-05-10'),
    day('d11', 'lisbon', '2026-05-11'),
    day('d12', 'lisbon', '2026-05-12'),
  ],
};
const run = (over: Partial<Parameters<typeof today<Item>>[0]> & { now: number }) =>
  today<Item>({
    stops: iberia.stops,
    days: iberia.days,
    items: [],
    done: new Set(),
    deviceZone: LISBON,
    ...over,
  });

describe('a day on a trip', () => {
  const items = [
    item('a', 'd11', '08:30', 'a1', 'Fushimi'),
    item('b', 'd11', '11:00', 'a2', 'Kinkaku'),
    item('c', 'd11', null, 'a3', 'Market'),
    item('d', 'd11', '19:00', 'a4', 'Dinner'),
  ];

  it('is today’s date in the stop’s zone, its items in plan order, the one after the last done as next, with a countdown', () => {
    const now = at('2026-05-11T09:00:00+01:00');
    const result = run({ now, items, done: new Set(['a']) });
    expect(result).toMatchObject({
      state: 'during',
      date: '2026-05-11',
      zone: LISBON,
      stopIds: ['lisbon'],
      empty: false,
    });
    expect(result.days).toHaveLength(1);
    expect(result.days[0]?.items.map((entry) => [entry.item.id, entry.done])).toEqual([
      ['a', true],
      ['b', false],
      ['c', false],
      ['d', false],
    ]);
    expect(result.next).toMatchObject({
      item: { id: 'b' },
      inMinutes: 120,
      at: at('2026-05-11T11:00:00+01:00'),
    });
  });

  it('rounds the countdown up to a whole minute, and has none for an untimed next', () => {
    expect(run({ now: at('2026-05-11T10:59:30+01:00'), items }).next?.inMinutes).toBe(1);
    expect(run({ now: at('2026-05-11T10:59:00+01:00'), items }).next?.inMinutes).toBe(1);
    expect(run({ now: at('2026-05-11T10:00:00+01:00'), items }).next?.inMinutes).toBe(60);
    // Everything timed that is left is behind, and the untimed one after the last done is next.
    const after = run({
      now: at('2026-05-11T20:00:00+01:00'),
      items: items.slice(0, 3),
      done: new Set(['b']),
    });
    expect(after.next).toMatchObject({ item: { id: 'c' }, inMinutes: null, at: null });
  });

  it('skips a timed item that has passed and was not marked done, and an untimed one before the last done', () => {
    const now = at('2026-05-11T09:00:00+01:00');
    // 08:30 has passed unmarked: it is not next, and stays in the list undone.
    const result = run({ now, items });
    expect(result.next?.item.id).toBe('b');
    expect(result.days[0]?.items[0]).toMatchObject({ done: false });
    // The untimed one is behind the last done: nothing but the timed ones ahead qualifies.
    expect(run({ now, items, done: new Set(['c']) }).next?.item.id).toBe('b');
    expect(
      run({ now: at('2026-05-11T20:00:00+01:00'), items: items.slice(0, 3), done: new Set(['c']) })
        .next,
    ).toBeUndefined();
  });

  it('does not offer an item that is done, even one marked done before its time', () => {
    const now = at('2026-05-11T09:00:00+01:00');
    // 11:00 was marked done early: the untimed one after it is next; with that done too, the 19:00 is.
    expect(run({ now, items, done: new Set(['b']) }).next?.item.id).toBe('c');
    expect(run({ now, items, done: new Set(['b', 'c']) }).next?.item.id).toBe('d');
  });

  it('has no next when everything is done or behind', () => {
    expect(
      run({ now: at('2026-05-11T23:00:00+01:00'), items, done: new Set(['a', 'b', 'c', 'd']) })
        .next,
    ).toBeUndefined();
  });

  it('is an empty day, not an error, when nothing is planned', () => {
    const result = run({ now: at('2026-05-12T10:00:00+01:00'), items });
    expect(result).toMatchObject({ state: 'during', empty: true, next: undefined });
    expect(result.days[0]?.items).toEqual([]);
  });
});

describe('the order of a day', () => {
  it('keeps the plan’s order and puts the timed ones in time order in the places the timed ones had', () => {
    const order = (list: Item[]) => displayOrder(list).map((x) => x.id);
    expect(
      order([
        item('a', 'd', '11:00', 'a1'),
        item('b', 'd', null, 'a2'),
        item('c', 'd', '08:30', 'a3'),
      ]),
    ).toEqual(['c', 'b', 'a']);
    expect(
      order([
        item('a', 'd', null, 'a1'),
        item('b', 'd', '09:00', 'a2'),
        item('c', 'd', null, 'a3'),
      ]),
    ).toEqual(['a', 'b', 'c']);
    expect(order([item('x', 'd', '09:00', 'a2'), item('y', 'd', '09:00', 'a1')])).toEqual([
      'y',
      'x',
    ]);
    // Stable whatever order they are given in.
    const list = [
      item('a', 'd', '11:00', 'a1'),
      item('b', 'd', null, 'a2'),
      item('c', 'd', '08:30', 'a3'),
      item('e', 'd', '10:00', 'a4'),
    ];
    expect(order([...list].reverse())).toEqual(order(list));
  });
});

describe('the moment decides the date, in the stop’s zone', () => {
  const items = [item('a', 'd11', '09:00', 'a1'), item('b', 'd12', '09:00', 'a1')];
  it('at 23:59 local it is still the day, and at 00:01 it is the next, whatever UTC says', () => {
    const before = run({ now: at('2026-05-11T23:59:00+01:00'), items });
    const after = run({ now: at('2026-05-12T00:01:00+01:00'), items });
    expect(before).toMatchObject({ date: '2026-05-11', next: undefined });
    expect(before.days[0]?.day.id).toBe('d11');
    expect(after).toMatchObject({ date: '2026-05-12' });
    expect(after.days[0]?.day.id).toBe('d12');
    expect(after.next?.item.id).toBe('b');
    // The same two moments, as UTC.
    expect(at('2026-05-11T22:59:00Z')).toBe(at('2026-05-11T23:59:00+01:00'));
  });

  it('is the stop’s date and not the device’s: a phone still in Tokyo is on Lisbon’s day', () => {
    // 20:00 UTC on the 11th: 21:00 in Lisbon (the 11th), 05:00 in Tokyo (the 12th).
    const result = run({ now: at('2026-05-11T20:00:00Z'), items, deviceZone: 'Asia/Tokyo' });
    expect(result.date).toBe('2026-05-11');
    // A stop with no zone of its own falls back to the device’s.
    const fallback = today<Item>({
      stops: [stop('s', '2026-05-12', '2026-05-12', null)],
      days: [day('d12', 's', '2026-05-12')],
      items: [],
      done: new Set(),
      now: at('2026-05-11T20:00:00Z'),
      deviceZone: 'Asia/Tokyo',
    });
    expect(fallback.date).toBe('2026-05-12');
  });

  it('puts a timed item at its local time, across a change of clocks', () => {
    // Lisbon’s clocks go forward at 01:00 UTC on 29 March 2026: 09:00 that day is 08:00 UTC.
    const march = today<Item>({
      stops: [stop('s', '2026-03-29', '2026-03-29', LISBON)],
      days: [day('d', 's', '2026-03-29')],
      items: [item('a', 'd', '09:00', 'a1')],
      done: new Set(),
      now: at('2026-03-29T07:30:00Z'),
      deviceZone: LISBON,
    });
    expect(march.next).toMatchObject({ at: at('2026-03-29T08:00:00Z'), inMinutes: 30 });
  });
});

describe('a travel day', () => {
  const leg = {
    stops: [
      stop('lisbon', '2026-05-10', '2026-05-12', LISBON, 'a'),
      stop('porto', '2026-05-12', '2026-05-14', LISBON, 'b'),
    ],
    days: [
      day('l10', 'lisbon', '2026-05-10'),
      day('l11', 'lisbon', '2026-05-11'),
      day('l12', 'lisbon', '2026-05-12'),
      day('p12', 'porto', '2026-05-12'),
      day('p13', 'porto', '2026-05-13'),
      day('p14', 'porto', '2026-05-14'),
    ],
  };
  const items = [
    item('check-out', 'l12', '10:00', 'a1'),
    item('train', 'l12', '12:00', 'a2'),
    item('check-in', 'p12', '15:00', 'a1'),
    item('dinner', 'p12', '20:00', 'a2'),
  ];
  const go = (iso: string, done: string[] = []) =>
    today<Item>({ ...leg, items, done: new Set(done), now: at(iso), deviceZone: LISBON });

  it('has two days, departing then arriving, and next runs across them', () => {
    const result = go('2026-05-12T11:00:00+01:00', ['check-out']);
    expect(result.stopIds).toEqual(['lisbon', 'porto']);
    expect(result.days.map((d) => d.day.id)).toEqual(['l12', 'p12']);
    expect(result.next?.item.id).toBe('train');
    expect(go('2026-05-12T13:00:00+01:00', ['check-out', 'train']).next?.item.id).toBe('check-in');
    expect(go('2026-05-12T16:00:00+01:00', ['check-out', 'train', 'check-in']).next?.item.id).toBe(
      'dinner',
    );
  });

  it('is one day either side of it', () => {
    expect(go('2026-05-11T12:00:00+01:00').days.map((d) => d.day.id)).toEqual(['l11']);
    expect(go('2026-05-13T12:00:00+01:00').days.map((d) => d.day.id)).toEqual(['p13']);
    expect(go('2026-05-11T12:00:00+01:00').stopIds).toEqual(['lisbon']);
  });
});

describe('across the date line', () => {
  const flight = {
    stops: [
      stop('tokyo', '2026-06-03', '2026-06-05', 'Asia/Tokyo', 'a'),
      stop('honolulu', '2026-06-05', '2026-06-08', 'Pacific/Honolulu', 'b'),
    ],
    days: [
      day('t5', 'tokyo', '2026-06-05'),
      day('h5', 'honolulu', '2026-06-05'),
      day('h6', 'honolulu', '2026-06-06'),
    ],
  };
  const go = (iso: string) =>
    today<Item>({
      ...flight,
      items: [],
      done: new Set(),
      now: at(iso),
      deviceZone: 'Europe/Lisbon',
    });

  it('shows both days while the date is still the same in both zones', () => {
    // 10:00 UTC on the 5th: 19:00 in Tokyo and 00:00 in Honolulu, the 5th in both.
    const result = go('2026-06-05T10:00:00Z');
    expect(result.stopIds).toEqual(['tokyo', 'honolulu']);
    expect(result.days.map((d) => d.day.id)).toEqual(['t5', 'h5']);
    expect(result.date).toBe('2026-06-05');
    expect(result.zone).toBe('Pacific/Honolulu');
  });

  it('shows only the stop whose own date it still is once the zones disagree', () => {
    // 20:00 UTC on the 5th: the 6th in Tokyo (past its stop), the 5th in Honolulu.
    const result = go('2026-06-05T20:00:00Z');
    expect(result.stopIds).toEqual(['honolulu']);
    expect(result.days.map((d) => d.day.id)).toEqual(['h5']);
    // And the next morning in Honolulu it is the 6th.
    expect(go('2026-06-06T20:00:00Z').date).toBe('2026-06-06');
  });
});

describe('a trip that is not on a day', () => {
  it('says when it begins, that it is over, that it is between stops, or that it has no dates', () => {
    expect(run({ now: at('2026-05-09T12:00:00+01:00') })).toMatchObject({
      state: 'before',
      edge: '2026-05-10',
      date: null,
    });
    expect(run({ now: at('2026-05-12T23:59:00+01:00') })).toMatchObject({ state: 'during' });
    expect(run({ now: at('2026-05-13T00:00:00+01:00') })).toMatchObject({
      state: 'after',
      edge: '2026-05-12',
    });
    const gap = today<Item>({
      stops: [
        stop('a', '2026-05-10', '2026-05-11', LISBON, 'a'),
        stop('b', '2026-05-14', '2026-05-15', LISBON, 'b'),
      ],
      days: [],
      items: [],
      done: new Set(),
      now: at('2026-05-12T12:00:00+01:00'),
      deviceZone: LISBON,
    });
    expect(gap).toMatchObject({ state: 'between', date: null, days: [] });
    const planning = today<Item>({
      stops: [{ id: 'u', arrive: null, depart: null, position: 'a', tz: null }],
      days: [],
      items: [],
      done: new Set(),
      now: 0,
      deviceZone: LISBON,
    });
    expect(planning.state).toBe('planning');
    expect(
      today<Item>({ stops: [], days: [], items: [], done: new Set(), now: 0, deviceZone: LISBON })
        .state,
    ).toBe('planning');
  });

  it('is decided by the first stop’s zone for "before" and the last’s for "after"', () => {
    const flight = [
      stop('tokyo', '2026-06-03', '2026-06-05', 'Asia/Tokyo', 'a'),
      stop('honolulu', '2026-06-05', '2026-06-08', 'Pacific/Honolulu', 'b'),
    ];
    const go = (iso: string) =>
      today<Item>({
        stops: flight,
        days: [],
        items: [],
        done: new Set(),
        now: at(iso),
        deviceZone: LISBON,
      });
    // 16:00 UTC on 2 June is the 3rd (01:00) in Tokyo: the trip has begun.
    expect(go('2026-06-02T16:00:00Z').state).toBe('during');
    expect(go('2026-06-02T14:00:00Z').state).toBe('before');
    // 09:59 UTC on the 9th is still the 8th (23:59) in Honolulu; ten minutes later it is the 9th, and it is over.
    expect(go('2026-06-09T09:59:00Z').state).toBe('during');
    expect(go('2026-06-09T10:00:00Z').state).toBe('after');
  });
});

describe('what it does not depend on', () => {
  it('the order the rows are given in', () => {
    const items = [
      item('a', 'd11', '08:30', 'a1'),
      item('b', 'd11', '11:00', 'a2'),
      item('c', 'd11', null, 'a3'),
      item('d', 'd11', '19:00', 'a4'),
    ];
    const base = run({ now: at('2026-05-11T09:00:00+01:00'), items, done: new Set(['a']) });
    const shuffled = run({
      now: at('2026-05-11T09:00:00+01:00'),
      items: [items[2], items[0], items[3], items[1]] as Item[],
      done: new Set(['a']),
      stops: [...iberia.stops].reverse(),
      days: [...iberia.days].reverse(),
    });
    expect(JSON.stringify(shuffled)).toEqual(JSON.stringify(base));
  });
});
