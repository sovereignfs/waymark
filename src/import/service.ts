import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import type { Database } from '../db/client';
import { dbAll } from '../db/exec';
import * as postgresSchema from '../db/schema/postgres';
import * as sqliteSchema from '../db/schema/sqlite';
import { IMPORT_MAX_BYTES, listImports, removeImport, writeImport } from './files';
import { ACTIVE, type ImportDeps, type ImportSource, type ImportStatus } from './job';

/**
 * What a person does with an import (DESIGN.md §16): upload one, see them, cancel one. Every statement names the account, so another person's import is not found. The file is sealed on disk as it arrives
 * and the job reads it; nothing here reads a service's format.
 */
const table = (database: Database) =>
  database.dialect === 'postgres' ? postgresSchema.importJob : sqliteSchema.importJob;

export type Created =
  | { ok: true; id: string; bytes: number }
  | { ok: false; reason: 'unavailable' | 'busy' | 'too_big' | 'empty' };

export const SENTENCES: Readonly<Record<Exclude<Created, { ok: true }>['reason'], string>> = {
  unavailable: 'Importing from that service is not available on this server yet.',
  busy: 'An import is already running. Wait for it to finish, or cancel it, and then upload another.',
  too_big: 'That file is larger than 200 MB.',
  empty: 'That file is empty.',
};

/**
 * Takes an uploaded file (as it arrives, a chunk at a time, never whole in memory) and queues an import of it. **One at a time for a person**: a second upload while one is queued or running is refused with a
 * sentence that says what to do. A source with no reader on this server is refused before anything is stored.
 */
export async function createImport(
  deps: ImportDeps,
  input: {
    accountId: string;
    source: ImportSource;
    body: AsyncIterable<Uint8Array>;
    maxBytes?: number;
  },
): Promise<Created> {
  if (!deps.readers[input.source]) return { ok: false, reason: 'unavailable' };
  if ((await activeCount(deps.database, input.accountId)) > 0) return { ok: false, reason: 'busy' };
  const id = randomUUID();
  const written = await writeImport(
    deps.dir,
    id,
    input.body,
    deps.ring,
    input.maxBytes ?? IMPORT_MAX_BYTES,
  );
  if (!written.ok) return { ok: false, reason: written.reason };
  const now = deps.now();
  await dbAll(
    deps.database,
    sql`INSERT INTO ${table(deps.database)} (id, account_id, source, status, phase, cursor, file_bytes, created_at, updated_at)
        VALUES (${id}, ${input.accountId}, ${input.source}, 'queued', 'checkins', 0, ${written.bytes}, ${now}, ${now})
        RETURNING id`,
  );
  return { ok: true, id, bytes: written.bytes };
}

async function activeCount(database: Database, accountId: string): Promise<number> {
  const rows = await dbAll<{ n: number | string }>(
    database,
    sql`SELECT COUNT(*) AS n FROM ${table(database)} WHERE account_id = ${accountId} AND status IN ('queued', 'running')`,
  );
  return Number(rows[0]?.n ?? 0);
}

export interface ImportView {
  readonly id: string;
  readonly source: ImportSource;
  readonly status: ImportStatus;
  readonly createdAt: number;
  readonly finishedAt: number | undefined;
  readonly fileBytes: number;
  readonly checkinsDone: number;
  readonly checkinsSkipped: number;
  readonly placesMade: number;
  readonly photosDone: number;
  readonly photosFailed: number;
  /** What went wrong, in sentences of ours with how many; never a line of the file. */
  readonly errors: readonly { sentence: string; count: number }[];
}

interface Row {
  id: string;
  source: string;
  status: string;
  createdAt: number | string;
  finishedAt: number | string | null;
  fileBytes: number | string;
  checkinsDone: number | string;
  checkinsSkipped: number | string;
  placesMade: number | string;
  photosDone: number | string;
  photosFailed: number | string;
  sealed: ArrayBuffer | Uint8Array | null;
}
const COLUMNS = sql`id, source, status, created_at AS "createdAt", finished_at AS "finishedAt", file_bytes AS "fileBytes",
  checkins_done AS "checkinsDone", checkins_skipped AS "checkinsSkipped", places_made AS "placesMade", photos_done AS "photosDone",
  photos_failed AS "photosFailed", sealed`;

/** A person's imports, newest first: what is running and what was done, with their counts. */
export async function listImportsOf(
  deps: Pick<ImportDeps, 'database' | 'sealer'>,
  accountId: string,
  limit = 20,
): Promise<ImportView[]> {
  const rows = await dbAll<Row>(
    deps.database,
    sql`SELECT ${COLUMNS} FROM ${table(deps.database)} WHERE account_id = ${accountId}
        ORDER BY created_at DESC, id DESC LIMIT ${Math.max(1, Math.min(limit, 100))}`,
  );
  return rows.map((row) => {
    let errors: ImportView['errors'] = [];
    if (row.sealed) {
      const bytes = row.sealed instanceof Uint8Array ? row.sealed : new Uint8Array(row.sealed);
      const found = deps.sealer.unseal('import_job', row.id, bytes).errors;
      if (Array.isArray(found))
        errors = found.flatMap((each: unknown) => {
          const e = each as { sentence?: unknown; count?: unknown };
          return typeof e.sentence === 'string' && typeof e.count === 'number'
            ? [{ sentence: e.sentence, count: e.count }]
            : [];
        });
    }
    return {
      id: row.id,
      source: row.source as ImportSource,
      status: row.status as ImportStatus,
      createdAt: Number(row.createdAt),
      finishedAt: row.finishedAt === null ? undefined : Number(row.finishedAt),
      fileBytes: Number(row.fileBytes),
      checkinsDone: Number(row.checkinsDone),
      checkinsSkipped: Number(row.checkinsSkipped),
      placesMade: Number(row.placesMade),
      photosDone: Number(row.photosDone),
      photosFailed: Number(row.photosFailed),
      errors,
    };
  });
}

/**
 * Stops an import that is waiting or running, and deletes its file. What was already imported stays (it is the person's now). The worker finds out at its next step, because it only ever works an import that is
 * still `running`. Returns whether there was one to cancel: another person's, and one that has ended, are the same answer.
 */
export async function cancelImport(
  deps: ImportDeps,
  accountId: string,
  id: string,
): Promise<boolean> {
  const now = deps.now();
  const rows = await dbAll<{ id: string }>(
    deps.database,
    sql`UPDATE ${table(deps.database)} SET status = 'cancelled', finished_at = ${now}, claimed_until = 0, updated_at = ${now}
        WHERE id = ${id} AND account_id = ${accountId} AND status IN ('queued', 'running') RETURNING id`,
  );
  if (rows.length === 0) return false;
  await removeImport(deps.dir, id);
  return true;
}

/**
 * Everything of a person's imports (`People.deletePerson`): the files first, so that rows that name a file still there are found again by a run that stopped part way, then the rows. Returns how many.
 */
export async function deleteImportsOf(
  deps: Pick<ImportDeps, 'database' | 'dir'>,
  accountId: string,
): Promise<number> {
  const rows = await dbAll<{ id: string }>(
    deps.database,
    sql`SELECT id FROM ${table(deps.database)} WHERE account_id = ${accountId}`,
  );
  for (const row of rows) await removeImport(deps.dir, row.id);
  const gone = await dbAll<{ id: string }>(
    deps.database,
    sql`DELETE FROM ${table(deps.database)} WHERE account_id = ${accountId} RETURNING id`,
  );
  return gone.length;
}

/** The imports directory beside a media directory (`<data>/media` and `<data>/imports`), for the deletion routine, which is given the media store and not the data directory. */
export const importDirBeside = (mediaDir: string): string =>
  path.join(path.dirname(mediaDir), 'imports');

export const SWEEP_GRACE_MS = 60 * 60 * 1000;
export const KEEP_FINISHED_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * What a crash left: files no import row names (an upload that died between its file and its row) once they are an hour old, so that an upload in flight is never cut off; a queued or running import whose file is
 * gone, which can never be read, ended as failed; and finished imports older than 90 days, whose counts are of no more use. Safe to run twice and from two processes.
 */
export async function sweepImports(
  deps: Pick<ImportDeps, 'database' | 'dir' | 'now'>,
): Promise<{ files: number; orphaned: number; pruned: number }> {
  const known = new Set(
    (await dbAll<{ id: string }>(deps.database, sql`SELECT id FROM ${table(deps.database)}`)).map(
      (row) => row.id,
    ),
  );
  let files = 0;
  for (const id of await listImports(deps.dir)) {
    if (known.has(id)) continue;
    const age = deps.now() - (await stat(path.join(deps.dir, id))).mtimeMs;
    if (age > SWEEP_GRACE_MS) {
      await removeImport(deps.dir, id);
      files += 1;
    }
  }
  let orphaned = 0;
  const waiting = await dbAll<{ id: string }>(
    deps.database,
    sql`SELECT id FROM ${table(deps.database)} WHERE status IN ('queued', 'running')`,
  );
  for (const row of waiting) {
    try {
      await stat(path.join(deps.dir, row.id));
    } catch {
      const done = await dbAll<{ id: string }>(
        deps.database,
        sql`UPDATE ${table(deps.database)} SET status = 'failed', finished_at = ${deps.now()}, claimed_until = 0
            WHERE id = ${row.id} AND status IN ('queued', 'running') RETURNING id`,
      );
      orphaned += done.length;
    }
  }
  const pruned = await dbAll<{ id: string }>(
    deps.database,
    sql`DELETE FROM ${table(deps.database)}
        WHERE status IN ('done', 'failed', 'cancelled') AND finished_at < ${deps.now() - KEEP_FINISHED_MS} RETURNING id`,
  );
  return { files, orphaned, pruned: pruned.length };
}

export { ACTIVE };
