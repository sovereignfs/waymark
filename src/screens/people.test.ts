import { describe, expect, it } from 'vitest';
import type { TripEntry } from '../local/db';
import {
  type Member,
  type Waiting,
  actionsFor,
  canResend,
  expiresText,
  leaveWay,
  membersInOrder,
  organizersOf,
  suggestPeople,
  waitingFor,
} from './people';

/** A trip's People (DESIGN.md §11, §20.10) without a browser: who may do what to whom, who to suggest, and the words for what is waiting. */
const member = (
  accountId: string,
  name: string,
  role: Member['role'],
  joinedAt: number,
  over: Partial<Member> = {},
): Member => ({
  accountId,
  name,
  role,
  going: true,
  joinedAt,
  self: false,
  ...over,
});
const ADA = member('ada', 'Ada Lovelace', 'organizer', 1, { self: true });
const GRACE = member('grace', 'Grace Hopper', 'traveler', 2);
const HUGO = member('hugo', 'Hugo Gernsback', 'organizer', 3);
const FAY = member('fay', 'Fay', 'follower', 4);

describe('the list', () => {
  it('is Organizers first, then Travelers, then Followers, each by who joined first', () => {
    const got = membersInOrder([FAY, GRACE, HUGO, ADA, member('sam', 'Sam', 'traveler', 0)]);
    expect(got.map((m) => m.accountId)).toEqual(['ada', 'hugo', 'sam', 'grace', 'fay']);
    expect(organizersOf(got)).toBe(2);
  });
});

describe('what the reader may do about a person', () => {
  const org = { role: 'organizer' };
  it('lets an Organizer change a role and remove anyone but themselves, and switch their own going', () => {
    expect(actionsFor(org, GRACE, 2)).toEqual({
      changeRole: 'yes',
      remove: true,
      leave: false,
      goingSwitch: false,
    });
    expect(actionsFor(org, ADA, 2)).toEqual({
      changeRole: 'yes',
      remove: false,
      leave: true,
      goingSwitch: true,
    });
  });

  it('keeps the last Organizer from changing their own role', () => {
    expect(actionsFor(org, ADA, 1).changeRole).toBe('last');
    expect(actionsFor(org, HUGO, 1).changeRole).toBe('yes');
  });

  it('gives a Traveler and a Follower nothing but leaving', () => {
    for (const role of ['traveler', 'follower']) {
      const me = member('me', 'Me', role as Member['role'], 5, { self: true });
      expect(actionsFor({ role }, me, 1)).toEqual({
        changeRole: 'no',
        remove: false,
        leave: true,
        goingSwitch: false,
      });
      expect(actionsFor({ role }, GRACE, 1)).toEqual({
        changeRole: 'no',
        remove: false,
        leave: false,
        goingSwitch: false,
      });
    }
  });
});

describe('leaving', () => {
  it('is one press for everyone but the last Organizer', () => {
    expect(leaveWay([GRACE, { ...ADA, role: 'traveler' }]).kind).toBe('leave');
    expect(leaveWay([ADA, HUGO, GRACE]).kind).toBe('leave');
    expect(leaveWay([member('me', 'Me', 'follower', 1, { self: true }), ADA]).kind).toBe('leave');
  });

  it('asks the last Organizer who takes over, from the others in order', () => {
    const way = leaveWay([ADA, FAY, GRACE]);
    expect(way.kind).toBe('hand-over');
    expect(way.kind === 'hand-over' && way.successors.map((m) => m.accountId)).toEqual([
      'grace',
      'fay',
    ]);
  });

  it('says to delete the trip for the only one in it', () => {
    expect(leaveWay([ADA]).kind).toBe('delete-instead');
  });
});

describe('who to suggest for an invitation', () => {
  const trip = (...members: Member[]): TripEntry =>
    ({
      id: 't',
      role: 'organizer',
      cursor: 0,
      floor: 0,
      head: 0,
      sets: { members },
    }) as unknown as TripEntry;
  const trips = [
    trip(ADA, GRACE, member('noor', 'Noor Inayat', 'traveler', 5)),
    trip(
      ADA,
      member('grace', 'Grace Hopper', 'traveler', 2),
      member('zoe', 'Zoë Kravitz', 'follower', 6),
    ),
  ];

  it('is the people the Organizer shares a trip with, once each, who are not in this one and not themselves', () => {
    expect(suggestPeople(trips, 'gr', new Set()).map((s) => s.accountId)).toEqual(['grace']);
    expect(suggestPeople(trips, 'gr', new Set(['grace']))).toEqual([]);
    expect(suggestPeople(trips, 'lovelace', new Set())).toEqual([]);
  });

  it('matches without case or accents and by every word, in any order', () => {
    expect(suggestPeople(trips, 'ZOE', new Set()).map((s) => s.accountId)).toEqual(['zoe']);
    expect(suggestPeople(trips, 'inayat noor', new Set()).map((s) => s.accountId)).toEqual([
      'noor',
    ]);
    expect(suggestPeople(trips, 'noor hopper', new Set())).toEqual([]);
  });

  it('is nothing for nothing typed, and at most the limit', () => {
    expect(suggestPeople(trips, '   ', new Set())).toEqual([]);
    const many = trip(
      ...Array.from({ length: 10 }, (_, i) => member(`p${i}`, `Person ${i}`, 'traveler', i)),
    );
    expect(suggestPeople([many], 'person', new Set())).toHaveLength(6);
    expect(suggestPeople([many], 'person', new Set(), 3)).toHaveLength(3);
    expect(
      suggestPeople(
        [{ id: 'x', role: 'follower', cursor: 0, floor: 0, head: 0, sets: undefined } as TripEntry],
        'a',
        new Set(),
      ),
    ).toEqual([]);
  });
});

describe('what is waiting', () => {
  const NOW = Date.parse('2026-06-01T12:00:00Z');
  const inv = (over: Partial<Waiting> = {}): Waiting => ({
    id: 'i',
    role: 'traveler',
    via: 'email',
    email: 'noor@example.com',
    lastSentAt: NOW,
    expiresAt: NOW + 13.2 * 86_400_000,
    ...over,
  });

  it('says who it is for', () => {
    expect(waitingFor(inv())).toBe('noor@example.com');
    expect(waitingFor(inv({ via: 'link', email: undefined }))).toBe('Anyone with the link');
    expect(waitingFor(inv({ via: 'account', email: undefined }))).toBe('A person chosen by name');
  });

  it('can be resent once an hour, and never for a link, which has nothing to send', () => {
    expect(canResend(inv(), NOW + 59 * 60_000)).toBe(false);
    expect(canResend(inv(), NOW + 60 * 60_000)).toBe(true);
    expect(canResend(inv({ via: 'link' }), NOW + 5 * 3_600_000)).toBe(false);
  });

  it('says when it expires', () => {
    expect(expiresText(inv(), NOW)).toBe('Expires in 14 days');
    expect(expiresText(inv({ expiresAt: NOW + 3_600_000 }), NOW)).toBe('Expires tomorrow');
    expect(expiresText(inv({ expiresAt: NOW - 1 }), NOW)).toBe('Expires today');
  });
});
