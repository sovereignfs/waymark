import { stat } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { KeyRing } from '../crypto/keys';
import type { Sealer } from '../crypto/sealed';
import type { Database } from '../db/client';
import { dbAll } from '../db/exec';
import * as postgresSchema from '../db/schema/postgres';
import * as sqliteSchema from '../db/schema/sqlite';
import { hasImport, listImports, readImport, removeImport, writeImport } from '../import/files';
import { type MediaDeps, readMedia } from '../media/service';
import { listPrefs } from '../notices/prefs';
import { getProfile } from '../profile/profile';
import { pullAccount } from '../sync/pull';
import { ZipWriter } from './zip';
import {
  type Export,
  type ExportedCheckin,
  type ExportedPhoto,
  type ExportedPlace,
  FORMAT,
  JSON_NAME,
  PHOTO_DIR,
  VERSION,
  extensionOf,
} from './format';

/**
 * **Export** (DESIGN.md §22): a person's data in one ZIP, built by a job and downloaded from Settings > Data within a day. A request is a row (`export_job`); a worker claims it by a lease in the database, builds the
 * ZIP **as a stream into a sealed file of its own** under `<data>/exports` (the same chunked sealing as an uploaded import, so a decade of photos is never whole in memory), marks it ready for 24 hours, and a sweep
 * deletes the file when the day is up. Every read names the account, so another person's rows are not in it; **no one's email is in it** (`format.ts` says what is).
 *
 * The photos are written first, each as the file it is, and `waymark.json` last, listing exactly the photos that were written: a photo that went between the list and the file cannot be named and missing. A file a
 * reader opens is a standard ZIP (`zip.ts`, ZIP64 when it has to be).
 */
export const READY_FOR_MS = 24 * 60 * 60 * 1000;
/** How long a worker holds a request without renewing: renewed after every few photos, so a long export keeps it and a dead worker costs only this. */
export const LEASE_MS = 5 * 60 * 1000;
/** How long a request that has ended is remembered after its file is gone. */
export const KEEP_MS = 7 * 24 * 60 * 60 * 1000;

export interface ExportDeps {
  readonly database: Database;
  readonly sealer: Sealer;
  readonly ring: KeyRing;
  /** `<data>/exports`. */
  readonly dir: string;
  readonly media: MediaDeps;
  readonly now: () => number;
}

export type ExportStatus = 'queued' | 'running' | 'ready' | 'failed' | 'expired';

const table = (database: Database) =>
  database.dialect === 'postgres' ? postgresSchema.exportJob : sqliteSchema.exportJob;
/** The exports directory beside a media directory (`<data>/media` and `<data>/exports`), for the deletion routine, which is given the media store and not the data directory. */
export const exportDirBeside = (mediaDir: string): string =>
  path.join(path.dirname(mediaDir), 'exports');
export const exportDirOf = (dataDir: string): string => path.join(dataDir, 'exports');

/** Asks for an export. One at a time for a person: while one is queued or running, a second is not made. */
export async function requestExport(
  deps: Pick<ExportDeps, 'database' | 'now'>,
  accountId: string,
): Promise<{ ok: true; id: string } | { ok: false; reason: 'busy' }> {
  const active = await dbAll<{ n: number | string }>(
    deps.database,
    sql`SELECT COUNT(*) AS n FROM ${table(deps.database)} WHERE account_id = ${accountId} AND status IN ('queued', 'running')`,
  );
  if (Number(active[0]?.n ?? 0) > 0) return { ok: false, reason: 'busy' };
  const id = randomUUID();
  await dbAll(
    deps.database,
    sql`INSERT INTO ${table(deps.database)} (id, account_id, status, bytes, claimed_until, created_at)
        VALUES (${id}, ${accountId}, 'queued', 0, 0, ${deps.now()}) RETURNING id`,
  );
  return { ok: true, id };
}

/** Takes the oldest request that is waiting or whose worker is gone, in one statement that names the conditions in the subquery and the update, so two workers that pick one row take it once. */
async function claim(deps: ExportDeps): Promise<{ id: string; accountId: string } | undefined> {
  const now = deps.now();
  const rows = await dbAll<{ id: string; accountId: string }>(
    deps.database,
    sql`UPDATE ${table(deps.database)} SET status = 'running', claimed_until = ${now + LEASE_MS}
        WHERE id IN (
          SELECT id FROM ${table(deps.database)}
          WHERE status IN ('queued', 'running') AND claimed_until <= ${now}
          ORDER BY created_at, id LIMIT 1
        ) AND status IN ('queued', 'running') AND claimed_until <= ${now}
        RETURNING id, account_id AS "accountId"`,
  );
  return rows[0];
}

async function renew(deps: ExportDeps, id: string): Promise<boolean> {
  const rows = await dbAll<{ id: string }>(
    deps.database,
    sql`UPDATE ${table(deps.database)} SET claimed_until = ${deps.now() + LEASE_MS}
        WHERE id = ${id} AND status = 'running' RETURNING id`,
  );
  return rows.length > 0;
}

/** Everything of the person's that goes in the file, read for the account and no one else: the profile, the choices of what is emailed, and every place and check-in. */
async function gather(deps: ExportDeps, accountId: string) {
  const profile = await getProfile(deps.database, deps.sealer, accountId);
  const prefs = await listPrefs(deps.database, accountId);
  const places: ExportedPlace[] = [];
  const checkins: ExportedCheckin[] = [];
  let cursor = 0;
  for (;;) {
    const page = await pullAccount(deps, accountId, cursor, 500);
    for (const place of page.places) {
      const { version: _version, seq: _seq, ...row } = place;
      places.push(row);
    }
    for (const checkin of page.checkins) {
      const { version: _version, seq: _seq, ...row } = checkin;
      // A phase 1 check-in has no trip; the link is not exported until trips are (15.3).
      checkins.push({ ...row, tripId: null, linkSource: null });
    }
    cursor = page.cursor;
    if (!page.more) break;
  }
  return { profile, prefs, places, checkins };
}

type Gathered = Awaited<ReturnType<typeof gather>>;

/**
 * The ZIP, a piece at a time. A photo is read and written on its own, so what is held is one photo and the rows; `tick` is told after every few so that the lease is kept. The photos come first and the JSON last,
 * listing exactly what was written.
 */
export async function* zipOf(
  deps: ExportDeps,
  accountId: string,
  tick: () => Promise<void> = async () => undefined,
): AsyncGenerator<Uint8Array, void, void> {
  const data: Gathered = await gather(deps, accountId);
  if (!data.profile) throw new Error('there is no profile to export');
  const zip = new ZipWriter(new Date(deps.now()));

  const photos: ExportedPhoto[] = [];
  const seen = new Set<string>();
  let n = 0;
  for (const checkin of data.checkins) {
    for (const id of checkin.photos ?? []) {
      if (seen.has(id)) continue;
      seen.add(id);
      // A photo that has not reached the server (it was taken offline and has not uploaded) is not in the file; the check-in still names it, and an import tolerates that.
      const file = await readMedia(deps.media, { accountId, id });
      if (!file) continue;
      const name = `${PHOTO_DIR}${id}.${extensionOf(file.type)}`;
      // Already compressed images: stored as they are.
      yield* zip.add(name, file.bytes);
      photos.push({ id, file: name, type: file.type });
      n += 1;
      if (n % 25 === 0) await tick();
    }
  }

  const document: Export = {
    format: FORMAT,
    version: VERSION,
    exportedAt: new Date(deps.now()).toISOString(),
    profile: {
      name: data.profile.name,
      units: data.profile.units,
      weekStart: data.profile.weekStart,
      shareDefault: data.profile.shareDefault,
    },
    settings: {
      email: Object.fromEntries(Object.entries(data.prefs).map(([kind, by]) => [kind, by.email])),
    },
    places: data.places,
    checkins: data.checkins,
    photos,
  };
  yield* zip.add(JSON_NAME, Buffer.from(JSON.stringify(document), 'utf8'), { deflate: true });
  yield* zip.finish();
}

/** One run: claims a request and builds it. Returns whether there was one. A failure ends the request as failed, with its file removed; nothing of the data is in what is logged. */
export async function workOnExports(deps: ExportDeps): Promise<boolean> {
  const job = await claim(deps);
  if (!job) return false;
  try {
    const written = await writeImport(
      deps.dir,
      job.id,
      zipOf(deps, job.accountId, async () => void (await renew(deps, job.id))),
      deps.ring,
      // The most one account may keep, and room for the rows: an export is never larger than what it is of.
      deps.media.maxAccountBytes + 512 * 1024 * 1024,
    );
    if (!written.ok) throw new Error(written.reason);
    const now = deps.now();
    const done = await dbAll<{ id: string }>(
      deps.database,
      sql`UPDATE ${table(deps.database)}
          SET status = 'ready', bytes = ${written.bytes}, ready_at = ${now}, expires_at = ${now + READY_FOR_MS}, claimed_until = 0
          WHERE id = ${job.id} AND status = 'running' RETURNING id`,
    );
    // The request was deleted while it was being built: nothing is kept.
    if (done.length === 0) await removeImport(deps.dir, job.id);
  } catch {
    await removeImport(deps.dir, job.id);
    await dbAll(
      deps.database,
      sql`UPDATE ${table(deps.database)} SET status = 'failed', claimed_until = 0 WHERE id = ${job.id} AND status = 'running' RETURNING id`,
    );
  }
  return true;
}

export interface ExportView {
  readonly id: string;
  readonly status: ExportStatus;
  readonly bytes: number;
  readonly createdAt: number;
  readonly readyAt: number | undefined;
  readonly expiresAt: number | undefined;
}

/** A person's exports, newest first. */
export async function listExportsOf(
  deps: Pick<ExportDeps, 'database'>,
  accountId: string,
  limit = 10,
): Promise<ExportView[]> {
  const rows = await dbAll<{
    id: string;
    status: string;
    bytes: number | string;
    createdAt: number | string;
    readyAt: number | string | null;
    expiresAt: number | string | null;
  }>(
    deps.database,
    sql`SELECT id, status, bytes, created_at AS "createdAt", ready_at AS "readyAt", expires_at AS "expiresAt"
        FROM ${table(deps.database)} WHERE account_id = ${accountId} ORDER BY created_at DESC, id DESC LIMIT ${Math.max(1, Math.min(limit, 50))}`,
  );
  return rows.map((row) => ({
    id: row.id,
    status: row.status as ExportStatus,
    bytes: Number(row.bytes),
    createdAt: Number(row.createdAt),
    readyAt: row.readyAt === null ? undefined : Number(row.readyAt),
    expiresAt: row.expiresAt === null ? undefined : Number(row.expiresAt),
  }));
}

/** The file of one of the account's exports that is ready and has not run out, as a stream of its ZIP's bytes; another person's, an unfinished one and an expired one are the same answer: none. */
export async function openExport(
  deps: ExportDeps,
  accountId: string,
  id: string,
): Promise<{ bytes: number; stream: AsyncGenerator<Buffer, void, void> } | undefined> {
  const rows = await dbAll<{ bytes: number | string }>(
    deps.database,
    sql`SELECT bytes FROM ${table(deps.database)}
        WHERE id = ${id} AND account_id = ${accountId} AND status = 'ready' AND expires_at > ${deps.now()}`,
  );
  const row = rows[0];
  if (!row || !(await hasImport(deps.dir, id))) return undefined;
  return { bytes: Number(row.bytes), stream: readImport(deps.dir, id, deps.ring) };
}

/** Deletes one of the account's exports and its file at once. Returns whether there was one. */
export async function deleteExport(
  deps: Pick<ExportDeps, 'database' | 'dir'>,
  accountId: string,
  id: string,
): Promise<boolean> {
  const rows = await dbAll<{ id: string }>(
    deps.database,
    sql`DELETE FROM ${table(deps.database)} WHERE id = ${id} AND account_id = ${accountId} RETURNING id`,
  );
  if (rows.length === 0) return false;
  await removeImport(deps.dir, id);
  return true;
}

/** Everything of a person's exports (`People.deletePerson`): the files first, then the rows. Returns how many. */
export async function deleteExportsOf(
  deps: Pick<ExportDeps, 'database' | 'dir'>,
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

/**
 * What the day's end and a crash leave: the file of an export that has run out is deleted and the request marked `expired` (a record that it was, for a week, and then the row goes), a file no request names
 * (a worker that died after writing and before saying) once it is an hour old, and a ready request whose file is gone ended as expired. Safe to run twice and from two processes.
 */
export async function sweepExports(
  deps: Pick<ExportDeps, 'database' | 'dir' | 'now'>,
): Promise<{ expired: number; files: number; forgotten: number }> {
  const now = deps.now();
  const lapsed = await dbAll<{ id: string }>(
    deps.database,
    sql`UPDATE ${table(deps.database)} SET status = 'expired'
        WHERE status = 'ready' AND expires_at <= ${now} RETURNING id`,
  );
  for (const row of lapsed) await removeImport(deps.dir, row.id);

  const known = new Set(
    (await dbAll<{ id: string }>(deps.database, sql`SELECT id FROM ${table(deps.database)}`)).map(
      (row) => row.id,
    ),
  );
  let files = 0;
  for (const id of await listImports(deps.dir)) {
    if (known.has(id)) continue;
    const age = now - (await stat(path.join(deps.dir, id))).mtimeMs;
    if (age > 60 * 60 * 1000) {
      await removeImport(deps.dir, id);
      files += 1;
    }
  }
  // A ready export whose file has gone can never be downloaded.
  const ready = await dbAll<{ id: string }>(
    deps.database,
    sql`SELECT id FROM ${table(deps.database)} WHERE status = 'ready'`,
  );
  for (const row of ready)
    if (!(await hasImport(deps.dir, row.id)))
      await dbAll(
        deps.database,
        sql`UPDATE ${table(deps.database)} SET status = 'expired' WHERE id = ${row.id} AND status = 'ready' RETURNING id`,
      );
  const forgotten = await dbAll<{ id: string }>(
    deps.database,
    sql`DELETE FROM ${table(deps.database)}
        WHERE status IN ('expired', 'failed') AND created_at < ${now - KEEP_MS} RETURNING id`,
  );
  return { expired: lapsed.length, files, forgotten: forgotten.length };
}
