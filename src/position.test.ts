import { describe, expect, it } from 'vitest';
import { after, before, between, comparePositions, first, isPosition, many } from './position';

/** Order is a position (DESIGN.md §10.5): a string that sorts between its neighbours, compared as bytes, and never an error for what a device could send. (Copied from Tusk's; its tests of a database's ordering are in `trips/items.test.ts`.) */
describe('positions', () => {
  it('start with one for an empty list, and go before and after it', () => {
    const a = first();
    expect(isPosition(a)).toBe(true);
    expect(comparePositions(before(a), a)).toBe(-1);
    expect(comparePositions(after(a), a)).toBe(1);
  });

  it('fit between two others, in either order they are given, however many times', () => {
    let low = first();
    const high = after(low);
    for (let i = 0; i < 60; i += 1) {
      const mid = between(low, high);
      expect(comparePositions(low, mid), `step ${i}`).toBe(-1);
      expect(comparePositions(mid, high), `step ${i}`).toBe(-1);
      low = mid;
    }
    expect(between(high, first())).toBe(between(first(), high));
  });

  it('are compared as bytes: digits, then upper case, then lower case, never by language', () => {
    expect(comparePositions('a', 'B')).toBe(1);
    expect(comparePositions('B', 'a')).toBe(-1);
    expect(comparePositions('a1', 'a1')).toBe(0);
    expect(['b', 'A', 'a', '1'].sort(comparePositions)).toEqual(['1', 'A', 'a', 'b']);
  });

  it('make several in order for one gap', () => {
    const keys = many(null, null, 20);
    expect(keys).toHaveLength(20);
    expect([...keys].sort(comparePositions)).toEqual(keys);
    expect(new Set(keys).size).toBe(20);
    const inside = many(keys[3] ?? null, keys[4] ?? null, 5);
    for (const key of inside) {
      expect(comparePositions(keys[3] ?? '', key)).toBe(-1);
      expect(comparePositions(key, keys[4] ?? '')).toBe(-1);
    }
  });

  it('never throw for equal keys or for a key that is not one: it is the edge of the list', () => {
    const a = first();
    expect(between(a, a)).toBe(a);
    for (const bad of ['', ' ', 'a b', 'é', '0', 'zzzzzzzzzzzzzzzzzz!']) {
      expect(() => between(bad, null), bad).not.toThrow();
      expect(() => between(null, bad), bad).not.toThrow();
      expect(() => many(bad, a, 3), bad).not.toThrow();
    }
    expect(isPosition('é')).toBe(false);
    expect(isPosition('')).toBe(false);
  });
});
