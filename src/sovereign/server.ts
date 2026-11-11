import { authSettings } from '../auth/server';
import { getAuthDatabase, getDatabase } from '../db/boot';
import { RateLimiter } from '../limits/rate';
import { serverMedia } from '../media/server';
import type { Database } from '../db/client';
import type { MediaDeps } from '../media/service';
import type { NoticeDeps, PeopleActions } from './http';
import { accountOfSub, endSessionsOf } from './identity';
import { deletePerson } from './people';
import { sdkVerifiers, seenBy } from './verifiers';

/**
 * What the routes for Sovereign's notices are handed (`http.ts`): the SDK's verifiers for this instance's settings, the people to act on, and the limit on how
 * many requests are taken. Undefined when Sovereign sign-in is not set up, when there is nothing to hear from, and the routes answer 404. Never for a test,
 * which makes its own.
 */
const KEY = Symbol.for('waymark.sovereign-notices');
type Holder = { [KEY]?: Promise<NoticeDeps | undefined> };

export function noticeDeps(): Promise<NoticeDeps | undefined> {
  const store = globalThis as Holder;
  // Made once, so that the limiter's counts are one process's and its sweep of old rows runs.
  store[KEY] ??= make();
  return store[KEY];
}

async function make(): Promise<NoticeDeps | undefined> {
  const sovereign = authSettings()?.sovereign;
  if (!sovereign) return undefined;
  const database = await getDatabase();
  const authDatabase = await getAuthDatabase();
  const limiter = new RateLimiter(database);
  return {
    verify: sdkVerifiers({
      coreUrl: sovereign.issuer,
      clientId: sovereign.clientId,
      seen: seenBy(database),
    }),
    people: peopleFor({ database, authDatabase, media: serverMedia }),
    limiter,
    log: (line) => console.error(line),
  };
}

/**
 * What is done about a person a core names, by their `sub`: the account it is linked to is found in the sign-in store, and **a `sub` nobody here knows is no one** (never signed in, or already deleted: core sends a
 * deletion until it is answered), so ending its sessions ends none and deleting it is done. Deleting runs `People.deletePerson`, which returns only when the rows and the files are gone, and that is
 * what the route answers `200` after. Apart from `make` so that a test runs it on real stores.
 */
export function peopleFor(deps: {
  database: Database;
  authDatabase: Database;
  media: () => Promise<MediaDeps>;
}): PeopleActions {
  const { database, authDatabase } = deps;
  return {
    endSessions: async (sub) => {
      const accountId = await accountOfSub(authDatabase, sub);
      return accountId === null ? 0 : endSessionsOf(authDatabase, accountId);
    },
    deletePerson: async (sub) => {
      const accountId = await accountOfSub(authDatabase, sub);
      if (accountId !== null)
        await deletePerson(
          { database, authDatabase, media: await deps.media(), now: Date.now },
          accountId,
        );
    },
  };
}
