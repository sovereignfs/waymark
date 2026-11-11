import { generateKeyBetween, generateNKeysBetween } from 'fractional-indexing';

/**
 * Order is a **position** (DESIGN.md §11.3): a string that sorts between its neighbours, so that moving a task writes one row, and two devices
 * that move different tasks never touch the same one. This wraps `fractional-indexing` (CC0), whose keys are base 62 digits written so that they
 * sort right as plain strings: digits, then upper case, then lower case, which is byte order, and is why PostgreSQL needs `COLLATE "C"` on the
 * column (§22.2). **In JavaScript they are compared by bytes and never with `localeCompare`**, which orders "a" and "B" by language and not by code.
 *
 * Pure: no clock, no database, nothing global.
 *
 * What the wrapper adds to the library is that it does not throw for what a device could send: two devices can make equal keys (they both put a task
 * between the same two), and a key that came from another device is not ours to trust. A tie is broken by id where rows are sorted (`rows.ts`), so
 * every device shows one order; a position nobody can parse is treated as no position at all (the edge of the list), and is replaced when the row next
 * moves.
 */

/** The position of the only row in an empty list. */
export function first(): string {
  return generateKeyBetween(null, null);
}

/** A position before `a`: the top of a list whose first row is at `a`. */
export function before(a: string): string {
  return between(null, a);
}

/** A position after `a`: the bottom of a list whose last row is at `a`. */
export function after(a: string): string {
  return between(a, null);
}

/**
 * A position between `a` and `b`. `null` is the edge of the list: `between(null, b)` is above `b` and `between(a, null)` below `a`. The two may be
 * given in either order. **It never throws for equal keys** (two devices that put a row at the same place get a key equal to both, and the tie is
 * broken by id) **or for a key that is not valid**, which is treated as no key: the edge of the list.
 */
export function between(a: string | null, b: string | null): string {
  const low = a !== null && isPosition(a) ? a : null;
  const high = b !== null && isPosition(b) ? b : null;
  if (low !== null && high !== null && low === high) return low;
  return generateKeyBetween(low, high);
}

/** `count` positions, in order, between `a` and `b`: for putting several rows into one gap, such as a paste or an import. */
export function many(a: string | null, b: string | null, count: number): string[] {
  const low = a !== null && isPosition(a) ? a : null;
  const high = b !== null && isPosition(b) ? b : null;
  if (low !== null && high !== null && low === high)
    return Array.from({ length: count }, () => low);
  // The library wants them in order; the caller may not have them so.
  const [from, to] = low !== null && high !== null && low > high ? [high, low] : [low, high];
  return generateNKeysBetween(from, to, count);
}

/**
 * Whether `key` is one the library can place keys around: base 62 digits only (the library tolerates other characters, and a database would sort
 * them by their bytes while no device agreed what they meant) and a key it accepts. A device could send any string; this says which are positions.
 */
export function isPosition(key: string): boolean {
  if (!/^[0-9A-Za-z]+$/.test(key)) return false;
  try {
    generateKeyBetween(key, null);
    return true;
  } catch {
    return false;
  }
}

/** Compares two positions as bytes: `-1`, `0` or `1`. The order a database gives with `COLLATE "C"`, and the only order there is. */
export function comparePositions(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
