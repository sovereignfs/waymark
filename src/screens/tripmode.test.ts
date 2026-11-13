import { describe, expect, it } from 'vitest';
import { countdownText, dayLine, screenOf, tripDayNumber } from './tripmode';

/** Trip Mode's screen (DESIGN.md §14.2) without a browser: for whom, and the words. */
const base = {
  role: 'traveler',
  going: true,
  status: 'ongoing' as const,
  state: 'during' as const,
  edge: undefined,
};

describe('what Trip Mode shows', () => {
  it('is today for a Traveler, and for an Organizer who is going, on a trip that is on', () => {
    expect(screenOf(base)).toEqual({ kind: 'during' });
    expect(screenOf({ ...base, role: 'organizer' })).toEqual({ kind: 'during' });
  });

  it('is for the people going: not a Follower, and not an Organizer who is not going', () => {
    expect(screenOf({ ...base, role: 'follower' })).toEqual({ kind: 'not-going' });
    expect(screenOf({ ...base, role: 'organizer', going: false })).toEqual({ kind: 'not-going' });
    // A Traveler is going whatever the flag says (the flag is an Organizer's switch).
    expect(screenOf({ ...base, going: false })).toEqual({ kind: 'during' });
  });

  it('says when the trip starts before it has and that it ended after, with the date', () => {
    expect(screenOf({ ...base, status: 'upcoming', state: 'before', edge: '2026-06-10' })).toEqual({
      kind: 'before',
      date: '2026-06-10',
    });
    expect(screenOf({ ...base, status: 'completed', state: 'after', edge: '2026-06-12' })).toEqual({
      kind: 'after',
      date: '2026-06-12',
    });
  });

  it('says there is no today for a trip still planning or with no dates, even with a day that is today’s', () => {
    expect(screenOf({ ...base, status: 'planning' })).toEqual({ kind: 'not-ready' });
    expect(screenOf({ ...base, state: 'planning' })).toEqual({ kind: 'not-ready' });
  });

  it('is between for a day between two stops, and never says "during" for a state that is not', () => {
    expect(screenOf({ ...base, state: 'between' })).toEqual({ kind: 'between' });
    expect(screenOf({ ...base, state: 'before', edge: undefined })).toEqual({ kind: 'not-ready' });
  });

  it('tells a person who is not going nothing of the trip’s dates', () => {
    expect(
      screenOf({
        ...base,
        role: 'follower',
        status: 'upcoming',
        state: 'before',
        edge: '2026-06-10',
      }),
    ).toEqual({ kind: 'not-going' });
  });
});

describe('the words', () => {
  it('say a countdown', () => {
    expect([0, -5, 1, 40, 59, 60, 125, 240, 1439, 1440, 2880, 4400].map(countdownText)).toEqual([
      'now',
      'now',
      'in 1 min',
      'in 40 min',
      'in 59 min',
      'in 1 h',
      'in 2 h 5 min',
      'in 4 h',
      'in 23 h 59 min',
      'in 1 day',
      'in 2 days',
      'in 3 days',
    ]);
  });

  it('number the days of the trip, a date two stops share counting once', () => {
    const days = [
      { date: '2026-06-12' },
      { date: '2026-06-10' },
      { date: '2026-06-11' },
      { date: '2026-06-12' },
    ];
    expect(tripDayNumber(days, '2026-06-10')).toBe(1);
    expect(tripDayNumber(days, '2026-06-12')).toBe(3);
    expect(tripDayNumber(days, '2026-07-01')).toBeUndefined();
    expect(tripDayNumber(days, null)).toBeUndefined();
  });

  it('say where and which day', () => {
    expect(dayLine(['Kyoto'], 2)).toBe('Kyoto · day 2');
    expect(dayLine(['Lisbon', 'Sintra'], 3)).toBe('Lisbon → Sintra · day 3');
    expect(dayLine(['Kyoto'], undefined)).toBe('Kyoto');
  });
});
