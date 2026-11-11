import { describe, expect, it } from 'vitest';
import { isPosition } from '../position';
import type { ItemRecord, DayRecord } from '../sync/trip-format';
import { parseTripMutation } from '../trips/sync-format';
import { createItem, deleteItem, editDay, editItem, moveItem, positionAmong } from './items';
import type { Context } from './types';

/** What a Traveler does to a trip's items and a day's words: pure functions to mutations, with the rules the server applies again. */
let n = 0;
const ctx = (): Context => ({
  ids: { newId: () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}` },
  now: 0,
  deviceZone: 'Europe/Lisbon',
});
const TRIP = '11111111-1111-4111-8111-111111111111';
const DAY = '22222222-2222-4222-8222-222222222222';
const OTHER_DAY = '33333333-3333-4333-8333-333333333333';
const record = (patch: Partial<ItemRecord> = {}): ItemRecord => ({
  id: '44444444-4444-4444-8444-444444444444',
  dayId: DAY,
  title: 'Dinner',
  notes: undefined,
  kind: 'food',
  start: '20:00',
  end: null,
  fixed: false,
  position: 'a1',
  place: undefined,
  createdBy: 'ada',
  updatedBy: 'ada',
  version: 3,
  seq: 9,
  ...patch,
});

describe('making an item', () => {
  it('is a put in the trip’s stream, at the end or between two neighbours, and what the server parses', () => {
    const among = [
      { id: 'a', position: 'a0' },
      { id: 'b', position: 'a1' },
    ];
    const end = createItem(TRIP, DAY, { title: 'Walk' }, among, null, ctx());
    const between = createItem(TRIP, DAY, { title: 'Walk' }, among, 'b', ctx());
    const start = createItem(TRIP, DAY, { title: 'Walk' }, among, 'a', ctx());
    for (const made of [end, between, start]) {
      if (!made.ok) throw new Error(made.sentence);
      expect(made.mutation.stream).toBe(`trip:${TRIP}`);
      expect(parseTripMutation(made.mutation).ok).toBe(true);
      expect(made.created?.itemId).toBe((made.mutation.changes[0] as { id: string }).id);
    }
    const at = (made: typeof end) =>
      made.ok && made.mutation.changes[0]?.table === 'item' && made.mutation.changes[0].op === 'put'
        ? made.mutation.changes[0].row.position
        : '';
    expect(at(end) > 'a1').toBe(true);
    expect(at(between) > 'a0' && at(between) < 'a1').toBe(true);
    expect(at(start) < 'a0').toBe(true);
    expect([at(end), at(between), at(start)].every(isPosition)).toBe(true);
  });

  it('is refused, in a sentence, for an item with nothing to say, a fixed one with no start, and a neighbour that is not in the day', () => {
    expect(createItem(TRIP, DAY, {}, [], null, ctx())).toMatchObject({ ok: false, reason: 'item' });
    expect(createItem(TRIP, DAY, { title: 'x', fixed: true }, [], null, ctx())).toMatchObject({
      ok: false,
      reason: 'item',
    });
    expect(
      createItem(TRIP, DAY, { title: 'x' }, [{ id: 'a', position: 'a0' }], 'zzz', ctx()),
    ).toMatchObject({ ok: false, reason: 'missing' });
    // A place by id counts as something to say.
    expect(
      createItem(TRIP, DAY, { placeId: '55555555-5555-4555-8555-555555555555' }, [], null, ctx())
        .ok,
    ).toBe(true);
  });

  it('positions among neighbours the same way for everyone', () => {
    expect(positionAmong([], null)).toBe('a0');
    expect(positionAmong([{ id: 'a', position: 'a0' }], 'nope')).toBeUndefined();
  });
});

describe('changing an item', () => {
  it('names the version it was made from, keeps the fields it was not asked to change, and the day and position', () => {
    const edited = editItem(TRIP, record(), { notes: 'book' }, ctx());
    if (!edited.ok) throw new Error(edited.sentence);
    expect(edited.mutation.changes).toEqual([
      {
        table: 'item',
        op: 'put',
        id: record().id,
        baseVersion: 3,
        row: {
          dayId: DAY,
          title: 'Dinner',
          notes: 'book',
          kind: 'food',
          start: '20:00',
          end: null,
          fixed: false,
          placeId: null,
          position: 'a1',
        },
      },
    ]);
  });

  it('checks the whole as it will be: taking the title away from an item with no place is refused', () => {
    expect(editItem(TRIP, record(), { title: '' }, ctx())).toMatchObject({
      ok: false,
      reason: 'item',
    });
    expect(
      editItem(TRIP, record({ fixed: false }), { fixed: true, start: null }, ctx()),
    ).toMatchObject({ ok: false });
  });

  it('can clear a field by saying so', () => {
    const cleared = editItem(TRIP, record({ notes: 'x' }), { notes: undefined }, ctx());
    if (!cleared.ok) throw new Error(cleared.sentence);
    const change = cleared.mutation.changes[0];
    expect(
      change && change.table === 'item' && change.op === 'put' ? 'notes' in change.row : true,
    ).toBe(false);
  });
});

describe('moving, deleting and a day’s words', () => {
  it('moves an item with all its fields to another day, keeping the version it saw', () => {
    const moved = moveItem(TRIP, record({ fixed: true }), OTHER_DAY, [], null, ctx());
    if (!moved.ok) throw new Error(moved.sentence);
    expect(moved.mutation.changes[0]).toMatchObject({
      baseVersion: 3,
      row: { dayId: OTHER_DAY, title: 'Dinner', start: '20:00', fixed: true },
    });
    expect(
      moveItem(TRIP, record(), OTHER_DAY, [{ id: 'a', position: 'a0' }], 'zzz', ctx()),
    ).toMatchObject({ ok: false, reason: 'missing' });
  });

  it('deletes by id, and edits a day’s title and notes, refusing text that is too long', () => {
    const gone = deleteItem(TRIP, record().id, ctx());
    if (!gone.ok) throw new Error(gone.sentence);
    expect(gone.mutation.changes).toEqual([{ table: 'item', op: 'delete', id: record().id }]);
    const day: DayRecord = {
      id: DAY,
      stopId: 's',
      date: '2026-05-10',
      title: undefined,
      notes: undefined,
      version: 2,
    };
    const edited = editDay(TRIP, day, { title: 'Travel day' }, ctx());
    if (!edited.ok) throw new Error(edited.sentence);
    expect(edited.mutation.changes[0]).toEqual({
      table: 'day',
      op: 'put',
      id: DAY,
      baseVersion: 2,
      row: { title: 'Travel day' },
    });
    expect(editDay(TRIP, day, { title: 'x'.repeat(201) }, ctx())).toMatchObject({
      ok: false,
      reason: 'day_text',
    });
    expect(editDay(TRIP, day, { notes: 'x'.repeat(2001) }, ctx())).toMatchObject({ ok: false });
  });
});
