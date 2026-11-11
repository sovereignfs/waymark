import { describe, expect, it } from 'vitest';
import { ago, groupByDay } from './present';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 10, 11, 12, 0);

describe('how long ago', () => {
  it('is just now, minutes, hours, days, and the date from a week on', () => {
    expect(ago(NOW, NOW)).toBe('just now');
    expect(ago(NOW - 59_000, NOW)).toBe('just now');
    expect(ago(NOW - 5 * MIN, NOW)).toBe('5m ago');
    expect(ago(NOW - 3 * HOUR, NOW)).toBe('3h ago');
    expect(ago(NOW - 2 * DAY, NOW)).toBe('2d ago');
    expect(ago(NOW - 7 * DAY, NOW, 'en-GB')).toBe('4 Nov');
  });

  it('is just now for a time in the future, which is a clock a little behind', () => {
    expect(ago(NOW + 10 * MIN, NOW)).toBe('just now');
  });
});

describe('the days of the page', () => {
  const notice = (id: string, at: number) => ({ id, at });
  it('groups by the day in the reader’s zone: Today, Yesterday, then the date, newest first', () => {
    const days = groupByDay(
      [
        notice('a', NOW - HOUR),
        notice('b', NOW - 5 * HOUR),
        notice('c', NOW - DAY),
        notice('d', NOW - 10 * DAY),
        notice('e', Date.UTC(2025, 2, 3, 12)),
      ],
      NOW,
      'UTC',
      'en-GB',
    );
    expect(days.map((day) => day.label)).toEqual([
      'Today',
      'Yesterday',
      'Sun 1 Nov',
      'Mon, 3 Mar 2025',
    ]);
    expect(days[0]?.notices.map((each) => each.id)).toEqual(['a', 'b']);
  });

  it('puts a notice on the day it was in the reader’s zone, so the same moment is two days in two zones', () => {
    const late = Date.UTC(2026, 10, 11, 23, 30);
    const at = (zone: string) => groupByDay([notice('x', late)], late + HOUR, zone, 'en-GB')[0];
    expect(at('UTC')?.date).toBe('2026-11-11');
    expect(at('Pacific/Auckland')?.date).toBe('2026-11-12');
    expect(at('Pacific/Auckland')?.label).toBe('Today');
  });

  it('orders notices of the same moment by id, so the order is the same everywhere', () => {
    const days = groupByDay([notice('a', NOW), notice('c', NOW), notice('b', NOW)], NOW, 'UTC');
    expect(days[0]?.notices.map((each) => each.id)).toEqual(['c', 'b', 'a']);
  });

  it('is nothing for no notices', () => {
    expect(groupByDay([], NOW, 'UTC')).toEqual([]);
  });
});
