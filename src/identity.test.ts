import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  IDENTITY_KEY,
  forgetIdentity,
  parseIdentity,
  readIdentity,
  rememberIdentity,
} from './identity';

/** Who is signed in on the device (DESIGN.md §20.12): kept on it, read back exactly, and gone at sign-out. */
const ADA = { id: 'acct-1', name: 'Ada Lovelace', email: 'ada@example.com' };

/** A `localStorage` that is a map, on a `window` that is only that: these tests run in Node, as the rest of the client's tests do. */
function stubStorage(overrides: Partial<Storage> = {}) {
  const kept = new Map<string, string>();
  const storage = {
    getItem: (key: string) => kept.get(key) ?? null,
    setItem: (key: string, value: string) => void kept.set(key, value),
    removeItem: (key: string) => void kept.delete(key),
    ...overrides,
  };
  vi.stubGlobal('window', { localStorage: storage });
  return kept;
}

beforeEach(() => void stubStorage());
afterEach(() => vi.unstubAllGlobals());

describe('the identity kept on the device', () => {
  it('is remembered, read back, and forgotten', () => {
    expect(readIdentity()).toBeNull();
    rememberIdentity(ADA);
    expect(readIdentity()).toEqual(ADA);
    forgetIdentity();
    expect(readIdentity()).toBeNull();
    expect(window.localStorage.getItem(IDENTITY_KEY)).toBeNull();
  });

  it('is replaced by the next person who signs in', () => {
    rememberIdentity(ADA);
    rememberIdentity({ id: 'acct-2', name: 'Grace', email: 'grace@example.com' });
    expect(readIdentity()?.id).toBe('acct-2');
  });

  it('reads nothing from anything that is not exactly an identity', () => {
    for (const bad of [
      null,
      '',
      'not json',
      '[]',
      '"text"',
      '{}',
      JSON.stringify({ id: '', name: 'A', email: 'a@b.c' }),
      JSON.stringify({ id: 'x', name: 1, email: 'a@b.c' }),
      JSON.stringify({ id: 'x', name: 'A' }),
    ])
      expect(parseIdentity(bad), String(bad)).toBeNull();
  });

  it('does not throw where storage is blocked, and finds no one', () => {
    const blocked = () => {
      throw new Error('blocked');
    };
    stubStorage({ getItem: blocked, setItem: blocked, removeItem: blocked });
    expect(() => rememberIdentity(ADA)).not.toThrow();
    expect(() => forgetIdentity()).not.toThrow();
    expect(readIdentity()).toBeNull();
  });
});
