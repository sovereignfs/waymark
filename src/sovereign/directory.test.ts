import { createSovereign } from '@sovereignfs/sdk';
import { createFakeCore } from '@sovereignfs/sdk/testing';
import { describe, expect, it } from 'vitest';
import { DIRECTORY_LIMIT, DIRECTORY_REST_MS, coreDirectory } from './directory';

/**
 * Core's directory (DESIGN.md §11.2, §19.4) against the SDK's fake core: people found as the person asking, **and every way it can be unavailable is an answer and not an error** (an instance with an older core, the scope
 * refused, a session that has ended, core down), so that inviting works as it does alone. Nothing in a log but the service and what became of it.
 */
let NOW = 1_800_000_000_000;

/** A core with people on it, Ada signed in with a refresh token kept in memory, and the directory over a client of it. */
function world(options: Parameters<typeof createFakeCore>[0] = {}) {
  const core = createFakeCore({ now: () => NOW, ...options });
  for (const [sub, name] of [
    ['sub-ada', 'Ada Lovelace'],
    ['sub-grace', 'Grace Hopper'],
    ['sub-alan', 'Alan Turing'],
    ['sub-ann', 'Ada\u0007 Annette\nQuine'],
  ] as const)
    core.addPerson({ sub, name });
  core.addPerson({ sub: 'sub-gone', name: 'Ada Gone', active: false });
  const tokens = new Map([['sub-ada', core.signIn('sub-ada')]]);
  const log: string[] = [];
  const sovereign = createSovereign({
    appUrl: 'https://waymark.example',
    coreUrl: core.url,
    clientId: core.credentials.clientId,
    clientSecret: core.credentials.clientSecret,
    fetch: core.fetch,
    tokenStore: {
      read: (sub) => tokens.get(sub),
      write: (sub, next, previous) => {
        if (tokens.get(sub) !== previous) return false;
        tokens.set(sub, next);
        return true;
      },
    },
  });
  return {
    core,
    log,
    directory: coreDirectory({ sovereign, now: () => NOW, log: (l) => log.push(l) }),
  };
}

describe('searching the directory', () => {
  it('finds people by name as the person asking, never the person themselves, with a name that is one line of text', async () => {
    const { directory } = world();
    const found = await directory.search('sub-ada', 'ada');
    expect(found).toEqual({
      outcome: 'found',
      people: [{ sub: 'sub-ann', name: 'Ada Annette Quine' }],
    });
    expect(await directory.search('sub-ada', 'hopper')).toEqual({
      outcome: 'found',
      people: [{ sub: 'sub-grace', name: 'Grace Hopper' }],
    });
    // Nobody by that name is an answer, not a failure.
    expect(await directory.search('sub-ada', 'zzz')).toEqual({ outcome: 'found', people: [] });
  });

  it('asks nothing for an empty search or one that is too long, and offers at most a handful', async () => {
    const { core, directory } = world();
    for (let n = 0; n < 20; n += 1) core.addPerson({ sub: `sub-x${n}`, name: `Xavier ${n}` });
    const before = core.seen.requests.length;
    expect(await directory.search('sub-ada', '   ')).toEqual({ outcome: 'found', people: [] });
    expect(await directory.search('sub-ada', 'x'.repeat(101))).toEqual({
      outcome: 'found',
      people: [],
    });
    expect(core.seen.requests.length).toBe(before);
    const found = await directory.search('sub-ada', 'xavier');
    expect(found.outcome === 'found' && found.people.length).toBe(DIRECTORY_LIMIT);
  });

  it('offers no one, and says nothing, for a person who has no session at core or whose session has ended', async () => {
    const { core, directory, log } = world();
    expect(await directory.search('sub-grace', 'ada')).toEqual({ outcome: 'unavailable' });
    core.revoke('sub-ada');
    core.expireAccessTokens();
    expect(await directory.search('sub-ada', 'grace')).toEqual({ outcome: 'unavailable' });
    expect(log).toEqual([]);
  });

  it('offers no one from a core that does not serve the directory, or that has not granted the scope, and rests: it is not asked again for six hours, and the log says it once', async () => {
    const { core, directory, log } = world();
    core.fail({ kind: 'status', status: 403 }, { target: 'api' });
    expect(await directory.search('sub-ada', 'grace')).toEqual({ outcome: 'unavailable' });
    core.heal();
    const asked = core.seen.requests.length;
    expect(await directory.search('sub-ada', 'grace')).toEqual({ outcome: 'unavailable' });
    expect(core.seen.requests.length).toBe(asked);
    expect(log).toHaveLength(1);
    expect(log[0]).not.toMatch(/grace|sub-/i);
    NOW += DIRECTORY_REST_MS + 1;
    expect((await directory.search('sub-ada', 'grace')).outcome).toBe('found');
  });

  it('is told "not now" when core is down, and goes on at once when it is back: that is a failure, not a refusal', async () => {
    const { core, directory, log } = world();
    core.fail({ kind: 'down' });
    expect(await directory.search('sub-ada', 'grace')).toEqual({ outcome: 'failed' });
    core.heal();
    expect((await directory.search('sub-ada', 'grace')).outcome).toBe('found');
    expect(log).toEqual([]);
  });

  it('is unavailable from a core that does not list the directory among what it serves', async () => {
    const { directory } = world({
      api: { versions: ['v1'], capabilities: ['notifications'] },
    });
    expect(await directory.search('sub-ada', 'grace')).toEqual({ outcome: 'unavailable' });
  });
});

describe('looking one person up', () => {
  it('finds a person by their sub, with the name core gives, and says when there is no one or they are not active', async () => {
    const { directory } = world();
    expect(await directory.resolve('sub-ada', 'sub-grace')).toEqual({
      outcome: 'found',
      person: { sub: 'sub-grace', name: 'Grace Hopper' },
    });
    expect(await directory.resolve('sub-ada', 'sub-nobody')).toEqual({ outcome: 'gone' });
    expect(await directory.resolve('sub-ada', 'sub-gone')).toEqual({ outcome: 'gone' });
  });

  it('is unavailable or failed as a search is', async () => {
    const { core, directory } = world();
    expect(await directory.resolve('sub-grace', 'sub-alan')).toEqual({ outcome: 'unavailable' });
    core.fail({ kind: 'down' });
    expect(await directory.resolve('sub-ada', 'sub-alan')).toEqual({ outcome: 'failed' });
  });
});
