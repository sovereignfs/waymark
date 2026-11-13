import { describe, expect, it } from 'vitest';
import {
  type JournalCheckin,
  type JournalInput,
  type JournalItem,
  journalOf,
  sentenceOf,
} from './index';

/** Planned versus actual (DESIGN.md §13), worked by hand: a trip of two stops with a travel day, four people, and check-ins of each kind. */
const at = (iso: string) => Date.parse(iso);
const ZONE = 'Europe/Lisbon';
const pt = (name: string, lat: number, lng: number) => ({ name, lat, lng });

const stops = [
  {
    id: 'a',
    arrive: '2026-06-10',
    depart: '2026-06-12',
    position: '1',
    place: { ...pt('Lisbon', 38.72, -9.14), tz: ZONE },
  },
  {
    id: 'b',
    arrive: '2026-06-12',
    depart: '2026-06-13',
    position: '2',
    place: { ...pt('Sintra', 38.8, -9.38), tz: ZONE },
  },
];
const days = [
  { id: 'd10', stopId: 'a', date: '2026-06-10', title: 'Arrival', notes: undefined },
  { id: 'd11', stopId: 'a', date: '2026-06-11', title: undefined, notes: undefined },
  { id: 'd12a', stopId: 'a', date: '2026-06-12', title: undefined, notes: undefined },
  { id: 'd12b', stopId: 'b', date: '2026-06-12', title: undefined, notes: undefined },
  { id: 'd13', stopId: 'b', date: '2026-06-13', title: undefined, notes: undefined },
];
const item = (
  id: string,
  dayId: string,
  position: string,
  place?: ReturnType<typeof pt>,
  start: string | null = null,
): JournalItem => ({
  id,
  dayId,
  title: id,
  start,
  position,
  place,
});
const items = [
  item('belem', 'd10', '1', pt('Pastéis de Belém', 38.6975, -9.2033)),
  item('castelo', 'd10', '2', pt('Castelo de São Jorge', 38.7139, -9.1335), '11:00'),
  item('bar', 'd10', '3', pt('Bar do Fundo', 38.713, -9.145), '19:00'),
  item('note', 'd10', '4'),
  item('alfama', 'd11', '1', pt('Alfama', 38.711, -9.13)),
  item('museu', 'd11', '2', pt('Museu do Azulejo', 38.7248, -9.1071)),
  item('rossio', 'd12a', '1', pt('Rossio', 38.714, -9.139)),
  item('palace', 'd12b', '1', pt('Palácio da Pena', 38.7876, -9.3906)),
  item('later', 'd13', '1', pt('Quinta da Regaleira', 38.796, -9.3956)),
];
const members = [
  { accountId: 'ada', name: 'Ada', role: 'organizer', going: true },
  { accountId: 'grace', name: 'Grace', role: 'traveler', going: true },
  { accountId: 'hugo', name: 'Hugo', role: 'organizer', going: false },
  { accountId: 'fay', name: 'Fay', role: 'follower', going: true },
];
const checkin = (
  id: string,
  authorId: string,
  whenIso: string,
  place: ReturnType<typeof pt>,
  photos: string[] = [],
): JournalCheckin => ({
  id,
  authorId,
  place,
  at: at(whenIso),
  tz: ZONE,
  offsetMin: 60,
  photos,
});

const own = [
  // 10:00 local (09:00Z), 50 m or less from the item's point: the same place by name.
  checkin('c1', 'ada', '2026-06-10T09:00:00Z', pt('Pastéis de Belém', 38.6976, -9.2034), ['p1']),
  checkin('c2', 'ada', '2026-06-10T11:00:00Z', pt('Castelo de São Jorge', 38.7139, -9.1335)),
  checkin('c3', 'ada', '2026-06-10T14:00:00Z', pt('Random Café', 38.7, -9.1)),
  checkin('c4', 'ada', '2026-06-11T10:00:00Z', pt('Alfama', 38.711, -9.13)),
];
const shared = [
  checkin('s1', 'grace', '2026-06-10T18:30:00Z', pt('Bar do Fundo', 38.713, -9.145)),
  checkin('s2', 'grace', '2026-06-11T16:00:00Z', pt('Time Out Market', 38.707, -9.145)),
  // Hugo does not go, Fay follows, and nobody knows Zed: none of them counts.
  checkin('s3', 'hugo', '2026-06-11T11:00:00Z', pt('Museu do Azulejo', 38.7248, -9.1071)),
  checkin('s4', 'fay', '2026-06-11T12:00:00Z', pt('Museu do Azulejo', 38.7248, -9.1071)),
  checkin('s5', 'zed', '2026-06-11T13:00:00Z', pt('Museu do Azulejo', 38.7248, -9.1071)),
];
// 21:00 on the 12th in Lisbon: the 12th is today, the 13th has not come.
const NOW = at('2026-06-12T20:00:00Z');
const input: JournalInput = {
  stops,
  days,
  items,
  members,
  own,
  shared,
  now: NOW,
  deviceZone: 'Pacific/Honolulu',
};

const day = (date: string, over: Partial<JournalInput> = {}) =>
  journalOf({ ...input, ...over }).days.find((each) => each.date === date);
const kinds = (entries: NonNullable<ReturnType<typeof day>>['entries']) =>
  entries.map((entry) =>
    entry.kind === 'item' ? `${entry.item.id}:${entry.status}` : `found:${entry.checkin.id}`,
  );

describe('a day of the journal', () => {
  it('has each item done, skipped or planned, and each check-in that matches nothing found on the way, at its own time', () => {
    const d = day('2026-06-10');
    expect(kinds(d?.entries ?? [])).toEqual([
      'belem:done',
      'castelo:done',
      'found:c3',
      'bar:done',
      'note:planned',
    ]);
    expect(d?.counts).toEqual({ planned: 4, done: 3, skipped: 0, found: 1 });
    expect(sentenceOf(d?.counts as never)).toBe('4 planned, 3 done, 1 found on the way');
    expect(d?.title).toBe('Arrival');
    expect(d?.over).toBe(true);
  });

  it('says who checked in, once each, and keeps their photos', () => {
    const d = day('2026-06-10');
    const bar = d?.entries.find((entry) => entry.kind === 'item' && entry.item.id === 'bar');
    expect(bar?.kind === 'item' && bar.by.map((who) => who.name)).toEqual(['Grace']);
    const belem = d?.entries.find((entry) => entry.kind === 'item' && entry.item.id === 'belem');
    expect(belem?.kind === 'item' && belem.checkins.flatMap((c) => c.photos)).toEqual(['p1']);
    const found = d?.entries.find((entry) => entry.kind === 'found');
    expect(found?.kind === 'found' && found.by.name).toBe('Ada');
  });

  it('skips an item with a place that nothing matched once its day has passed, and never judges one with no place', () => {
    const d = day('2026-06-11');
    expect(kinds(d?.entries ?? [])).toEqual(['alfama:done', 'museu:skipped', 'found:s2']);
    expect(d?.counts).toEqual({ planned: 2, done: 1, skipped: 1, found: 1 });
    expect(kinds(day('2026-06-10')?.entries ?? [])).toContain('note:planned');
  });

  it('counts only Travelers and going Organizers: not an Organizer who is not going, a Follower or a stranger', () => {
    // The Museu was checked in at by Hugo, Fay and Zed; none counts, so it is skipped and nothing is found on the way for them.
    const d = day('2026-06-11');
    const found = d?.entries
      .filter((entry) => entry.kind === 'found')
      .map((entry) => entry.kind === 'found' && entry.checkin.id);
    expect(found).toEqual(['s2']);
    // Once Hugo goes, his check-in is the Museu done.
    const going = members.map((member) =>
      member.accountId === 'hugo' ? { ...member, going: true } : member,
    );
    expect(kinds(day('2026-06-11', { members: going })?.entries ?? [])).toEqual([
      'alfama:done',
      'museu:done',
      'found:s2',
    ]);
  });

  it('leaves a day that is not over as planned, and a day to come out', () => {
    const today = day('2026-06-12');
    expect(kinds(today?.entries ?? [])).toEqual(['rossio:planned', 'palace:planned']);
    expect(today?.over).toBe(false);
    expect(day('2026-06-13')).toBeUndefined();
  });

  it('is one day for a date two stops share, with the items of both in the order of the stops', () => {
    const d = day('2026-06-12');
    expect(d?.dayIds).toEqual(['d12a', 'd12b']);
    expect(d?.stops).toEqual(['Lisbon', 'Sintra']);
    // A check-in at the second stop’s place on the shared date is done once, not found twice.
    const there = checkin(
      't1',
      'ada',
      '2026-06-12T09:00:00Z',
      pt('Palácio da Pena', 38.7876, -9.3906),
    );
    const got = day('2026-06-12', { own: [...own, there] });
    expect(kinds(got?.entries ?? [])).toEqual(['rossio:planned', 'palace:done']);
  });

  it('puts a check-in on the day it was by its own clock, and a day is over by the clock of its stop', () => {
    // 23:30 UTC on the 10th is already the 11th in Lisbon.
    const late = checkin('late', 'ada', '2026-06-10T23:30:00Z', pt('Alfama', 38.711, -9.13));
    expect(kinds(day('2026-06-11', { own: [late] })?.entries ?? [])).toContain('alfama:done');
    // At 23:30 UTC on the 12th it is the 13th in Lisbon: the 12th is over, and the 13th is today. The device is in Hawaii, where it is still the 12th.
    const next = at('2026-06-12T23:30:00Z');
    expect(day('2026-06-12', { now: next })?.over).toBe(true);
    expect(day('2026-06-13', { now: next })?.over).toBe(false);
    expect(kinds(day('2026-06-12', { now: next })?.entries ?? [])).toEqual([
      'rossio:skipped',
      'palace:skipped',
    ]);
  });

  it('matches a place by name within 50 metres, and not a nearby place of another name, nor the same name far away', () => {
    const base = (name: string, lat: number, lng: number) =>
      checkin('x', 'ada', '2026-06-11T10:00:00Z', pt(name, lat, lng));
    const run = (c: JournalCheckin) =>
      kinds(day('2026-06-11', { own: [c], shared: [] })?.entries ?? []);
    expect(run(base('alfama', 38.7112, -9.1301))[0]).toBe('alfama:done');
    expect(run(base('Alfama!', 38.711, -9.13))[0]).toBe('alfama:done');
    expect(run(base('Sé de Lisboa', 38.711, -9.13))[0]).toBe('alfama:skipped');
    expect(run(base('Alfama', 38.72, -9.13))[0]).toBe('alfama:skipped');
  });

  it('does not judge an item with no start time when it is told not to', () => {
    const d = day('2026-06-10', { judgeUntimed: false });
    // Belém has no start time: planned, and the check-in at it is found on the way, at its own time. Castelo and the bar are timed.
    expect(kinds(d?.entries ?? [])).toEqual([
      'belem:planned',
      'found:c1',
      'castelo:done',
      'found:c3',
      'bar:done',
      'note:planned',
    ]);
  });
});

describe('the whole journal', () => {
  const journal = journalOf(input);

  it('has the days from the first to today, in date order', () => {
    expect(journal.days.map((each) => each.date)).toEqual([
      '2026-06-10',
      '2026-06-11',
      '2026-06-12',
    ]);
  });

  it('has the figures: distinct places planned and visited, and the check-ins that count', () => {
    // Planned: the two stops and the eight places of the items. Visited: Belém, Castelo, the bar and Alfama.
    expect(journal.figures).toEqual({ planned: 2 + 8, visited: 4, checkins: 6 });
  });

  it('knows which items are done, for Trip Mode', () => {
    expect([...journal.doneItems].sort()).toEqual(['alfama', 'bar', 'belem', 'castelo']);
  });

  it('is the same whatever order the rows come in', () => {
    const shuffled = journalOf({
      ...input,
      items: [...items].reverse(),
      days: [...days].reverse(),
      own: [...own].reverse(),
      shared: [...shared].reverse(),
    });
    expect(shuffled.days.map((d) => kinds(d.entries))).toEqual(
      journal.days.map((d) => kinds(d.entries)),
    );
    expect(shuffled.figures).toEqual(journal.figures);
  });

  it('is empty for a trip that has not begun', () => {
    const before = journalOf({ ...input, now: at('2026-05-01T12:00:00Z') });
    expect(before.days).toEqual([]);
    expect(before.figures.checkins).toBe(6);
  });
});

describe('the sentence', () => {
  it('leaves out what is nothing, and says so for a day with nothing', () => {
    expect(sentenceOf({ planned: 5, done: 3, skipped: 1, found: 2 })).toBe(
      '5 planned, 3 done, 1 skipped, 2 found on the way',
    );
    expect(sentenceOf({ planned: 2, done: 0, skipped: 0, found: 0 })).toBe('2 planned');
    expect(sentenceOf({ planned: 0, done: 0, skipped: 0, found: 1 })).toBe('1 found on the way');
    expect(sentenceOf({ planned: 0, done: 0, skipped: 0, found: 0 })).toBe('Nothing planned');
  });
});
