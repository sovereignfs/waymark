import { describe, expect, it } from 'vitest';
import {
  type DatedStop,
  MAX_STOP_DAYS,
  MAX_TRIP_DAYS,
  addDays,
  checkStopDates,
  checkStops,
  datesOf,
  dayNumber,
  isDate,
  orderStops,
  reconcileDays,
  tripDates,
} from './dates';

/** A trip's dates (DESIGN.md §10.3, §10.4): the calendar's own arithmetic, the rules for a stop and for a trip, and how days follow the dates. */
const stop = (
  id: string,
  arrive: string | null,
  depart: string | null,
  position = '00001000',
): DatedStop => ({
  id,
  arrive,
  depart,
  position,
});

describe('a date', () => {
  it('is a real day of the calendar, written YYYY-MM-DD', () => {
    for (const good of ['2026-11-12', '2024-02-29', '2000-01-01', '2026-12-31'])
      expect(isDate(good), good).toBe(true);
    for (const bad of [
      '2026-02-29',
      '2026-04-31',
      '2026-13-01',
      '2026-00-10',
      '2026-1-1',
      '26-01-01',
      '2026-01-01T00:00',
      '',
      'tomorrow',
      null,
      undefined,
      20260101,
      '1850-01-01',
      '2300-01-01',
    ])
      expect(isDate(bad), String(bad)).toBe(false);
  });

  it('counts days by the calendar, across a month, a leap day and a year, with no zone to move it', () => {
    expect(addDays('2026-01-31', 1)).toBe('2026-02-01');
    expect(addDays('2024-02-28', 1)).toBe('2024-02-29');
    expect(addDays('2024-02-29', 1)).toBe('2024-03-01');
    expect(addDays('2025-12-31', 1)).toBe('2026-01-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    // The days daylight saving changes are still one day apart.
    expect(addDays('2026-03-29', 1)).toBe('2026-03-30');
    expect(addDays('2026-10-25', 1)).toBe('2026-10-26');
    expect((dayNumber('2026-11-12') ?? 0) - (dayNumber('2026-11-11') ?? 0)).toBe(1);
  });

  it('lists every date of a stop from arrival to departure', () => {
    expect(datesOf('2026-02-27', '2026-03-02')).toEqual([
      '2026-02-27',
      '2026-02-28',
      '2026-03-01',
      '2026-03-02',
    ]);
    expect(datesOf('2026-05-05', '2026-05-05')).toEqual(['2026-05-05']);
    expect(datesOf('2026-05-06', '2026-05-05')).toEqual([]);
  });
});

describe('a stop’s dates', () => {
  it('are both or neither, real, in order, and at most 90 days', () => {
    expect(checkStopDates(undefined, null)).toEqual({ ok: true, arrive: null, depart: null });
    expect(checkStopDates('2026-05-01', '2026-05-01')).toMatchObject({ ok: true });
    expect(checkStopDates('2026-05-01', addDays('2026-05-01', MAX_STOP_DAYS - 1))).toMatchObject({
      ok: true,
    });
    expect(checkStopDates('2026-05-01', addDays('2026-05-01', MAX_STOP_DAYS))).toMatchObject({
      ok: false,
      reason: 'limit',
    });
    expect(checkStopDates('2026-05-01', undefined)).toMatchObject({ ok: false, reason: 'invalid' });
    expect(checkStopDates(undefined, '2026-05-01')).toMatchObject({ ok: false, reason: 'invalid' });
    expect(checkStopDates('2026-05-02', '2026-05-01')).toMatchObject({
      ok: false,
      reason: 'invalid',
    });
    expect(checkStopDates('2026-02-30', '2026-03-01')).toMatchObject({
      ok: false,
      reason: 'invalid',
    });
  });

  it('say what is wrong without repeating what was given', () => {
    const bad = checkStopDates('1999-99-99', 'nonsense');
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.sentence).not.toContain('nonsense');
      expect(bad.sentence).not.toContain('1999');
    }
  });
});

describe('the stops of a trip', () => {
  it('are in order of their dates, the undated ones after them in their own order, ties broken the same everywhere', () => {
    const ordered = orderStops([
      stop('c', null, null, '00002000'),
      stop('b', '2026-06-01', '2026-06-03'),
      stop('d', null, null, '00001000'),
      stop('a', '2026-05-01', '2026-05-10'),
      stop('e', '2026-06-01', '2026-06-01'),
      stop('f', '2026-06-01', '2026-06-01'),
    ]);
    expect(ordered.map((each) => each.id)).toEqual(['a', 'e', 'f', 'b', 'd', 'c']);
  });

  it('may share a boundary day, and may not overlap otherwise', () => {
    expect(
      checkStops([stop('a', '2026-05-01', '2026-05-05'), stop('b', '2026-05-05', '2026-05-09')]),
    ).toBeUndefined();
    expect(
      checkStops([stop('a', '2026-05-01', '2026-05-05'), stop('b', '2026-05-06', '2026-05-09')]),
    ).toBeUndefined();
    expect(
      checkStops([stop('a', '2026-05-01', '2026-05-05'), stop('b', '2026-05-04', '2026-05-09')]),
    ).toMatchObject({ reason: 'overlap' });
    expect(
      checkStops([stop('a', '2026-05-01', '2026-05-09'), stop('b', '2026-05-03', '2026-05-04')]),
    ).toMatchObject({ reason: 'overlap' });
    expect(
      checkStops([stop('a', '2026-05-01', '2026-05-05'), stop('b', '2026-05-01', '2026-05-05')]),
    ).toMatchObject({ reason: 'overlap' });
  });

  it('put at most two stops on a day', () => {
    expect(
      checkStops([
        stop('a', '2026-05-01', '2026-05-03'),
        stop('b', '2026-05-03', '2026-05-03'),
        stop('c', '2026-05-03', '2026-05-05'),
      ]),
    ).toMatchObject({ reason: 'overlap' });
  });

  it('let a stop with no dates sit anywhere, and make no days', () => {
    expect(
      checkStops([
        stop('a', '2026-05-01', '2026-05-03'),
        stop('b', null, null),
        stop('c', null, null),
      ]),
    ).toBeUndefined();
  });

  it('come to at most 365 days, each stop’s days counted', () => {
    const year = [
      stop('a', '2026-01-01', addDays('2026-01-01', 89)),
      stop('b', '2026-04-01', addDays('2026-04-01', 89)),
      stop('c', '2026-07-01', addDays('2026-07-01', 89)),
      stop('d', '2026-10-01', addDays('2026-10-01', 89)),
    ];
    expect(checkStops(year)).toBeUndefined();
    // 4 x 90 = 360; five days more is 365 and one more is over.
    expect(checkStops([...year, stop('e', '2027-02-01', '2027-02-05')])).toBeUndefined();
    expect(checkStops([...year, stop('e', '2027-02-01', '2027-02-06')])).toMatchObject({
      reason: 'limit',
    });
    expect(MAX_TRIP_DAYS).toBe(365);
  });
});

describe('the trip’s dates', () => {
  it('are its first arrival and its last departure, and none while no stop has dates', () => {
    expect(tripDates([])).toEqual({ start: null, end: null });
    expect(tripDates([stop('a', null, null)])).toEqual({ start: null, end: null });
    expect(
      tripDates([
        stop('b', '2026-06-01', '2026-06-09'),
        stop('a', '2026-05-01', '2026-05-10'),
        stop('u', null, null),
      ]),
    ).toEqual({ start: '2026-05-01', end: '2026-06-09' });
  });
});

describe('days following a stop’s dates', () => {
  it('are made for new dates, removed for dates that left, and kept for the rest', () => {
    expect(
      reconcileDays(
        ['2026-05-01', '2026-05-02', '2026-05-03'],
        ['2026-05-02', '2026-05-03', '2026-05-04'],
      ),
    ).toEqual({
      add: ['2026-05-04'],
      remove: ['2026-05-01'],
      keep: ['2026-05-02', '2026-05-03'],
    });
    expect(reconcileDays([], ['2026-05-01'])).toEqual({
      add: ['2026-05-01'],
      remove: [],
      keep: [],
    });
    expect(reconcileDays(['2026-05-01'], [])).toEqual({
      add: [],
      remove: ['2026-05-01'],
      keep: [],
    });
  });
});
