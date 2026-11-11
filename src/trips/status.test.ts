import { describe, expect, it } from 'vitest';
import { statusOf } from './status';

/** A trip's status (DESIGN.md §10.2): each status at the day's edges, in the first stop's zone. */
const READY = 1_700_000_000_000;
const trip = (
  over: Partial<{ readyAt: number | null; startDate: string | null; endDate: string | null }> = {},
) => ({
  readyAt: READY,
  startDate: '2026-05-10',
  endDate: '2026-05-14',
  ...over,
});
/** The moment at which the clock in `zone` says `local` (an ISO time with a fixed offset). */
const at = (iso: string) => Date.parse(iso);

describe('a trip that is ready', () => {
  it('is upcoming before its first day, ongoing from it to its last, and completed after', () => {
    const zone = 'Europe/Lisbon';
    expect(statusOf(trip(), at('2026-05-09T23:59:59+01:00'), zone).status).toBe('upcoming');
    expect(statusOf(trip(), at('2026-05-10T00:00:00+01:00'), zone).status).toBe('ongoing');
    expect(statusOf(trip(), at('2026-05-12T12:00:00+01:00'), zone).status).toBe('ongoing');
    expect(statusOf(trip(), at('2026-05-14T23:59:59+01:00'), zone).status).toBe('ongoing');
    expect(statusOf(trip(), at('2026-05-15T00:00:00+01:00'), zone).status).toBe('completed');
  });

  it('is a single-day trip ongoing for that day only', () => {
    const one = trip({ startDate: '2026-05-10', endDate: '2026-05-10' });
    expect(statusOf(one, at('2026-05-09T23:59:59Z'), 'UTC').status).toBe('upcoming');
    expect(statusOf(one, at('2026-05-10T00:00:00Z'), 'UTC').status).toBe('ongoing');
    expect(statusOf(one, at('2026-05-10T23:59:59Z'), 'UTC').status).toBe('ongoing');
    expect(statusOf(one, at('2026-05-11T00:00:00Z'), 'UTC').status).toBe('completed');
  });

  it('decides the day in the first stop’s zone, whoever asks and wherever they are', () => {
    const moment = at('2026-05-09T13:00:00Z');
    // 13:00 UTC on the 9th is 01:00 on the 10th in Auckland (UTC+12), and still the 9th in Los Angeles and in Lisbon.
    expect(statusOf(trip(), moment, 'Pacific/Auckland')).toMatchObject({
      status: 'ongoing',
      today: '2026-05-10',
    });
    expect(statusOf(trip(), moment, 'America/Los_Angeles')).toMatchObject({
      status: 'upcoming',
      today: '2026-05-09',
    });
    expect(statusOf(trip(), moment, 'Europe/Lisbon')).toMatchObject({
      status: 'upcoming',
      today: '2026-05-09',
    });
    // The last day ends at the zone's midnight, not UTC's.
    const late = at('2026-05-14T16:00:00Z');
    expect(statusOf(trip(), late, 'Pacific/Auckland').status).toBe('completed');
    expect(statusOf(trip(), late, 'America/Los_Angeles').status).toBe('ongoing');
  });

  it('keeps the day right on the night a clock changes', () => {
    // Lisbon's clocks go forward at 01:00 on 2026-03-29: the day is still 29 March from midnight to midnight.
    const dst = trip({ startDate: '2026-03-29', endDate: '2026-03-29' });
    expect(statusOf(dst, at('2026-03-28T23:59:59+00:00'), 'Europe/Lisbon').status).toBe('upcoming');
    expect(statusOf(dst, at('2026-03-29T00:00:00+00:00'), 'Europe/Lisbon').status).toBe('ongoing');
    expect(statusOf(dst, at('2026-03-29T22:59:59+00:00'), 'Europe/Lisbon').status).toBe('ongoing');
    expect(statusOf(dst, at('2026-03-29T23:00:00+00:00'), 'Europe/Lisbon').status).toBe(
      'completed',
    );
  });

  it('falls back to UTC where the first stop has no zone', () => {
    expect(statusOf(trip(), at('2026-05-10T00:00:00Z'), null).status).toBe('ongoing');
    expect(statusOf(trip(), at('2026-05-09T23:59:59Z'), undefined).status).toBe('upcoming');
    expect(statusOf(trip(), at('2026-05-09T23:59:59Z'), '').status).toBe('upcoming');
  });
});

describe('a trip that is not ready', () => {
  it('is planning whatever its dates say, and says when its dates have passed', () => {
    const planning = trip({ readyAt: null });
    expect(statusOf(planning, at('2026-05-01T00:00:00Z'), 'UTC')).toMatchObject({
      status: 'planning',
      datesPassed: false,
    });
    expect(statusOf(planning, at('2026-05-12T00:00:00Z'), 'UTC')).toMatchObject({
      status: 'planning',
      datesPassed: false,
    });
    expect(statusOf(planning, at('2026-05-14T23:59:59Z'), 'UTC')).toMatchObject({
      status: 'planning',
      datesPassed: false,
    });
    expect(statusOf(planning, at('2026-05-15T00:00:00Z'), 'UTC')).toMatchObject({
      status: 'planning',
      datesPassed: true,
    });
  });

  it('has no dates passed when it has no dates', () => {
    expect(
      statusOf(
        trip({ readyAt: null, startDate: null, endDate: null }),
        at('2030-01-01T00:00:00Z'),
        'UTC',
      ),
    ).toMatchObject({ status: 'planning', datesPassed: false });
  });
});

describe('a trip that is ready and has lost its dates', () => {
  it('is planning, since nothing decides it, and its dates have not passed', () => {
    expect(
      statusOf(trip({ startDate: null, endDate: null }), at('2030-01-01T00:00:00Z'), 'UTC'),
    ).toEqual({
      status: 'planning',
      datesPassed: false,
      today: '2030-01-01',
    });
  });
});
