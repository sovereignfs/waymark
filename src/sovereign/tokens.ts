import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { tableOf } from '../access/trip';
import type { Sealer } from '../crypto/sealed';
import type { Database } from '../db/client';
import { dbAll, dbGet } from '../db/exec';

/**
 * **A person's refresh token at a Sovereign core** (DESIGN.md §19.3), kept so that the app can call core's directory as them (`sv.as({ sub })`): the SDK's `TokenStore` over the app's store.
 *
 * **How it gets here.** Signing in through core with the `offline_access` scope makes better-auth's `genericOAuth` store the refresh token on the sign-in store's `account` row, encrypted with the sign-in secret. That
 * copy is **moved, not kept** (`rememberCoreToken`, called when a sign-in through core ends, `src/auth/auth.ts`): it is sealed here, with the instance's key (`SEALED.core_token`, so key rotation reaches it and it is read
 * only through `src/crypto/`), and the `account` row's copy is cleared. A credential is then in one place, and it goes with the person (`People.deletePerson`).
 *
 * **How it is used.** Core rotates a refresh token on every use and takes one used twice for theft, which ends the person's tokens at core. So `write` is a conditional update (it stores the new token only if the stored
 * one is still the one the SDK read: compared by its hash, since a token is never in a `WHERE`), and `lock` is a lease in the row, so that two processes never refresh at once. Nothing here is ever logged or put in an
 * error: not a token, not a hash.
 */
export interface TokenDeps {
  readonly database: Database;
  readonly sealer: Sealer;
  readonly now: () => number;
}

/** The SDK's `TokenStore`, which the package does not export as a type by this name. */
export interface CoreTokenStore {
  read(sub: string): Promise<string | undefined>;
  write(sub: string, next: string, previous: string | undefined): Promise<boolean>;
  lock<T>(sub: string, work: () => Promise<T>): Promise<T>;
  delete(sub: string): Promise<void>;
}

/** A lease is held for at most this long: a refresh that has not finished by then has failed, and another process may go on. */
export const LOCK_MS = 30_000;
/** How long a caller waits for another's refresh before giving up (the call fails and says so; nothing is changed). */
export const LOCK_WAIT_MS = 10_000;
const LOCK_POLL_MS = 40;

const hashOf = (token: string): string => createHash('sha256').update(token, 'utf8').digest('hex');
const bytes = (value: Uint8Array | ArrayBuffer): Uint8Array =>
  value instanceof Uint8Array ? value : new Uint8Array(value);
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Keeps the token a sign-in through core just gave, for the account: a new grant from core, so it replaces whatever there was (and ends any lease). */
export async function rememberCoreToken(
  deps: TokenDeps,
  accountId: string,
  sub: string,
  token: string,
): Promise<void> {
  const table = tableOf(deps.database, 'core_token');
  const now = deps.now();
  const sealed = deps.sealer.seal('core_token', sub, { token });
  const first = await dbAll<{ sub: string }>(
    deps.database,
    sql`INSERT INTO ${table} (sub, account_id, token_hash, lock_until, sealed, updated_at)
        VALUES (${sub}, ${accountId}, ${hashOf(token)}, 0, ${sealed}, ${now})
        ON CONFLICT (sub) DO NOTHING
        RETURNING sub`,
  );
  if (first.length === 1) return;
  // There was one: a new sign-in is a new grant from core, which is the token now (and ends any lease on the old).
  await dbAll(
    deps.database,
    sql`UPDATE ${table} SET account_id = ${accountId}, token_hash = ${hashOf(token)}, lock_until = 0, sealed = ${sealed}, updated_at = ${now}
        WHERE sub = ${sub}
        RETURNING sub`,
  );
}

/** Forgets the account's token, in the transaction `tx` that removes the account. */
export async function deleteCoreTokenOf(tx: Database, accountId: string): Promise<number> {
  const gone = await dbAll<{ sub: string }>(
    tx,
    sql`DELETE FROM ${tableOf(tx, 'core_token')} WHERE account_id = ${accountId} RETURNING sub`,
  );
  return gone.length;
}

/** The SDK's token store for the people who have signed in through core. */
export function coreTokenStore(deps: TokenDeps): CoreTokenStore {
  const table = () => tableOf(deps.database, 'core_token');
  return {
    async read(sub) {
      const row = await dbGet<{ sealed: Uint8Array | ArrayBuffer }>(
        deps.database,
        sql`SELECT sealed FROM ${table()} WHERE sub = ${sub}`,
      );
      return row ? deps.sealer.unseal('core_token', sub, bytes(row.sealed)).token : undefined;
    },

    async write(sub, next, previous) {
      // A first token only ever comes from a sign-in (`rememberCoreToken`), which knows the account; the SDK has none to give here.
      if (previous === undefined) return false;
      const sealed = deps.sealer.seal('core_token', sub, { token: next });
      const stored = await dbAll<{ sub: string }>(
        deps.database,
        sql`UPDATE ${table()} SET token_hash = ${hashOf(next)}, sealed = ${sealed}, updated_at = ${deps.now()}
            WHERE sub = ${sub} AND token_hash = ${hashOf(previous)}
            RETURNING sub`,
      );
      return stored.length === 1;
    },

    async lock(sub, work) {
      const give = deps.now() + LOCK_MS;
      const deadline = deps.now() + LOCK_WAIT_MS;
      for (;;) {
        const claimed = await dbAll<{ sub: string }>(
          deps.database,
          sql`UPDATE ${table()} SET lock_until = ${give} WHERE sub = ${sub} AND lock_until <= ${deps.now()} RETURNING sub`,
        );
        if (claimed.length === 1) break;
        // No row is no token to refresh: the SDK finds that out by itself, and says the session is over.
        const there = await dbGet<{ sub: string }>(
          deps.database,
          sql`SELECT sub FROM ${table()} WHERE sub = ${sub}`,
        );
        if (!there) return work();
        if (deps.now() >= deadline) throw new Error('core token busy');
        await sleep(LOCK_POLL_MS);
      }
      try {
        return await work();
      } finally {
        // Only our own lease is let go: a lease another process took after ours ran out is not ours to end.
        await dbAll(
          deps.database,
          sql`UPDATE ${table()} SET lock_until = 0 WHERE sub = ${sub} AND lock_until = ${give} RETURNING sub`,
        ).catch(() => undefined);
      }
    },

    async delete(sub) {
      await dbAll(deps.database, sql`DELETE FROM ${table()} WHERE sub = ${sub} RETURNING sub`);
    },
  };
}
