import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { Sealer } from '../crypto/sealed';
import type { Database } from '../db/client';
import { dbAll } from '../db/exec';
import * as postgresSchema from '../db/schema/postgres';
import * as sqliteSchema from '../db/schema/sqlite';

/**
 * **Notices** (DESIGN.md §17): what a person is told, in the app, by the bell and `/notifications`. A notice is **raised in the transaction of the change that caused it** (`raiseNotice`, given
 * that transaction), so it exists if and only if the change does, and **never for the person who made the change**: the actor is passed in, and a notice to them is not made. The kind is plain (the database
 * counts and filters by it); **what it says is sealed** (`SEALED.notice`) and is only ever Waymark's own words with a place or a name that the person told is allowed to see, never an email
 * address (§6.1). Kept 90 days and at most 500 a person (`pruneNotices`, a job). Every statement names the person (`WHERE account_id = ?`), so another person's notice is not found.
 *
 * Phase 1 has one kind, `import_finished`; the kinds of phases 2 and 3 are added by the tasks that raise them, here and in `KINDS`, with the sentence the person reads.
 */
export const KINDS = ['import_finished'] as const;
export type NoticeKind = (typeof KINDS)[number];

/** What a notice says. `href` is a path of this app (the notice opens there), or absent. */
export interface NoticeContent {
  readonly title: string;
  readonly detail?: string | undefined;
  readonly href?: string | undefined;
}

export const TITLE_MAX = 200;
export const DETAIL_MAX = 500;
/** How long a notice is kept, and how many a person keeps (DESIGN.md §17.1). */
export const KEEP_DAYS = 90;
export const KEEP_MAX = 500;
/** How many the bell and the page ask for at once. */
export const PAGE = 100;

export interface Notice {
  readonly id: string;
  readonly kind: NoticeKind;
  /** When it was raised, in milliseconds since the epoch. */
  readonly at: number;
  readonly read: boolean;
  readonly tripId: string | undefined;
  readonly title: string;
  readonly detail: string | undefined;
  readonly href: string | undefined;
}

export interface NoticeDeps {
  readonly database: Database;
  readonly sealer: Sealer;
  readonly now: () => number;
}

const table = (database: Database) =>
  database.dialect === 'postgres' ? postgresSchema.notice : sqliteSchema.notice;

/** A path of this app and nothing else: a whole address, another host's, or a protocol-relative one is not somewhere a notice may send a person. */
export const isAppPath = (href: string): boolean => href.startsWith('/') && !href.startsWith('//');

const oneLine = (text: string, max: number): string =>
  text.replace(/\s+/g, ' ').trim().slice(0, max);

/** The content as it is sealed: trimmed, cut to length, and with an `href` that is not a path of this app left out. */
export function cleanContent(content: NoticeContent): NoticeContent {
  const title = oneLine(content.title, TITLE_MAX);
  const detail = content.detail ? oneLine(content.detail, DETAIL_MAX) : undefined;
  return {
    title: title === '' ? 'Waymark' : title,
    ...(detail ? { detail } : {}),
    ...(content.href && isAppPath(content.href) ? { href: content.href } : {}),
  };
}

export interface Raise {
  /** The person to tell. */
  readonly to: string;
  /** The person whose change this is: they are never told of it. */
  readonly by: string;
  readonly kind: NoticeKind;
  readonly content: NoticeContent;
  readonly tripId?: string | undefined;
}

/**
 * Raises a notice **in the transaction `tx` the change is made in**, for `raise.to`, and returns its id, or `undefined` when there is none to make: the person told is the person who acted. A
 * notice is made once for one change by whoever calls this once for it; nothing here retries.
 */
export async function raiseNotice(
  tx: Database,
  sealer: Sealer,
  now: number,
  raise: Raise,
): Promise<string | undefined> {
  if (raise.to === raise.by) return undefined;
  const id = randomUUID();
  const content = cleanContent(raise.content);
  const sealed = sealer.seal('notice', id, { content });
  await dbAll(
    tx,
    sql`INSERT INTO ${table(tx)} (id, account_id, kind, trip_id, read_at, sealed, created_at)
        VALUES (${id}, ${raise.to}, ${raise.kind}, ${raise.tripId ?? null}, NULL, ${sealed}, ${now})
        RETURNING id`,
  );
  return id;
}

interface Row {
  id: string;
  kind: string;
  tripId: string | null;
  readAt: number | string | null;
  sealed: ArrayBuffer | Uint8Array;
  createdAt: number | string;
}

const isKind = (kind: string): kind is NoticeKind => (KINDS as readonly string[]).includes(kind);

function noticeOf(sealer: Sealer, row: Row): Notice | undefined {
  // A kind this version does not know (written by a later one) is not shown rather than shown wrongly.
  if (!isKind(row.kind)) return undefined;
  const bytes = row.sealed instanceof Uint8Array ? row.sealed : new Uint8Array(row.sealed);
  const raw = sealer.unseal('notice', row.id, bytes).content as Partial<NoticeContent>;
  const content = cleanContent({
    title: typeof raw.title === 'string' ? raw.title : '',
    detail: typeof raw.detail === 'string' ? raw.detail : undefined,
    href: typeof raw.href === 'string' ? raw.href : undefined,
  });
  return {
    id: row.id,
    kind: row.kind,
    at: Number(row.createdAt),
    read: row.readAt !== null,
    tripId: row.tripId ?? undefined,
    title: content.title,
    detail: content.detail,
    href: content.href,
  };
}

/** A person's notices, newest first, at most `limit`. */
export async function listNotices(
  deps: Pick<NoticeDeps, 'database' | 'sealer'>,
  accountId: string,
  limit = PAGE,
): Promise<Notice[]> {
  const rows = await dbAll<Row>(
    deps.database,
    sql`SELECT id, kind, trip_id AS "tripId", read_at AS "readAt", sealed, created_at AS "createdAt"
        FROM ${table(deps.database)} WHERE account_id = ${accountId}
        ORDER BY created_at DESC, id DESC LIMIT ${Math.max(1, Math.min(limit, 500))}`,
  );
  return rows.flatMap((row) => noticeOf(deps.sealer, row) ?? []);
}

/** How many of a person's notices are unread: counted by the database, whatever the list holds. */
export async function unreadCount(
  deps: Pick<NoticeDeps, 'database'>,
  accountId: string,
): Promise<number> {
  const rows = await dbAll<{ n: number | string }>(
    deps.database,
    sql`SELECT COUNT(*) AS n FROM ${table(deps.database)} WHERE account_id = ${accountId} AND read_at IS NULL`,
  );
  return Number(rows[0]?.n ?? 0);
}

/** Marks some of a person's notices read, once: one already read keeps the time it was read. Another person's is not there. Returns how many were marked. */
export async function markRead(
  deps: Pick<NoticeDeps, 'database' | 'now'>,
  accountId: string,
  ids: readonly string[],
): Promise<number> {
  if (ids.length === 0) return 0;
  const rows = await dbAll<{ id: string }>(
    deps.database,
    sql`UPDATE ${table(deps.database)} SET read_at = ${deps.now()}
        WHERE account_id = ${accountId} AND read_at IS NULL AND id IN (${sql.join(
          ids.map((id) => sql`${id}`),
          sql`, `,
        )})
        RETURNING id`,
  );
  return rows.length;
}

/** Marks all of a person's notices read. Returns how many were marked. */
export async function markAllRead(
  deps: Pick<NoticeDeps, 'database' | 'now'>,
  accountId: string,
): Promise<number> {
  const rows = await dbAll<{ id: string }>(
    deps.database,
    sql`UPDATE ${table(deps.database)} SET read_at = ${deps.now()}
        WHERE account_id = ${accountId} AND read_at IS NULL RETURNING id`,
  );
  return rows.length;
}

/**
 * Removes what is past its keeping (DESIGN.md §17.1): notices older than 90 days, and, for a person with more than 500, all but the newest 500. Safe to run twice and from two processes: each
 * statement names what it deletes and removing a row that is gone changes nothing.
 */
export async function pruneNotices(
  deps: Pick<NoticeDeps, 'database' | 'now'>,
): Promise<{ old: number; over: number }> {
  const old = await dbAll<{ id: string }>(
    deps.database,
    sql`DELETE FROM ${table(deps.database)} WHERE created_at < ${deps.now() - KEEP_DAYS * 86_400_000} RETURNING id`,
  );
  const over = await dbAll<{ id: string }>(
    deps.database,
    sql`DELETE FROM ${table(deps.database)} WHERE id IN (
          SELECT id FROM (
            SELECT id, ROW_NUMBER() OVER (PARTITION BY account_id ORDER BY created_at DESC, id DESC) AS place
            FROM ${table(deps.database)}
          ) AS ranked WHERE place > ${KEEP_MAX}
        ) RETURNING id`,
  );
  return { old: old.length, over: over.length };
}

/** Deletes every notice of a person (`People.deletePerson`, in its transaction). Returns how many. */
export async function deleteNoticesOf(database: Database, accountId: string): Promise<number> {
  const rows = await dbAll<{ id: string }>(
    database,
    sql`DELETE FROM ${table(database)} WHERE account_id = ${accountId} RETURNING id`,
  );
  return rows.length;
}
