import { describe, expect, it } from 'vitest';
import type { CheckinView, PlaceView } from '../actions/types';
import { isNewPerson, nearestPlace, nextTrip, ongoingTrip, recently, untilText } from './home';
import type { TripCard } from './trips';

/** Home (DESIGN.md §20.4) without a browser: what is on, what is next, what was last. */
const card = (id: string, status: TripCard['status'], startDate: string | null): TripCard =>
  ({ id, status, startDate, name: id, endDate: startDate }) as unknown as TripCard;
const place = (id: string, lat: number, lng: number): PlaceView =>
  ({ id, name: id, lat, lng }) as unknown as PlaceView;
const checkin = (id: string, at: number): CheckinView => ({ id, at }) as unknown as CheckinView;

describe('the trip that is on and the next one', () => {
  const cards = [
    card('later', 'upcoming', '2026-09-01'),
    card('soon', 'upcoming', '2026-07-01'),
    card('planning', 'planning', '2026-06-20'),
    card('on', 'ongoing', '2026-06-10'),
    card('also-on', 'ongoing', '2026-06-12'),
    card('done', 'completed', '2025-01-01'),
  ];
  it('is the ongoing trip that began first, and none when none is on', () => {
    expect(ongoingTrip(cards)?.id).toBe('on');
    expect(ongoingTrip(cards.filter((c) => c.status !== 'ongoing'))).toBeUndefined();
  });
  it('is the soonest ready trip that has not begun, never one still planning or over', () => {
    expect(nextTrip(cards)?.id).toBe('soon');
    expect(nextTrip(cards.filter((c) => c.status !== 'upcoming'))).toBeUndefined();
  });
  it('says how long until it', () => {
    expect(untilText('2026-07-01', '2026-06-08')).toBe('in 23 days');
    expect(untilText('2026-07-01', '2026-06-30')).toBe('tomorrow');
    expect(untilText('2026-07-01', '2026-07-01')).toBe('today');
    expect(untilText('2026-07-01', '2026-07-05')).toBe('today');
  });
});

describe('recently and nearby', () => {
  it('is the last ten check-ins, newest first, whatever order they are held in', () => {
    const rows = Array.from({ length: 14 }, (_, i) => checkin(`c${i}`, i * 1000));
    expect(recently([...rows].reverse()).map((c) => c.id)).toEqual([
      'c13',
      'c12',
      'c11',
      'c10',
      'c9',
      'c8',
      'c7',
      'c6',
      'c5',
      'c4',
    ]);
    expect(recently(rows, 3)).toHaveLength(3);
    expect(recently([])).toEqual([]);
  });

  it('is the person’s own place nearest the position, within a kilometre and a half, and none without a position', () => {
    const places = [
      place('far', 48.86, 2.29),
      place('near', 38.7141, -9.1336),
      place('nearer', 38.7139, -9.1335),
    ];
    expect(nearestPlace(places, { lat: 38.7139, lng: -9.1335 })?.place.id).toBe('nearer');
    expect(nearestPlace(places, { lat: 0, lng: 0 })).toBeUndefined();
    expect(nearestPlace(places, undefined)).toBeUndefined();
  });
});

describe('a new person', () => {
  it('has no check-in and no trip', () => {
    expect(isNewPerson([], [])).toBe(true);
    expect(isNewPerson([checkin('a', 1)], [])).toBe(false);
    expect(isNewPerson([], [card('t', 'planning', null)])).toBe(false);
  });
});
