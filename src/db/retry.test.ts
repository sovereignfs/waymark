import { describe, expect, it } from 'vitest';
import { retryUntil } from './retry';

describe('retryUntil', () => {
  it('returns as soon as an attempt succeeds', async () => {
    let calls = 0;
    const result = await retryUntil(
      async () => {
        calls++;
        if (calls < 3) throw new Error('not yet');
        return 'up';
      },
      1000,
      5,
    );
    expect(result).toBe('up');
    expect(calls).toBe(3);
  });

  it('gives up at the deadline, with the last error', async () => {
    let calls = 0;
    await expect(
      retryUntil(
        async () => {
          calls++;
          throw new Error(`attempt ${calls}`);
        },
        40,
        10,
      ),
    ).rejects.toThrow(/attempt \d/);
    expect(calls).toBeGreaterThan(1);
  });
});
