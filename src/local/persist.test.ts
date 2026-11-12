import { describe, expect, it, vi } from 'vitest';
import { requestPersistence } from './persist';

/** Persistent storage is asked for, once, and a browser that says no or has none is not an error (DESIGN.md §15.7). */
describe('asking for persistent storage', () => {
  it('asks the browser, and says what it answered', async () => {
    const persist = vi.fn().mockResolvedValue(true);
    expect(await requestPersistence({ persist, persisted: async () => false })).toBe(true);
    expect(persist).toHaveBeenCalledTimes(1);
  });

  it('does not ask again when it is already granted', async () => {
    const persist = vi.fn().mockResolvedValue(true);
    expect(await requestPersistence({ persist, persisted: async () => true })).toBe(true);
    expect(persist).not.toHaveBeenCalled();
  });

  it('takes a refusal as an answer', async () => {
    expect(
      await requestPersistence({ persist: async () => false, persisted: async () => false }),
    ).toBe(false);
  });

  it('is not an error where there is no storage manager, or it throws', async () => {
    expect(await requestPersistence(undefined)).toBeUndefined();
    expect(
      await requestPersistence({
        persist: async () => {
          throw new Error('blocked');
        },
        persisted: async () => false,
      }),
    ).toBeUndefined();
  });
});
