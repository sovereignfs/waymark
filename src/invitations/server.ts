import { sql } from 'drizzle-orm';
import { getConfig } from '../config/current';
import { serverSealer } from '../crypto/server';
import { getAuthDatabase, getDatabase } from '../db/boot';
import { RateLimiter } from '../limits/rate';
import { accountOfSub, subOfAccount } from '../sovereign/identity';
import { serverDirectory } from '../sovereign/server-core';
import type { InviteDirectory } from './service';
import { noticeDelivery } from '../notices/server';
import type { InviteHttpDeps } from './http';
import { dbGet } from '../db/exec';
import * as postgresSchema from '../db/schema/postgres';
import * as sqliteSchema from '../db/schema/sqlite';

/**
 * The account with an email address, from the sign-in store, where addresses are kept plain (a profile's is sealed and cannot be asked). **For an invitation only**: the answer is never given to the person asking, who is told only that the
 * invitation was sent; and it is asked at a limited rate (`LOOKUP_RATE`). An address is matched to an account here and nowhere else (never at sign-in).
 */
export async function accountByEmail(email: string): Promise<string | undefined> {
  const database = await getAuthDatabase();
  const user = database.dialect === 'postgres' ? postgresSchema.user : sqliteSchema.user;
  const found = await dbGet<{ id: string }>(
    database,
    sql`SELECT id FROM ${user} WHERE LOWER(email) = ${email.toLowerCase()}`,
  );
  return found?.id;
}

/**
 * Core's directory for the Organizer inviting, where there is a core (DESIGN.md §11.2): the person asking is found by their account's `sub`, and **an account that did not sign in through a core has none to ask as**, so
 * the directory is simply not there for them (`unavailable`). `accountOfSub` is the account here that signed in with a `sub`, if any.
 */
export function serverInviteDirectory(): InviteDirectory | undefined {
  const directory = serverDirectory();
  if (!directory) return undefined;
  const asker = async (accountId: string) =>
    (await subOfAccount(await getAuthDatabase(), accountId)) ?? undefined;
  return {
    search: async (accountId, query) => {
      const sub = await asker(accountId);
      return sub ? directory.search(sub, query) : { outcome: 'unavailable' };
    },
    resolve: async (accountId, sub) => {
      const me = await asker(accountId);
      return me ? directory.resolve(me, sub) : { outcome: 'unavailable' };
    },
    accountOfSub: async (sub) => (await accountOfSub(await getAuthDatabase(), sub)) ?? undefined,
  };
}

/** What invitations need as the server runs them. */
export async function serverInvite(): Promise<InviteHttpDeps> {
  const database = await getDatabase();
  return {
    database,
    sealer: serverSealer(),
    now: Date.now,
    limits: getConfig().limits,
    delivery: noticeDelivery,
    limiter: new RateLimiter(database),
    url: getConfig().url,
    accountByEmail,
    coreDirectory: serverInviteDirectory(),
  };
}
