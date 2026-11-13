import { describe, expect, it } from 'vitest';
import type { TripEntry } from '../local/db';
import { autoLinkFor, candidatesOf } from './device';

/** Auto-link on the device: which trips it holds are candidates, and the hook an action asks. The rule itself (`decide`) is held by `decide.test.ts`. */
const entry = (
  id: string,
  role: string,
  over: {
    going?: boolean;
    start?: string | null;
    end?: string | null;
    createdAt?: number;
    lat?: number;
    lng?: number;
  } = {},
): TripEntry =>
  ({
    id,
    role,
    cursor: 1,
    floor: 0,
    head: 1,
    sets: {
      trip: {
        id,
        going: over.going ?? true,
        startDate: over.start === undefined ? '2026-06-10' : over.start,
        endDate: over.end === undefined ? '2026-06-12' : over.end,
        createdAt: over.createdAt ?? 1,
      },
      stops: [
        {
          id: `${id}-s`,
          arrive: '2026-06-10',
          depart: '2026-06-12',
          place: { lat: over.lat ?? 38.7, lng: over.lng ?? -9.1 },
        },
        { id: `${id}-u`, arrive: null, depart: null, place: { lat: 0, lng: 0 } },
      ],
      members: [],
      days: [],
      links: [],
      done: [],
    },
  }) as unknown as TripEntry;

const AT = Date.parse('2026-06-11T10:00:00Z');
const PLACES = [{ id: 'p', lat: 38.7, lng: -9.1 }];

describe('the trips the device holds as candidates', () => {
  it('are those the person goes on: a Traveler, or an Organizer who is going, and not a Follower', () => {
    const got = candidatesOf([
      entry('traveler', 'traveler'),
      entry('going', 'organizer', { going: true }),
      entry('not-going', 'organizer', { going: false }),
      entry('follower', 'follower'),
    ]);
    expect(got.map((c) => [c.id, c.goes])).toEqual([
      ['traveler', true],
      ['going', true],
      ['not-going', false],
      ['follower', false],
    ]);
  });

  it('carry the stops that have dates, and none for a trip the device holds no rows of', () => {
    const [one] = candidatesOf([entry('t', 'traveler')]);
    expect(one?.stops).toEqual([
      { arrive: '2026-06-10', depart: '2026-06-12', point: { lat: 38.7, lng: -9.1 } },
    ]);
    expect(
      candidatesOf([
        { id: 'x', role: 'traveler', cursor: 0, floor: 0, head: 0, sets: undefined } as TripEntry,
      ]),
    ).toEqual([]);
  });
});

describe('the hook', () => {
  it('links a check-in to the trip whose dates contain its local day, for a Traveler', () => {
    const link = autoLinkFor([entry('t', 'traveler')], PLACES);
    expect(link({ at: AT, tz: 'Europe/Lisbon', placeId: 'p' })).toEqual({ tripId: 't' });
    expect(
      link({ at: Date.parse('2026-07-01T10:00:00Z'), tz: 'Europe/Lisbon', placeId: 'p' }),
    ).toBeNull();
  });

  it('links to no trip for a Follower, an Organizer who is not going, or a trip with no dates', () => {
    for (const trips of [
      [entry('f', 'follower')],
      [entry('o', 'organizer', { going: false })],
      [entry('n', 'traveler', { start: null, end: null })],
    ])
      expect(autoLinkFor(trips, PLACES)({ at: AT, tz: 'Europe/Lisbon', placeId: 'p' })).toBeNull();
  });

  it('takes the trip whose stop is nearest, and the shorter trip when they are alike', () => {
    const far = entry('far', 'traveler', { lat: 48.8, lng: 2.3 });
    const near = entry('near', 'traveler');
    expect(autoLinkFor([far, near], PLACES)({ at: AT, tz: 'Europe/Lisbon', placeId: 'p' })).toEqual(
      { tripId: 'near' },
    );
  });

  it('decides without a point when the place is not known, rather than not at all', () => {
    expect(
      autoLinkFor([entry('t', 'traveler')], [])({ at: AT, tz: 'Europe/Lisbon', placeId: 'gone' }),
    ).toEqual({ tripId: 't' });
  });
});
