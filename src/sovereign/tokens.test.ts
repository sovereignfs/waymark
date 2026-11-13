import { randomBytes } from 'node:crypto';
import { createSovereign } from '@sovereignfs/sdk';
import { createFakeCore } from '@sovereignfs/sdk/testing';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ringOf } from '../crypto/keys';
import { Sealer } from '../crypto/sealed';
import type { Database } from '../db/client';
import { dbAll, dbGet, transaction } from '../db/exec';
import { makeStore, testTarget } from '../db/test-support';
import { coreDirectory } from './directory';
import { LOCK_MS, coreTokenStore, deleteCoreTokenOf, rememberCoreToken } from './tokens';

/**
 * A person's refresh token at a core (DESIGN.md §19.3), on whichever database the leg runs on, against the SDK's own fake core, which rotates a refresh token on every use and takes one used twice for theft: **the store
 * must not lose a rotation, and two callers at once must not both refresh**, or the person is signed out at the core. A token is sealed on disk and in no log.
 */
const { leg } = testTarget();
const made = ringOf(randomBytes(32));
if (!made) throw new Error('no ring');
const sealer = new Sealer(made);
const ADA = 'ada-account';
const GRACE = 'grace-account';
let NOW = 1_800_000_000_000;

let database: Database;
let close: () => Promise<void>;
beforeAll(async () => {
  ({ database, close } = await makeStore());
});
afterAll(async () => close());
const table = () => sql.raw(database.dialect === 'postgres' ? 'waymark.core_token' : 'core_token');
beforeEach(async () => {
  NOW += 10 * 60_000;
  await dbAll(database, sql`DELETE FROM ${table()} RETURNING sub`);
});
const deps = () => ({ database, sealer, now: () => NOW });
const store = () => coreTokenStore(deps());

/** A core with Ada and Grace on it, each signed in (so each has a token, which is kept), and a client of it that uses the store. */
async function world() {
  const core = createFakeCore({ now: () => NOW });
  core.addPerson({ sub: 'sub-ada', name: 'Ada Lovelace' });
  core.addPerson({ sub: 'sub-grace', name: 'Grace Hopper' });
  core.addPerson({ sub: 'sub-alan', name: 'Alan Turing' });
  await rememberCoreToken(deps(), ADA, 'sub-ada', core.signIn('sub-ada'));
  await rememberCoreToken(deps(), GRACE, 'sub-grace', core.signIn('sub-grace'));
  const sovereign = createSovereign({
    appUrl: 'https://waymark.example',
    coreUrl: core.url,
    clientId: core.credentials.clientId,
    clientSecret: core.credentials.clientSecret,
    fetch: core.fetch,
    tokenStore: store(),
  });
  return { core, sovereign };
}

describe(`the token store (${leg})`, () => {
  it('keeps a token sealed, and is read back as it was: the database holds it nowhere in plain text', async () => {
    await rememberCoreToken(deps(), ADA, 'sub-ada', 'rt_PLANTED-WORD-refresh');
    expect(await store().read('sub-ada')).toBe('rt_PLANTED-WORD-refresh');
    expect(await store().read('sub-nobody')).toBeUndefined();
    const row = await dbGet<{ sealed: unknown; token_hash: string }>(
      database,
      sql`SELECT sealed, token_hash FROM ${table()} WHERE sub = 'sub-ada'`,
    );
    const raw = Buffer.from(row?.sealed as Uint8Array).toString('latin1');
    expect(raw).not.toContain('PLANTED-WORD');
    // The hash is of the token and says nothing of it; the token is never in the row but sealed.
    expect(row?.token_hash).not.toContain('PLANTED-WORD');
  });

  it('replaces the token of a person who signs in again, and the new grant ends a lease on the old', async () => {
    await rememberCoreToken(deps(), ADA, 'sub-ada', 'first');
    await rememberCoreToken(deps(), ADA, 'sub-ada', 'second');
    expect(await store().read('sub-ada')).toBe('second');
    expect(
      (await dbAll(database, sql`SELECT sub FROM ${table()} WHERE account_id = ${ADA}`)).length,
    ).toBe(1);
  });

  it('writes a rotation only if the token stored is still the one that was read, and says whether it did', async () => {
    await rememberCoreToken(deps(), ADA, 'sub-ada', 'one');
    expect(await store().write('sub-ada', 'two', 'one')).toBe(true);
    expect(await store().read('sub-ada')).toBe('two');
    // Another process rotated first: this one's stale token stores nothing.
    expect(await store().write('sub-ada', 'three', 'one')).toBe(false);
    expect(await store().read('sub-ada')).toBe('two');
    // There is no first token to write from here: that is a sign-in's, which knows the account.
    expect(await store().write('sub-new', 'x', undefined)).toBe(false);
    expect(await store().read('sub-new')).toBeUndefined();
  });

  it('lets one caller at a time refresh, and the next after it is done; and it never holds a lease past a failure', async () => {
    await rememberCoreToken(deps(), ADA, 'sub-ada', 'one');
    const order: string[] = [];
    const first = store().lock('sub-ada', async () => {
      order.push('a:start');
      await new Promise((resolve) => setTimeout(resolve, 150));
      order.push('a:end');
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = store().lock('sub-ada', async () => {
      order.push('b:start');
    });
    await Promise.all([first, second]);
    expect(order).toEqual(['a:start', 'a:end', 'b:start']);
    // A work that throws still lets go.
    await expect(
      store().lock('sub-ada', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await store().lock('sub-ada', async () => 'ok')).toBe('ok');
    // A person with no token has nothing to wait for.
    expect(await store().lock('sub-nobody', async () => 'ok')).toBe('ok');
  });

  it('takes the lease over once it has run out, so a process that died holding it does not block a person for ever', async () => {
    await rememberCoreToken(deps(), ADA, 'sub-ada', 'one');
    await dbAll(
      database,
      sql`UPDATE ${table()} SET lock_until = ${NOW + LOCK_MS} WHERE sub = 'sub-ada' RETURNING sub`,
    );
    NOW += LOCK_MS + 1;
    expect(await store().lock('sub-ada', async () => 'went on')).toBe('went on');
  });

  it('forgets a person’s token with their account, and no one else’s', async () => {
    await rememberCoreToken(deps(), ADA, 'sub-ada', 'a');
    await rememberCoreToken(deps(), GRACE, 'sub-grace', 'g');
    expect(await transaction(database, (tx) => deleteCoreTokenOf(tx, ADA))).toBe(1);
    expect(await store().read('sub-ada')).toBeUndefined();
    expect(await store().read('sub-grace')).toBe('g');
    // And the SDK's own forgetting, when core says the person deleted their account.
    await store().delete('sub-grace');
    expect(await store().read('sub-grace')).toBeUndefined();
  });
});

describe(`the SDK calling core as a person (${leg})`, () => {
  it('searches the directory as the person, and the rotation of their token is stored each time, so that a day later it still works', async () => {
    const { core, sovereign } = await world();
    const ask = () => sovereign.as({ sub: 'sub-ada' }).directory.searchUsers({ q: 'grace' });
    expect((await ask()).users.map((user) => user.name)).toEqual(['Grace Hopper']);
    // Access tokens run out; the next call refreshes, which rotates the token, which must have been stored.
    core.expireAccessTokens();
    expect((await ask()).users).toHaveLength(1);
    core.expireAccessTokens();
    expect((await ask()).users).toHaveLength(1);
    // The first call refreshed too: the sign-in's token is exchanged for an access token before anything is asked.
    expect(core.seen.refreshes).toBe(3);
    expect(core.seen.reused).toBe(0);
    // The one a stranger holds is another's.
    expect(await store().read('sub-grace')).not.toBe(await store().read('sub-ada'));
  });

  it('is not signed out of core by two calls at once: one refreshes, and the other uses its result', async () => {
    const { core, sovereign } = await world();
    core.expireAccessTokens();
    const results = await Promise.all([
      sovereign.as({ sub: 'sub-ada' }).directory.searchUsers({ q: 'a' }),
      sovereign.as({ sub: 'sub-ada' }).directory.searchUsers({ q: 'a' }),
      sovereign.as({ sub: 'sub-ada' }).directory.searchUsers({ q: 'a' }),
    ]);
    expect(results.every((each) => each.users.length > 0)).toBe(true);
    // A token used twice would be theft to core, and would end the person's tokens.
    expect(core.seen.reused).toBe(0);
    expect(core.seen.refreshes).toBe(1);
  });

  it('is told a person has no session when they have no token, and when core has ended it: nothing is offered, and nothing is said', async () => {
    const { core, sovereign } = await world();
    const directory = coreDirectory({ sovereign, now: () => NOW });
    // Never signed in through the core with offline_access: no token.
    expect(await directory.search('sub-alan', 'ada')).toEqual({ outcome: 'unavailable' });
    // Core ended Ada's tokens (she signed out everywhere).
    core.revoke('sub-ada');
    core.expireAccessTokens();
    expect(await directory.search('sub-ada', 'grace')).toEqual({ outcome: 'unavailable' });
  });
});
