import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { Sealer } from '../crypto/sealed';
import type { Database } from '../db/client';
import { dbAll } from '../db/exec';
import * as postgresSchema from '../db/schema/postgres';
import * as sqliteSchema from '../db/schema/sqlite';
import { BACKOFF_MS, BATCH, LEASE_MS, MAX_AGE_MS, MAX_ATTEMPTS } from '../mail/outbox';
import type { CoreServices, Result } from './services';

/**
 * **The queue of calls to a Sovereign core** (DESIGN.md §17.2, §19.4), the shape of the mail outbox: a call is written **in the transaction of the change that causes it** and made in the background by a job, so a
 * slow or absent core never holds a request, **nothing is held across a call to core**, and a change and its call stand or fall together. A worker claims a row by a lease in the database (so two workers or two
 * processes never make one call), makes it through `CoreServices` (which never throws), and:
 *
 *  - `sent`, or `no_channel` (the person has no sub here, or this core does not serve it): the row is deleted;
 *  - `not_permitted` (the app may not use it) for an email: **falls back to Waymark's own mail** where there is mail, which is what "Core's, or Waymark's if not granted" means, and the row is deleted;
 *  - `retry_after`: tried again after the pause core asked for; `failed`: after the mail outbox's growing pauses, and given up on after six tries or a day.
 *
 * Every call carries a `key`, so a try repeated after an answer that was lost is not a second notification at core. **Nothing is logged but counts**, and the content is sealed while it waits.
 */
export type CoreKind = 'notification' | 'email' | 'activity';

export interface CoreContent {
  readonly title: string;
  readonly body?: string | undefined;
  /** A path of this app, made a whole address when the call is made. */
  readonly path?: string | undefined;
  /** The person's `sub`, when the account is gone and cannot be asked (a line about its deletion). Otherwise found from the account. */
  readonly sub?: string | undefined;
  /** Names the call to core, for the repeat of a try. */
  readonly key: string;
}

export interface CoreOutboxDeps {
  readonly database: Database;
  readonly sealer: Sealer;
  readonly now: () => number;
}

const table = (database: Database) =>
  database.dialect === 'postgres' ? postgresSchema.coreOutbox : sqliteSchema.coreOutbox;

/** Queues a call **in the transaction `tx` of the change that causes it**. `accountId` is the person it is for, or none for a line whose content names the `sub`. */
export async function enqueueCore(
  tx: Database,
  sealer: Sealer,
  now: number,
  call: { accountId?: string | undefined; kind: CoreKind; content: CoreContent },
): Promise<string> {
  const id = randomUUID();
  const sealed = sealer.seal('core_outbox', id, { content: call.content });
  await dbAll(
    tx,
    sql`INSERT INTO ${table(tx)} (id, account_id, kind, attempts, next_attempt_at, claimed_until, sealed, created_at)
        VALUES (${id}, ${call.accountId ?? null}, ${call.kind}, 0, ${now}, 0, ${sealed}, ${now})
        RETURNING id`,
  );
  return id;
}

/** What the job needs of the world apart from the database: core, who a person is there, and what to do when core will not email. */
export interface CoreSender {
  readonly services: CoreServices;
  /** The person's `sub` at the core, or none: they signed in another way. */
  subOf(accountId: string): Promise<string | undefined>;
  /** A path of this app as a whole address. */
  absolute(path: string): string;
  /** Waymark's own mail, for an email core would not send: queues it (or does nothing without mail). */
  fallbackMail?: (accountId: string, content: CoreContent) => Promise<void>;
}

const CLAIMED = sql`id, account_id AS "accountId", kind, attempts, created_at AS "createdAt", sealed`;
interface Claimed {
  id: string;
  accountId: string | null;
  kind: string;
  attempts: number | string;
  createdAt: number | string;
  sealed: ArrayBuffer | Uint8Array;
}

/** Takes up to `limit` calls that are due and not held, in one statement that names the conditions in the subquery and the update (as the mail outbox's does). */
export async function claimCore(deps: CoreOutboxDeps, limit = BATCH): Promise<Claimed[]> {
  const now = deps.now();
  return dbAll<Claimed>(
    deps.database,
    sql`UPDATE ${table(deps.database)}
        SET attempts = attempts + 1, claimed_until = ${now + LEASE_MS}
        WHERE id IN (
          SELECT id FROM ${table(deps.database)}
          WHERE next_attempt_at <= ${now} AND claimed_until <= ${now}
          ORDER BY next_attempt_at, id LIMIT ${limit}
        ) AND next_attempt_at <= ${now} AND claimed_until <= ${now}
        RETURNING ${CLAIMED}`,
  );
}

export interface Pass {
  readonly sent: number;
  readonly retry: number;
  readonly gaveUp: number;
  readonly fellBack: number;
}

/** One pass of the job: claims what is due and makes the calls. Returns what became of them, in counts. */
export async function sendDueCore(deps: CoreOutboxDeps, sender: CoreSender): Promise<Pass> {
  const claimed = await claimCore(deps);
  let sent = 0;
  let retry = 0;
  let gaveUp = 0;
  let fellBack = 0;
  const done = (id: string) =>
    dbAll(deps.database, sql`DELETE FROM ${table(deps.database)} WHERE id = ${id} RETURNING id`);
  for (const row of claimed) {
    const attempts = Number(row.attempts);
    let content: CoreContent;
    try {
      const bytes = row.sealed instanceof Uint8Array ? row.sealed : new Uint8Array(row.sealed);
      const raw = deps.sealer.unseal('core_outbox', row.id, bytes).content as Partial<CoreContent>;
      if (typeof raw.title !== 'string' || typeof raw.key !== 'string')
        throw new Error('not a call');
      content = {
        title: raw.title,
        ...(typeof raw.body === 'string' ? { body: raw.body } : {}),
        ...(typeof raw.path === 'string' ? { path: raw.path } : {}),
        ...(typeof raw.sub === 'string' ? { sub: raw.sub } : {}),
        key: raw.key,
      };
    } catch {
      await done(row.id);
      gaveUp += 1;
      continue;
    }
    const sub = content.sub ?? (row.accountId ? await sender.subOf(row.accountId) : undefined);
    const url = sender.absolute(content.path ?? '/');
    let result: Result = { outcome: 'no_channel' };
    if (sub) {
      result =
        row.kind === 'notification'
          ? await sender.services.notify({
              sub,
              title: content.title,
              ...(content.body ? { body: content.body } : {}),
              url,
              key: content.key,
            })
          : row.kind === 'email'
            ? await sender.services.email({
                sub,
                subject: content.title,
                body: [content.body, url].filter(Boolean).join('\n\n'),
                link: url,
                key: content.key,
              })
            : await sender.services.activity({
                sub,
                summary: content.title,
                link: url,
                key: content.key,
              });
    }
    if (result.outcome === 'sent') {
      await done(row.id);
      sent += 1;
    } else if (result.outcome === 'no_channel' || result.outcome === 'not_permitted') {
      // Core would not (or there is no core account to ask): an email goes by Waymark's own mail where there is any; the rest is not made.
      if (row.kind === 'email' && row.accountId && sender.fallbackMail) {
        await sender.fallbackMail(row.accountId, content);
        fellBack += 1;
      }
      await done(row.id);
    } else if (attempts >= MAX_ATTEMPTS || deps.now() - Number(row.createdAt) > MAX_AGE_MS) {
      await done(row.id);
      gaveUp += 1;
    } else {
      const pause =
        result.outcome === 'retry_after' && result.retryAfterSeconds !== undefined
          ? Math.min(Math.max(result.retryAfterSeconds, 1), 3600) * 1000
          : (BACKOFF_MS[Math.min(attempts - 1, BACKOFF_MS.length - 1)] ?? BACKOFF_MS[0]);
      await dbAll(
        deps.database,
        sql`UPDATE ${table(deps.database)} SET next_attempt_at = ${deps.now() + pause}, claimed_until = 0
            WHERE id = ${row.id} RETURNING id`,
      );
      retry += 1;
    }
  }
  return { sent, retry, gaveUp, fellBack };
}

/** Removes calls too old to be of use even if nothing claimed them. */
export async function dropStaleCore(
  deps: Pick<CoreOutboxDeps, 'database' | 'now'>,
): Promise<number> {
  const rows = await dbAll<{ id: string }>(
    deps.database,
    sql`DELETE FROM ${table(deps.database)} WHERE created_at < ${deps.now() - MAX_AGE_MS} AND claimed_until <= ${deps.now()} RETURNING id`,
  );
  return rows.length;
}

/** Deletes the calls queued for a person (`People.deletePerson`, in its transaction). Returns how many. A line about the deletion itself names the `sub` and no account, so it stays to be made. */
export async function deleteCoreOf(database: Database, accountId: string): Promise<number> {
  const rows = await dbAll<{ id: string }>(
    database,
    sql`DELETE FROM ${table(database)} WHERE account_id = ${accountId} RETURNING id`,
  );
  return rows.length;
}
