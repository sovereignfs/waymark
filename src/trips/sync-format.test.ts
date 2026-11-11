import { describe, expect, it } from 'vitest';
import { checkDayWrite, checkItemWrite, parseTripMutation, tripOfStream } from './sync-format';

const TRIP = '11111111-1111-4111-8111-111111111111';
const ID = '22222222-2222-4222-8222-222222222222';
const DAY = '33333333-3333-4333-8333-333333333333';
const row = (patch: Record<string, unknown> = {}) => ({
  dayId: DAY,
  title: 'Dinner',
  kind: 'food',
  start: '20:00',
  end: null,
  fixed: false,
  placeId: null,
  position: 'a0',
  ...patch,
});
const mutation = (changes: unknown[], patch: Record<string, unknown> = {}) => ({
  mutationId: ID,
  stream: `trip:${TRIP}`,
  changes,
  ...patch,
});

describe('a mutation into a trip’s stream', () => {
  it('names its trip in the stream, and only a trip’s id will do', () => {
    expect(tripOfStream(`trip:${TRIP}`)).toBe(TRIP);
    for (const bad of [
      'account',
      'trip:',
      'trip:nope',
      `trip:${TRIP}x`,
      5,
      undefined,
      `TRIP:${TRIP}`,
    ])
      expect(tripOfStream(bad)).toBeUndefined();
  });

  it('is an item put or delete, or a day’s put, each with the keys it takes and no others', () => {
    const ok = parseTripMutation(
      mutation([
        { table: 'item', op: 'put', id: ID, baseVersion: 2, row: row() },
        { table: 'item', op: 'delete', id: DAY },
        {
          table: 'day',
          op: 'put',
          id: '44444444-4444-4444-8444-444444444444',
          row: { title: 'Travel' },
        },
      ]),
    );
    expect(ok.ok).toBe(true);
    for (const bad of [
      mutation([]),
      mutation([{ table: 'stop', op: 'delete', id: ID }]),
      mutation([{ table: 'day', op: 'delete', id: ID }]),
      mutation([{ table: 'item', op: 'delete', id: ID, extra: 1 }]),
      mutation([{ table: 'item', op: 'put', id: ID, baseVersion: 0, row: row() }]),
      mutation([{ table: 'item', op: 'put', id: ID, baseVersion: 1.5, row: row() }]),
      mutation([{ table: 'item', op: 'put', id: 'nope', row: row() }]),
      mutation([
        { table: 'item', op: 'put', id: ID, row: row() },
        { table: 'item', op: 'delete', id: ID },
      ]),
      mutation([{ table: 'item', op: 'put', id: ID, row: row() }], { stream: 'account' }),
      mutation([{ table: 'item', op: 'put', id: ID, row: row() }], { extra: true }),
      mutation([{ table: 'item', op: 'put', id: ID, row: row() }], { mutationId: 'x' }),
      mutation(
        Array.from({ length: 51 }, (_, n) => ({
          table: 'item',
          op: 'delete',
          id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
        })),
      ),
    ])
      expect(parseTripMutation(bad).ok, JSON.stringify(bad).slice(0, 90)).toBe(false);
  });
});

describe('an item put', () => {
  it('keeps what an item is, and drops what it is not', () => {
    expect(checkItemWrite(row({ title: '  Dinner  ', notes: '' }))).toEqual({
      ok: true,
      value: {
        dayId: DAY,
        title: 'Dinner',
        kind: 'food',
        start: '20:00',
        end: null,
        fixed: false,
        placeId: null,
        position: 'a0',
      },
    });
  });

  it('is refused for a position that is not one, an id that is not, an extra key, and the rules of an item', () => {
    for (const bad of [
      row({ position: '' }),
      row({ position: 'not a position' }),
      row({ dayId: 'nope' }),
      row({ placeId: 'nope' }),
      row({ extra: 1 }),
      row({ title: '', placeId: null }),
      row({ kind: 'party' }),
      row({ fixed: true, start: null }),
      row({ start: '24:00' }),
      row({ title: 'a\nb' }),
      'text',
      null,
    ])
      expect(checkItemWrite(bad).ok, JSON.stringify(bad)).toBe(false);
    expect(checkItemWrite(row({ title: undefined, placeId: ID })).ok).toBe(true);
  });
});

describe('a day put', () => {
  it('has a title and notes of the limits, or neither', () => {
    expect(checkDayWrite({})).toEqual({ ok: true, value: {} });
    expect(checkDayWrite({ title: ' Travel ', notes: ' long ' })).toEqual({
      ok: true,
      value: { title: 'Travel', notes: 'long' },
    });
    for (const bad of [
      { title: 5 },
      { title: 'a\nb' },
      { title: 'x'.repeat(201) },
      { notes: 'x'.repeat(2001) },
      { other: 1 },
      null,
    ])
      expect(checkDayWrite(bad).ok).toBe(false);
  });
});
