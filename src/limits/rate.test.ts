import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '../db/client';
import { makeStore, testTarget } from '../db/test-support';
import { KEEP_MS, RateLimiter } from './rate';

const { leg } = testTarget();
const RULE = { limit: 3, windowMs: 10_000 };

let database: Database;
let close: () => Promise<void>;
beforeAll(async () => {
  ({ database, close } = await makeStore());
});
afterAll(async () => close());

let keys = 0;
const key = () => `test:${++keys}`;

describe(`the rate limiter (${leg})`, () => {
  it('lets a holder do the limit within a window and refuses the next, saying how long to wait', async () => {
    let now = 1_000_000;
    const limiter = new RateLimiter(database, () => now);
    const k = key();
    for (let i = 0; i < 3; i++) expect(await limiter.take(k, RULE)).toEqual({ ok: true });
    now += 4000;
    expect(await limiter.take(k, RULE)).toEqual({ ok: false, retryAfterMs: 6000 });
  });

  it('starts a new window when the old one is over', async () => {
    let now = 1_000_000;
    const limiter = new RateLimiter(database, () => now);
    const k = key();
    for (let i = 0; i < 4; i++) await limiter.take(k, RULE);
    now += RULE.windowMs;
    expect(await limiter.take(k, RULE)).toEqual({ ok: true });
  });

  it('counts a refused try, so that asking again at once does not get nearer', async () => {
    const limiter = new RateLimiter(database, () => 5_000_000);
    const k = key();
    for (let i = 0; i < 3; i++) await limiter.take(k, RULE);
    for (let i = 0; i < 5; i++) expect((await limiter.take(k, RULE)).ok).toBe(false);
  });

  it('keeps holders apart', async () => {
    const limiter = new RateLimiter(database, () => 7_000_000);
    const a = key();
    const b = key();
    for (let i = 0; i < 4; i++) await limiter.take(a, RULE);
    expect(await limiter.take(b, RULE)).toEqual({ ok: true });
  });

  it('lets through no more than the limit when many ask at once', async () => {
    const limiter = new RateLimiter(database, () => 9_000_000);
    const k = key();
    const taken = await Promise.all(Array.from({ length: 12 }, () => limiter.take(k, RULE)));
    expect(taken.filter((t) => t.ok)).toHaveLength(3);
  });

  it('forgets a window that is long over', async () => {
    let now = 20_000_000;
    const limiter = new RateLimiter(database, () => now);
    const old = key();
    await limiter.take(old, RULE);
    now += KEEP_MS + 1;
    const fresh = key();
    await limiter.take(fresh, RULE);
    await limiter.sweep();
    // The old key starts from nothing again, as does one never seen: its row is gone, not just its count.
    for (let i = 0; i < 3; i++) expect(await limiter.take(old, RULE)).toEqual({ ok: true });
  });
});
