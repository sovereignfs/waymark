import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { KeyRing } from '../crypto/keys';
import type { Database } from '../db/client';
import { dbAll, dbGet, dbRun } from '../db/exec';
import * as postgresSchema from '../db/schema/postgres';
import * as sqliteSchema from '../db/schema/sqlite';
import { allowed, detect, MIME, type MediaKind } from './detect';
import {
  isFileId,
  listFiles,
  readSealed,
  removeByName,
  removeFile,
  thumbIdOf,
  writeSealed,
} from './files';
import { ImageError, reencode } from './images';

/**
 * The media store (DESIGN.md §9.3, §10.6, §18.3): photos, attachments and uploaded imports, judged by their bytes, re-encoded when they are images, sealed on disk, and counted
 * against the owner's limit. **Everything here is for an account's own files** (3.2); a trip's files arrive with attachments (9.5) and sharing (10.3), whose access check is passed
 * in where a file is read. A row holds nothing sensitive (`SEALED` has no `media`): the files are sealed by `files.ts` under the key ring.
 */
export interface MediaDeps {
  readonly database: Database;
  readonly ring: KeyRing;
  /** `<data>/media`. */
  readonly dir: string;
  /** The most one account may keep, in bytes. */
  readonly maxAccountBytes: number;
  readonly now: () => number;
}

/** The largest file that is accepted at all (DESIGN.md §18.3). */
export const MAX_FILE_BYTES = 15 * 1024 * 1024;

export type Refusal =
  | 'bad_id'
  | 'too_big'
  | 'not_allowed'
  | 'unreadable'
  | 'unsupported'
  | 'image_too_large'
  | 'over_limit'
  | 'id_taken';

/** What a person is told, in a sentence that says what to do (`DESIGN.md` §18.3: "said in a sentence when reached"). */
export const SENTENCES: Readonly<Record<Refusal, string>> = {
  bad_id: 'That is not a valid id for a file.',
  too_big: 'That file is larger than 15 MB.',
  not_allowed: 'That kind of file cannot be added here.',
  unreadable: 'That file could not be read. Try another.',
  unsupported: 'That kind of image cannot be read here. Share it as a JPEG (or PNG) and try again.',
  image_too_large: 'That image is too large to be handled.',
  over_limit:
    'You have reached the limit for your files. Delete some, or ask whoever runs this server for more room.',
  id_taken: 'That is not found.',
};

export type PutResult =
  | { ok: true; id: string; thumbId: string | undefined; bytes: number; existing: boolean }
  | { ok: false; reason: Refusal };

const table = (database: Database) =>
  database.dialect === 'postgres' ? postgresSchema.media : sqliteSchema.media;

interface Row {
  id: string;
  accountId: string | null;
  kind: string;
  type: string;
  bytes: number | string;
  state: string;
  createdAt: number | string;
}

const COLUMNS = sql`id, account_id AS "accountId", kind, type, bytes, state, created_at AS "createdAt"`;

/** What an account stores, in bytes: the sum of its files that are written (`ready`) and of those being written (`pending`), the thumbnails included. */
export async function usageOf(database: Database, accountId: string): Promise<number> {
  const row = await dbGet<{ n: number | string | null }>(
    database,
    sql`SELECT COALESCE(SUM(bytes), 0) AS n FROM ${table(database)} WHERE account_id = ${accountId}`,
  );
  return Number(row?.n ?? 0);
}

async function rowOf(database: Database, id: string): Promise<Row | undefined> {
  return dbGet<Row>(database, sql`SELECT ${COLUMNS} FROM ${table(database)} WHERE id = ${id}`);
}

async function claimRow(
  deps: MediaDeps,
  id: string,
  accountId: string,
  kind: MediaKind,
  type: string,
  bytes: number,
): Promise<boolean> {
  const rows = await dbAll<{ id: string }>(
    deps.database,
    sql`INSERT INTO ${table(deps.database)} (id, account_id, kind, type, bytes, state, created_at)
        VALUES (${id}, ${accountId}, ${kind}, ${type}, ${bytes}, 'pending', ${deps.now()})
        ON CONFLICT (id) DO NOTHING
        RETURNING id`,
  );
  return rows.length > 0;
}

const markReady = (deps: MediaDeps, id: string, accountId: string) =>
  dbRun(
    deps.database,
    sql`UPDATE ${table(deps.database)} SET state = 'ready' WHERE id = ${id} AND account_id = ${accountId}`,
  );

/**
 * Stores a file for an account. `id` is the device's own for a photo taken offline (6.5) and is checked: a replay of the same upload with the same id and the same owner stores
 * nothing twice and answers as the first did; an id that belongs to someone else's row is refused as not found. Without one the server makes it.
 */
export async function putMedia(
  deps: MediaDeps,
  input: { accountId: string; kind: Exclude<MediaKind, 'thumb'>; bytes: Uint8Array; id?: string },
): Promise<PutResult> {
  const id = input.id ?? randomUUID();
  if (!isFileId(id)) return { ok: false, reason: 'bad_id' };
  if (input.bytes.length === 0) return { ok: false, reason: 'unreadable' };
  if (input.bytes.length > MAX_FILE_BYTES) return { ok: false, reason: 'too_big' };

  const found = detect(input.bytes);
  if (!allowed(input.kind, found)) return { ok: false, reason: 'not_allowed' };

  // A replay: the same id for the same owner is the same upload.
  const existing = await rowOf(deps.database, id);
  if (existing && existing.accountId !== input.accountId) return { ok: false, reason: 'id_taken' };
  if (existing?.state === 'ready') {
    const thumb =
      existing.kind === 'photo' || existing.kind === 'attachment' ? thumbIdOf(id) : undefined;
    const thumbRow = thumb ? await rowOf(deps.database, thumb) : undefined;
    return {
      ok: true,
      id,
      thumbId: thumbRow ? thumb : undefined,
      bytes: Number(existing.bytes),
      existing: true,
    };
  }

  // What is stored: an image is re-encoded (and gets a thumbnail), a PDF or a ZIP is kept as it is.
  let main: Buffer | Uint8Array = input.bytes;
  let thumb: Buffer | undefined;
  let type: string = MIME[found];
  if (found !== 'pdf' && found !== 'zip') {
    try {
      const done = await reencode(input.bytes);
      main = done.photo;
      thumb = done.thumb;
      type = 'image/webp';
    } catch (error) {
      if (error instanceof ImageError)
        return {
          ok: false,
          reason:
            error.reason === 'unsupported'
              ? 'unsupported'
              : error.reason === 'too_large'
                ? 'image_too_large'
                : 'unreadable',
        };
      throw error;
    }
  }

  const stored = main.length + (thumb?.length ?? 0);
  // A row already counts (a retry of one that was pending), so only what is new is added.
  const already = existing ? Number(existing.bytes) : 0;
  if ((await usageOf(deps.database, input.accountId)) - already + stored > deps.maxAccountBytes)
    return { ok: false, reason: 'over_limit' };

  const thumbId = thumb ? thumbIdOf(id) : undefined;
  if (!existing) await claimRow(deps, id, input.accountId, input.kind, type, main.length);
  if (thumbId && thumb) {
    const row = await rowOf(deps.database, thumbId);
    if (row && row.accountId !== input.accountId) return { ok: false, reason: 'id_taken' };
    if (!row) await claimRow(deps, thumbId, input.accountId, 'thumb', 'image/webp', thumb.length);
  }
  await writeSealed(deps.dir, id, main, deps.ring);
  if (thumbId && thumb) {
    await writeSealed(deps.dir, thumbId, thumb, deps.ring);
    await markReady(deps, thumbId, input.accountId);
  }
  await markReady(deps, id, input.accountId);
  return { ok: true, id, thumbId, bytes: stored, existing: false };
}

/** What a file is and its bytes, for an account that may read it: the statement names the account, so another's file is not found. */
export async function readMedia(
  deps: MediaDeps,
  input: { accountId: string; id: string },
): Promise<{ type: string; bytes: Buffer } | undefined> {
  if (!isFileId(input.id)) return undefined;
  const row = await dbGet<Row>(
    deps.database,
    sql`SELECT ${COLUMNS} FROM ${table(deps.database)}
        WHERE id = ${input.id} AND account_id = ${input.accountId} AND state = 'ready'`,
  );
  if (!row) return undefined;
  const bytes = await readSealed(deps.dir, row.id, deps.ring);
  return bytes ? { type: row.type, bytes } : undefined;
}

/** Deletes a file (and a photo's thumbnail with it): the row, named by owner and id, and then the file. Returns whether there was one. */
export async function deleteMedia(
  deps: MediaDeps,
  input: { accountId: string; id: string },
): Promise<boolean> {
  if (!isFileId(input.id)) return false;
  let any = false;
  for (const id of [input.id, thumbIdOf(input.id)]) {
    const rows = await dbAll<{ id: string }>(
      deps.database,
      sql`DELETE FROM ${table(deps.database)} WHERE id = ${id} AND account_id = ${input.accountId} RETURNING id`,
    );
    if (rows.length > 0) {
      any = true;
      await removeFile(deps.dir, id);
    }
  }
  return any;
}

/** How long a row may stay `pending`, and a file with no row may sit, before the sweep takes it: long enough that an upload in flight is never cut off. */
export const ORPHAN_GRACE_MS = 60 * 60 * 1000;

export interface SweepResult {
  rows: number;
  files: number;
}

/**
 * Finds what a crash left: rows that were made and whose file never came (`pending` for longer than the grace), and files with no row that are older than the grace. Both are
 * removed. A file is never removed for being unreferenced by a check-in or an item here: that reference arrives with the photos (5.3) and attachments (9.5), which add their own
 * to this sweep. Safe to run from any process at any time: it removes only what is already of no use.
 */
export async function sweepOrphans(deps: MediaDeps): Promise<SweepResult> {
  const cutoff = deps.now() - ORPHAN_GRACE_MS;
  const result: SweepResult = { rows: 0, files: 0 };
  const stale = await dbAll<{ id: string }>(
    deps.database,
    sql`DELETE FROM ${table(deps.database)} WHERE state = 'pending' AND created_at < ${cutoff} RETURNING id`,
  );
  for (const row of stale) {
    await removeFile(deps.dir, row.id);
    result.rows++;
  }
  for (const file of await listFiles(deps.dir)) {
    if (file.modifiedAt >= cutoff) continue;
    // A name that is an id with a row is a file in use; a temporary name, or an id with no row, is an orphan.
    if (isFileId(file.name) && (await rowOf(deps.database, file.name))) continue;
    await removeByName(deps.dir, file.name);
    result.files++;
  }
  return result;
}
