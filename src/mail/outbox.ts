import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { Sealer } from '../crypto/sealed';
import type { Database } from '../db/client';
import { dbAll } from '../db/exec';
import * as postgresSchema from '../db/schema/postgres';
import * as sqliteSchema from '../db/schema/sqlite';
import type { Mailer, Message } from './mailer';

/**
 * **The mail outbox** (DESIGN.md §17.2), the shape of Tally's: mail is written to `mail_outbox` in the transaction of the change that causes it, and **sent in the background by a job**, so a slow or absent
 * mail server never holds a request, and a change and its mail stand or fall together. The address and the message are sealed (`SEALED.mail_outbox`); the job claims a row by a lease in the database
 * (`claimMail`), so **two workers, or two processes, never send one message**. A message that does not go is tried again after a pause that grows (`BACKOFF_MS`), and **given up on after `MAX_ATTEMPTS` tries or
 * `MAX_AGE_MS`**, whichever is first: a verification or reset link a day old is of no use, and one sent late is worse than none. A row is deleted when it is sent and when it is given up on, so
 * nothing of a message outlives its use.
 *
 * **Nothing here logs an address, a subject or a text, nor the error a mail server gave** (which can repeat the address): a pass says only how many it sent, kept for later and gave up on.
 * A crash between sending and deleting sends the message once more when the lease ends: delivery is at least once, and a message is a link or a notice that can be read twice.
 */
export const MAX_ATTEMPTS = 6;
/** The pause before the next try after the nth failure (the first try is at once). */
export const BACKOFF_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 3_600_000, 6 * 3_600_000] as const;
/** How long a worker holds a message it is sending: longer than a send can take (the SMTP adapter's own timeouts are 10 to 20 seconds). */
export const LEASE_MS = 2 * 60_000;
export const MAX_AGE_MS = 24 * 3_600_000;
export const BATCH = 10;

export type MailKind = 'verification' | 'reset' | 'notice';

export interface OutboxDeps {
  readonly database: Database;
  readonly sealer: Sealer;
  readonly now: () => number;
}

const table = (database: Database) =>
  database.dialect === 'postgres' ? postgresSchema.mailOutbox : sqliteSchema.mailOutbox;

export interface Enqueue {
  /** The person it is for, when they have an account: deleting the person removes what is queued for them. */
  readonly accountId?: string | undefined;
  readonly kind: MailKind;
  readonly message: Message;
}

/** Queues a message **in the transaction `tx` of the change that causes it**. Returns the row's id. */
export async function enqueueMail(
  tx: Database,
  sealer: Sealer,
  now: number,
  mail: Enqueue,
): Promise<string> {
  const id = randomUUID();
  const sealed = sealer.seal('mail_outbox', id, {
    address: mail.message.to,
    content: {
      subject: mail.message.subject,
      text: mail.message.text,
      ...(mail.message.html ? { html: mail.message.html } : {}),
    },
  });
  await dbAll(
    tx,
    sql`INSERT INTO ${table(tx)} (id, account_id, kind, attempts, next_attempt_at, claimed_until, sealed, created_at)
        VALUES (${id}, ${mail.accountId ?? null}, ${mail.kind}, 0, ${now}, 0, ${sealed}, ${now})
        RETURNING id`,
  );
  return id;
}

/** A `Mailer` that queues instead of sending: what the sign-in library is given, so its verification and reset mail go through the outbox (the library's own call does not wait for it, §6). */
export function outboxMailer(deps: OutboxDeps): Mailer {
  return {
    async send(message) {
      await enqueueMail(deps.database, deps.sealer, deps.now(), {
        kind: message.kind ?? 'notice',
        message,
      });
    },
  };
}

/** What a claim hands back: the columns of the row, in a fragment of their own (the sealed envelope is read, never a condition). */
const CLAIMED = sql`id, attempts, created_at AS "createdAt", sealed`;

interface Claimed {
  id: string;
  attempts: number | string;
  createdAt: number | string;
  sealed: ArrayBuffer | Uint8Array;
}

/**
 * Takes up to `limit` messages that are due and not held, in **one statement** that names the conditions both in the subquery that picks and in the update that takes, so that two workers that pick the
 * same rows at once take each row only once (the loser's update finds the row held, on PostgreSQL after waiting for the winner's, and takes nothing). Counts the try, and holds the row for `LEASE_MS`.
 */
export async function claimMail(deps: OutboxDeps, limit = BATCH): Promise<Claimed[]> {
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
}

/** Whether a failure is the last: out of tries, or too old to be of use. */
const lastTry = (attempts: number, createdAt: number, now: number): boolean =>
  attempts >= MAX_ATTEMPTS || now - createdAt > MAX_AGE_MS;

/**
 * One pass of the job: claims what is due and sends it with `mailer`, deleting what went, putting back what did not (after its pause) and giving up on what is out of tries or too old. A
 * row that cannot be opened (written by another key) is given up on, since no try would open it.
 */
export async function sendDue(deps: OutboxDeps, mailer: Mailer): Promise<Pass> {
  const claimed = await claimMail(deps);
  let sent = 0;
  let retry = 0;
  let gaveUp = 0;
  const done = (id: string) =>
    dbAll(deps.database, sql`DELETE FROM ${table(deps.database)} WHERE id = ${id} RETURNING id`);
  for (const row of claimed) {
    const attempts = Number(row.attempts);
    const createdAt = Number(row.createdAt);
    let message: Message;
    try {
      const bytes = row.sealed instanceof Uint8Array ? row.sealed : new Uint8Array(row.sealed);
      const fields = deps.sealer.unseal('mail_outbox', row.id, bytes);
      const content = fields.content as { subject?: unknown; text?: unknown; html?: unknown };
      if (typeof content.subject !== 'string' || typeof content.text !== 'string')
        throw new Error('not a message');
      message = {
        to: fields.address,
        subject: content.subject,
        text: content.text,
        ...(typeof content.html === 'string' ? { html: content.html } : {}),
      };
    } catch {
      await done(row.id);
      gaveUp += 1;
      continue;
    }
    try {
      await mailer.send(message);
      await done(row.id);
      sent += 1;
    } catch {
      // The reason is not kept or told: a mail server's answer can repeat the address.
      if (lastTry(attempts, createdAt, deps.now())) {
        await done(row.id);
        gaveUp += 1;
      } else {
        const pause = BACKOFF_MS[Math.min(attempts - 1, BACKOFF_MS.length - 1)] ?? BACKOFF_MS[0];
        await dbAll(
          deps.database,
          sql`UPDATE ${table(deps.database)} SET next_attempt_at = ${deps.now() + pause}, claimed_until = 0
              WHERE id = ${row.id} RETURNING id`,
        );
        retry += 1;
      }
    }
  }
  return { sent, retry, gaveUp };
}

/** Removes mail that is too old to be of use even if nothing claimed it (a worker that was off). Returns how many. */
export async function dropStale(deps: Pick<OutboxDeps, 'database' | 'now'>): Promise<number> {
  const rows = await dbAll<{ id: string }>(
    deps.database,
    sql`DELETE FROM ${table(deps.database)} WHERE created_at < ${deps.now() - MAX_AGE_MS} AND claimed_until <= ${deps.now()} RETURNING id`,
  );
  return rows.length;
}

/** Deletes the mail queued to a person (`People.deletePerson`, in its transaction). Returns how many. */
export async function deleteMailOf(database: Database, accountId: string): Promise<number> {
  const rows = await dbAll<{ id: string }>(
    database,
    sql`DELETE FROM ${table(database)} WHERE account_id = ${accountId} RETURNING id`,
  );
  return rows.length;
}
