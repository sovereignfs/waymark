import { describe, expect, it } from 'vitest';
import type { CheckinView, PlaceView } from '../actions/types';
import type { TripData } from '../local/store';
import { journalOfTrip } from './trip';

/** The journal for a trip as a device holds it: the reader's own check-ins linked to **this** trip, and the copies others shared with it, and nothing else. */
const place = (id: string, name: string, lat: number, lng: number): PlaceView =>
  ({
    id,
    name,
    lat,
    lng,
    source: 'manual',
    tz: 'Europe/Lisbon',
    countryCode: 'PT',
    version: 1,
  }) as unknown as PlaceView;
const checkin = (id: string, placeId: string, tripId: string | null): CheckinView =>
  ({
    id,
    placeId,
    at: Date.parse('2026-06-10T10:00:00Z'),
    tz: 'Europe/Lisbon',
    offsetMin: 60,
    companions: [],
    tripId,
    linkSource: tripId ? 'manual' : null,
    share: 'trip',
    source: 'live',
    version: 1,
  }) as unknown as CheckinView;

const PLACES = [place('p1', 'Castelo', 38.7139, -9.1335), place('p2', 'Alfama', 38.711, -9.13)];
const data = {
  role: 'traveler',
  sets: {
    trip: { id: 'trip-1' },
    members: [
      { accountId: 'me', name: 'Me', role: 'traveler', going: true, joinedAt: 1, self: true },
      {
        accountId: 'grace',
        name: 'Grace',
        role: 'traveler',
        going: true,
        joinedAt: 1,
        self: false,
      },
    ],
    stops: [
      {
        id: 's',
        arrive: '2026-06-10',
        depart: '2026-06-10',
        position: '1',
        place: { id: 'sp', name: 'Lisbon', lat: 38.72, lng: -9.14, tz: 'Europe/Lisbon' },
      },
    ],
    days: [],
    links: [],
    done: [],
  },
  items: [],
  days: [
    { id: 'd', stopId: 's', date: '2026-06-10', title: undefined, notes: undefined, version: 1 },
  ],
  shared: [
    {
      id: 'copy',
      authorId: 'grace',
      seq: 1,
      place: { name: 'Alfama', lat: 38.711, lng: -9.13 },
      at: Date.parse('2026-06-10T11:00:00Z'),
      tz: 'Europe/Lisbon',
      offsetMin: 60,
      companions: [],
      photos: [],
    },
  ],
  done: new Set<string>(),
  pending: new Set<string>(),
} as unknown as TripData;
const NOW = Date.parse('2026-07-01T12:00:00Z');
const run = (checkins: CheckinView[], over: Partial<TripData> = {}) =>
  journalOfTrip({ ...data, ...over }, 'trip-1', checkins, PLACES, 'me', NOW, 'Europe/Lisbon');

describe('what the journal is given', () => {
  it('is the reader’s own check-ins linked to this trip, and the copies others shared with it', () => {
    const journal = run([checkin('mine', 'p1', 'trip-1')]);
    expect(journal?.figures.checkins).toBe(2);
    const found = journal?.days[0]?.entries.map((entry) =>
      entry.kind === 'found' ? entry.checkin.id : entry.item.id,
    );
    expect(found).toEqual(['mine', 'copy']);
  });

  it('does not have one of the reader’s own that follows another trip, or none', () => {
    const journal = run([checkin('other-trip', 'p1', 'trip-2'), checkin('no-trip', 'p1', null)]);
    expect(journal?.figures.checkins).toBe(1);
    expect(JSON.stringify(journal?.days)).not.toContain('other-trip');
    expect(JSON.stringify(journal?.days)).not.toContain('no-trip');
  });

  it('does not have one whose place the device does not hold, and none for a trip it holds nothing of', () => {
    expect(run([checkin('lost', 'nowhere', 'trip-1')])?.figures.checkins).toBe(1);
    expect(run([], { sets: undefined })).toBeUndefined();
  });

  it('does not count a Follower’s own check-in (a Follower is not going)', () => {
    const asFollower = {
      sets: {
        ...data.sets,
        members: data.sets?.members.map((member) =>
          member.self ? { ...member, role: 'follower' } : member,
        ),
      },
    } as unknown as Partial<TripData>;
    expect(run([checkin('mine', 'p1', 'trip-1')], asFollower)?.figures.checkins).toBe(1);
  });
});
