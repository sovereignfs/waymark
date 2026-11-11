import { verifyAccountDeletedToken, verifyLogoutToken } from '@sovereignfs/sdk';
import { sql } from 'drizzle-orm';
import type { Database } from '../db/client';
import { dbAll } from '../db/exec';
import * as postgresSchema from '../db/schema/postgres';
import * as sqliteSchema from '../db/schema/sqlite';
import type { NoticeVerifiers } from './http';

/**
 * Sovereign's notices are checked by `@sovereignfs/sdk` (its `verifyLogoutToken` and `verifyAccountDeletedToken`), which holds the rules of
 * its sign-in contract so that no app writes them a second time: type, signature against core's keys, issuer, audience, age, event, `jti`,
 * no `nonce`. This is the one file that imports it, so that everything else is tested with stand-ins and this is tested against the SDK's
 * own fake core (`verifiers.test.ts`).
 */
export interface VerifierOptions {
  /** Sovereign's address, which is its issuer (`WAYMARK_CORE_URL`). */
  coreUrl: string;
  /** This app's client at Sovereign (`WAYMARK_CORE_CLIENT_ID`), which a notice names as its audience. */
  clientId: string;
  seen: (jti: string, expiresAt: number) => Promise<boolean>;
  /** How to reach Sovereign, for a test; by default the platform's `fetch`. */
  fetch?: typeof fetch;
}

export function sdkVerifiers(options: VerifierOptions): NoticeVerifiers {
  return {
    logout: (token) => verifyLogoutToken(token, options),
    accountDeleted: (token) => verifyAccountDeletedToken(token, options),
  };
}

/**
 * Whether a notice was seen before (the SDK's `seen`): its `jti` is recorded in `notice_seen` in one statement that does nothing if it is there already, so **the first to ask is told no and every later one,
 * from any process and after any restart, is told yes**. It is kept until the notice could no longer be accepted (the SDK refuses an old one by its age whatever this says) and a little over, and then
 * swept (`forgetSeen`). The SDK asks this last, of a notice that has met every other rule, so nothing a forger sends is recorded.
 */
export function seenBy(database: Database): (jti: string, expiresAt: number) => Promise<boolean> {
  return async (jti, expiresAt) => {
    const recorded = await dbAll<{ jti: string }>(
      database,
      sql`INSERT INTO ${seenTable(database)} (jti, expires_at) VALUES (${jti}, ${expiresAt})
          ON CONFLICT (jti) DO NOTHING RETURNING jti`,
    );
    return recorded.length === 0;
  };
}

/** How long after a notice could no longer be accepted its `jti` is kept: for a clock that is a little behind. */
export const SEEN_GRACE_MS = 5 * 60 * 1000;

/** Forgets the `jti` of notices that can no longer be replayed. Safe to run twice and from two processes. Returns how many. */
export async function forgetSeen(database: Database, now: number): Promise<number> {
  const gone = await dbAll<{ jti: string }>(
    database,
    sql`DELETE FROM ${seenTable(database)} WHERE expires_at < ${now - SEEN_GRACE_MS} RETURNING jti`,
  );
  return gone.length;
}

const seenTable = (database: Database) =>
  database.dialect === 'postgres' ? postgresSchema.noticeSeen : sqliteSchema.noticeSeen;
