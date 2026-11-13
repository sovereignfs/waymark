import {
  CoreApiError,
  CoreUnavailableError,
  NotSupportedError,
  type Sovereign,
  SessionEndedError,
} from '@sovereignfs/sdk';

/**
 * **Core's directory** (DESIGN.md §11.2, §19.4): finding the people of a Sovereign instance to invite to a trip, **as the person asking** (`sv.as({ sub })`, with the refresh token their sign-in through core gave, which
 * `src/sovereign/tokens.ts` keeps). It is an addition, like core's bell: **nothing here throws**, and a directory that cannot be used (an instance with no core, a person who did not sign in through one, an older core,
 * the scope refused, a session at core that has ended) simply offers no one, and inviting works as it does without it. The answer is one of three words:
 *
 *  - `found`        the people the directory named (possibly none).
 *  - `unavailable`  nothing to offer, and nothing to say: no token for this person, a session that has ended, a core that does not serve it or has not granted the scope.
 *  - `failed`       core was down, timed out, or asked to be tried later.
 *
 * A core that does not serve the directory, or has not granted this app the scope, **is logged once and then rested for six hours**, like core's other services; nothing is logged but that, never a name searched for, a
 * `sub` or a token. What a person typed is the directory's to search and is sent to nobody else.
 */
export interface DirectoryPerson {
  readonly sub: string;
  readonly name: string;
}

export type Found =
  | { readonly outcome: 'found'; readonly people: readonly DirectoryPerson[] }
  | { readonly outcome: 'unavailable' }
  | { readonly outcome: 'failed' };

export type Resolved =
  | { readonly outcome: 'found'; readonly person: DirectoryPerson }
  /** Core knows no one by that `sub`, or they are not active there any more. */
  | { readonly outcome: 'gone' }
  | { readonly outcome: 'unavailable' }
  | { readonly outcome: 'failed' };

export interface CoreDirectory {
  /** People whose names match `query`, asked as the person `asker` (their `sub`). */
  search(asker: string, query: string): Promise<Found>;
  /** One person by their `sub`, asked as `asker`: what an invitation checks before it is made, so that a `sub` from a browser is never taken on its word. */
  resolve(asker: string, sub: string): Promise<Resolved>;
}

export const DIRECTORY_REST_MS = 6 * 60 * 60 * 1000;
/** The most people one search offers. */
export const DIRECTORY_LIMIT = 8;
const NAME_MAX = 100;

/** A name as it is shown: one line, no control characters, cut to a length. It is rendered as text, never as markup. */
const clean = (name: string): string =>
  [...name]
    .map((character) => {
      const code = character.charCodeAt(0);
      return code < 0x20 || code === 0x7f ? ' ' : character;
    })
    .join('')
    .split(/\s+/)
    .filter((word) => word !== '')
    .join(' ')
    .slice(0, NAME_MAX);

export function coreDirectory(deps: {
  sovereign: Pick<Sovereign, 'as'>;
  now(): number;
  log?: (line: string) => void;
}): CoreDirectory {
  let restUntil = 0;
  const rest = (why: string) => {
    if (deps.now() >= restUntil) deps.log?.(`core directory: ${why}; resting`);
    restUntil = deps.now() + DIRECTORY_REST_MS;
  };
  /** What became of a call that threw: the same for a search and for a lookup. */
  function outcomeOf(error: unknown): 'unavailable' | 'failed' {
    // A person with no refresh token, or whose session at core has ended: nothing to do but sign in again, which is theirs to decide.
    if (error instanceof SessionEndedError) return 'unavailable';
    if (error instanceof NotSupportedError) {
      rest('this core does not serve it');
      return 'unavailable';
    }
    if (error instanceof CoreApiError && error.status === 403) {
      rest('this app may not use it');
      return 'unavailable';
    }
    if (error instanceof CoreApiError || error instanceof CoreUnavailableError) return 'failed';
    return 'failed';
  }

  return {
    async search(asker, query) {
      if (deps.now() < restUntil) return { outcome: 'unavailable' };
      const q = query.trim();
      if (q === '' || q.length > 100) return { outcome: 'found', people: [] };
      try {
        const { users } = await deps.sovereign
          .as({ sub: asker })
          .directory.searchUsers({ q, limit: DIRECTORY_LIMIT });
        return {
          outcome: 'found',
          people: users
            // Not the person themselves, and nobody without a name to show.
            .filter((user) => user.sub !== asker && clean(user.name) !== '')
            .slice(0, DIRECTORY_LIMIT)
            .map((user) => ({ sub: user.sub, name: clean(user.name) })),
        };
      } catch (error) {
        return { outcome: outcomeOf(error) };
      }
    },

    async resolve(asker, sub) {
      if (deps.now() < restUntil) return { outcome: 'unavailable' };
      try {
        const { users } = await deps.sovereign
          .as({ sub: asker })
          .directory.resolveUsers({ subs: [sub] });
        const user = users.find((each) => each.sub === sub);
        if (!user || user.active === false || clean(user.name) === '') return { outcome: 'gone' };
        return { outcome: 'found', person: { sub: user.sub, name: clean(user.name) } };
      } catch (error) {
        return { outcome: outcomeOf(error) };
      }
    },
  };
}
