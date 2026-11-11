import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { placeRowOf } from '../actions/places';
import { validateCheckinRow } from '../checkins/validate';
import type { KeyRing } from '../crypto/keys';
import type { Sealer } from '../crypto/sealed';
import type { Database } from '../db/client';
import { dbAll, transaction } from '../db/exec';
import * as postgresSchema from '../db/schema/postgres';
import * as sqliteSchema from '../db/schema/sqlite';
import { type Delivery, raiseNotice } from '../notices/notices';
import type { Address } from '../places/clean';
import { offsetMinutes } from '../places/tz';
import { type ApplyDeps, applyMutation } from '../sync/apply';
import { type Change, type CheckinSource, type Mutation, ACCOUNT_STREAM } from '../sync/format';
import { type PlainFile, materializeImport, readImport, removeImport } from './files';

/**
 * **The import job** (DESIGN.md §16): a resumable job that reads an uploaded export through a *reader*, makes places and check-ins through **the one write path** (`sync/apply.ts`, as a device's own change
 * would be), keeps a cursor after every step, and deletes the file at the end. The job is general; a service's export is a `ImportReader` (8.2 is the Swarm one). Nothing here reads a particular service's
 * format.
 *
 * **It carries on after a restart and does nothing twice.** A worker claims one import by a lease in the database (`claimImport`), so two workers or two processes never work one; a worker that dies holding
 * it costs only the lease. A step reads a batch after the cursor, applies it, and only then moves the cursor, so a crash between the two applies the batch again, and again is harmless: **a place and a
 * check-in have ids that are made from the account and the service's own id** (`idFor`), the batch is **one mutation with an id made from the job and the cursor** (a replay writes nothing), and what is
 * already here (or was deleted by the person since, whose tombstone is read) is not made again, so a second run of the same export, by another job, creates nothing. **What a person typed is never
 * overwritten:** an imported place or check-in that is already here is left as it is.
 *
 * Nothing is logged but counts and ids, and what is shown of a failure is a sentence of ours, never a name, a place or a line of the file (`SEALED.import_job` seals even that).
 */
export const STEP_ITEMS = 25;
/** How long a worker holds an import without renewing: long enough for a step, short enough that a dead worker is replaced soon. */
export const LEASE_MS = 90_000;
/** How long one run of the job keeps working before it gives the lease up and lets the next run (or another process) carry on. */
export const BUDGET_MS = 25_000;

export type ImportSource = 'swarm';
export type ImportStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';
export const ACTIVE: readonly ImportStatus[] = ['queued', 'running'];

/** What a reader gets of the file: a stream of its plain bytes, or a plain copy on disk for a format that must seek (a ZIP's index is at its end). Either is read chunk by chunk, never whole in memory. */
export interface ImportFile {
  stream(): AsyncGenerator<Buffer, void, void>;
  /** A plain file the reader removes when it is done with it. */
  materialize(): Promise<PlainFile>;
}

/** One check-in of an export, with its place: what a reader finds, in the shape the job makes rows from. */
export interface ImportItem {
  /** The service's own id for the check-in, which is what makes a second run create nothing. */
  readonly externalId: string;
  /** The moment, milliseconds since the epoch. */
  readonly at: number;
  /** The zone it was made in, and its offset then in minutes; absent, they are found from the place's point. */
  readonly tz?: string | undefined;
  readonly offsetMin?: number | undefined;
  readonly note?: string | undefined;
  readonly companions?: readonly string[] | undefined;
  readonly place: {
    /** The service's own id for the venue: a place is one place however often it is checked in at. */
    readonly sourceId: string;
    readonly name: string;
    readonly lat: number;
    readonly lng: number;
    readonly address?: Address | undefined;
    readonly category?: string | undefined;
  };
}

export interface CheckinsRead {
  readonly items: readonly ImportItem[];
  /** Where to carry on from, which the job keeps. */
  readonly cursor: number;
  readonly done: boolean;
  /** Entries the reader read and could not turn into a check-in (counted, never shown). */
  readonly unreadable?: number;
}

export interface ImportReader {
  readonly source: ImportSource;
  /** The check-ins after `cursor`, at most `limit`. Throws for a file that is not this service's. */
  checkins(input: { file: ImportFile; cursor: number; limit: number }): Promise<CheckinsRead>;
}

export interface ImportDeps {
  readonly database: Database;
  readonly sealer: Sealer;
  readonly ring: KeyRing;
  /** `<data>/imports`. */
  readonly dir: string;
  /** Where a reader's plain copy goes: a directory this process owns. */
  readonly workDir: string;
  readonly now: () => number;
  readonly readers: Readonly<Partial<Record<ImportSource, ImportReader>>>;
  /** How notices also reach people on this server (email, if there is mail). */
  readonly delivery?: () => Delivery;
  /** Removes photos' files that left a check-in; unused by an import, passed through to the write path. */
  readonly release?: ApplyDeps['release'];
}

const table = (database: Database) =>
  database.dialect === 'postgres' ? postgresSchema.importJob : sqliteSchema.importJob;
const named = (database: Database, name: string) =>
  sql.raw(database.dialect === 'postgres' ? `waymark.${name}` : name);

/** A UUID made from what a thing is, so that making it again makes the same id (and the id is a valid one for a row and a file name). */
export function idFor(kind: 'place' | 'checkin', accountId: string, key: string): string {
  const hash = createHash('sha256').update(`waymark:import:${kind}:${accountId}:${key}`).digest();
  const hex = hash.subarray(0, 16).toString('hex').split('');
  hex[12] = '8';
  hex[16] = ['8', '9', 'a', 'b'][(hash[8] ?? 0) & 3] ?? '8';
  const h = hex.join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

export interface Claimed {
  readonly id: string;
  readonly accountId: string;
  readonly source: ImportSource;
  readonly cursor: number;
}

/**
 * Takes the oldest import that is waiting or whose worker is gone, in one statement that names the conditions in the subquery that picks and in the update that takes (so two workers that pick the same
 * row take it once), and holds it for `LEASE_MS`.
 */
export async function claimImport(deps: ImportDeps): Promise<Claimed | undefined> {
  const now = deps.now();
  const rows = await dbAll<{
    id: string;
    accountId: string;
    source: string;
    cursor: number | string;
  }>(
    deps.database,
    sql`UPDATE ${table(deps.database)}
        SET status = 'running', claimed_until = ${now + LEASE_MS}, updated_at = ${now}
        WHERE id IN (
          SELECT id FROM ${table(deps.database)}
          WHERE status IN ('queued', 'running') AND claimed_until <= ${now}
          ORDER BY created_at, id LIMIT 1
        ) AND status IN ('queued', 'running') AND claimed_until <= ${now}
        RETURNING id, account_id AS "accountId", source, cursor`,
  );
  const row = rows[0];
  return row
    ? {
        id: row.id,
        accountId: row.accountId,
        source: row.source as ImportSource,
        cursor: Number(row.cursor),
      }
    : undefined;
}

/** Renews the lease **if the import is still ours and still running**: false when it was cancelled or finished, and the worker stops. */
async function renew(deps: ImportDeps, id: string): Promise<boolean> {
  const rows = await dbAll<{ id: string }>(
    deps.database,
    sql`UPDATE ${table(deps.database)} SET claimed_until = ${deps.now() + LEASE_MS}, updated_at = ${deps.now()}
        WHERE id = ${id} AND status = 'running' RETURNING id`,
  );
  return rows.length > 0;
}

/** Gives the lease up so that the next run, or another process, carries on at once. */
async function release(deps: ImportDeps, id: string): Promise<void> {
  await dbAll(
    deps.database,
    sql`UPDATE ${table(deps.database)} SET claimed_until = 0 WHERE id = ${id} AND status = 'running' RETURNING id`,
  );
}

const inList = (values: readonly string[]) =>
  sql.join(
    values.map((value) => sql`${value}`),
    sql`, `,
  );

async function existing(
  deps: ImportDeps,
  accountId: string,
  tableName: 'place' | 'checkin',
  ids: readonly string[],
): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await dbAll<{ id: string }>(
    deps.database,
    sql`SELECT id FROM ${named(deps.database, tableName)} WHERE account_id = ${accountId} AND id IN (${inList(ids)})`,
  );
  return new Set(rows.map((row) => row.id));
}

async function deleted(
  deps: ImportDeps,
  accountId: string,
  ids: readonly string[],
): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await dbAll<{ id: string }>(
    deps.database,
    sql`SELECT row_id AS id FROM ${named(deps.database, 'tombstone')}
        WHERE account_id = ${accountId} AND table_name = 'checkin' AND row_id IN (${inList(ids)})`,
  );
  return new Set(rows.map((row) => row.id));
}

export interface Applied {
  readonly checkins: number;
  readonly places: number;
  readonly skipped: number;
}

const SOURCE_OF: Readonly<Record<ImportSource, CheckinSource>> = { swarm: 'import:swarm' };

/**
 * Makes what a batch says, as one mutation through the write path. An item that is not a valid place or check-in is skipped (counted), one that is already here or was deleted by the person is left alone
 * (counted), and a mutation the write path refuses skips its items (counted) without stopping the import: a person's file is not thrown away for one bad line.
 */
export async function applyBatch(
  deps: ImportDeps,
  job: Pick<Claimed, 'id' | 'accountId' | 'source'>,
  cursor: number,
  items: readonly ImportItem[],
): Promise<Applied> {
  const now = deps.now();
  const prepared: {
    placeId: string;
    checkinId: string;
    place: ReturnType<typeof placeRowOf>;
    item: ImportItem;
  }[] = [];
  let skipped = 0;
  for (const item of items) {
    const place = placeRowOf({
      name: item.place.name,
      lat: item.place.lat,
      lng: item.place.lng,
      address: item.place.address,
      category: item.place.category,
      sourceId: item.place.sourceId,
      source: 'import',
    });
    if (!place.ok || item.externalId === '' || item.place.sourceId === '') {
      skipped += 1;
      continue;
    }
    prepared.push({
      placeId: idFor('place', job.accountId, item.place.sourceId),
      checkinId: idFor('checkin', job.accountId, item.externalId),
      place,
      item,
    });
  }
  const [haveCheckins, goneCheckins, havePlaces] = await Promise.all([
    existing(
      deps,
      job.accountId,
      'checkin',
      prepared.map((each) => each.checkinId),
    ),
    deleted(
      deps,
      job.accountId,
      prepared.map((each) => each.checkinId),
    ),
    existing(
      deps,
      job.accountId,
      'place',
      prepared.map((each) => each.placeId),
    ),
  ]);
  const changes: Change[] = [];
  const placed = new Set<string>();
  const made = new Set<string>();
  let checkins = 0;
  let places = 0;
  for (const each of prepared) {
    if (
      haveCheckins.has(each.checkinId) ||
      goneCheckins.has(each.checkinId) ||
      made.has(each.checkinId)
    ) {
      skipped += 1;
      continue;
    }
    if (!each.place.ok) continue;
    const tz = each.item.tz ?? each.place.value.tz ?? undefined;
    if (!tz) {
      skipped += 1;
      continue;
    }
    let offsetMin = each.item.offsetMin;
    try {
      offsetMin ??= offsetMinutes(each.item.at, tz);
    } catch {
      skipped += 1;
      continue;
    }
    const row = validateCheckinRow(
      {
        placeId: each.placeId,
        at: each.item.at,
        tz,
        offsetMin,
        ...(each.item.note ? { note: each.item.note } : {}),
        companions: [...(each.item.companions ?? [])],
        tripId: null,
        linkSource: null,
        share: 'trip',
        source: SOURCE_OF[job.source],
        externalId: each.item.externalId,
      },
      now,
    );
    if (!row.ok) {
      skipped += 1;
      continue;
    }
    if (!havePlaces.has(each.placeId) && !placed.has(each.placeId)) {
      changes.push({ table: 'place', op: 'put', id: each.placeId, row: each.place.value });
      placed.add(each.placeId);
      places += 1;
    }
    changes.push({ table: 'checkin', op: 'put', id: each.checkinId, row: row.value });
    made.add(each.checkinId);
    checkins += 1;
  }
  if (changes.length === 0) return { checkins: 0, places: 0, skipped };
  const mutation: Mutation = {
    mutationId: `import-${job.id}-${cursor}`,
    stream: ACCOUNT_STREAM,
    changes,
  };
  const result = await applyMutation(
    {
      database: deps.database,
      sealer: deps.sealer,
      now: deps.now,
      ...(deps.release ? { release: deps.release } : {}),
    },
    job.accountId,
    mutation,
  );
  if (result.status === 'refused') return { checkins: 0, places: 0, skipped: skipped + checkins };
  return { checkins, places, skipped };
}

const SENTENCES = {
  unreadable:
    'The file could not be read. Check that it is the export that service sent you, and upload it again.',
  unsupported: 'Importing from that service is not available on this server.',
  missing: 'The uploaded file is gone. Upload it again.',
} as const;
type Failure = keyof typeof SENTENCES;

/** Ends an import that cannot go on: the file is deleted, the person is told in the bell (and by email where they want it), and the reason is sealed as a sentence of ours. */
async function fail(deps: ImportDeps, job: Claimed, reason: Failure): Promise<void> {
  const now = deps.now();
  const sealed = deps.sealer.seal('import_job', job.id, {
    errors: [{ sentence: SENTENCES[reason], count: 1 }],
  });
  await transaction(deps.database, async (tx) => {
    const rows = await dbAll<{ id: string }>(
      tx,
      sql`UPDATE ${table(tx)} SET status = 'failed', finished_at = ${now}, claimed_until = 0, updated_at = ${now}, sealed = ${sealed}
          WHERE id = ${job.id} AND status = 'running' RETURNING id`,
    );
    if (rows.length === 0) return;
    await raiseNotice(
      tx,
      deps.sealer,
      now,
      {
        to: job.accountId,
        by: 'import',
        kind: 'import_finished',
        content: {
          title: 'Your import could not be finished',
          detail: SENTENCES[reason],
          href: '/settings?section=data',
        },
      },
      deps.delivery?.() ?? {},
    );
  });
  await removeImport(deps.dir, job.id);
}

/** Ends an import that has read to the end: the counts, one notice for the person, and the file deleted. */
async function finish(deps: ImportDeps, job: Claimed): Promise<void> {
  const now = deps.now();
  await transaction(deps.database, async (tx) => {
    const rows = await dbAll<{ done: number | string; skipped: number | string }>(
      tx,
      sql`UPDATE ${table(tx)} SET status = 'done', finished_at = ${now}, claimed_until = 0, updated_at = ${now}
          WHERE id = ${job.id} AND status = 'running' RETURNING checkins_done AS done, checkins_skipped AS skipped`,
    );
    const row = rows[0];
    if (!row) return;
    const done = Number(row.done);
    const skipped = Number(row.skipped);
    await raiseNotice(
      tx,
      deps.sealer,
      now,
      {
        to: job.accountId,
        by: 'import',
        kind: 'import_finished',
        content: {
          title: 'Your import has finished',
          detail: `${done.toLocaleString('en-GB')} ${done === 1 ? 'check-in was' : 'check-ins were'} added${skipped > 0 ? `, and ${skipped.toLocaleString('en-GB')} ${skipped === 1 ? 'was' : 'were'} already here or could not be read` : ''}.`,
          href: '/checkins',
        },
      },
      deps.delivery?.() ?? {},
    );
  });
  await removeImport(deps.dir, job.id);
}

/** Works the import it has claimed until it ends, is cancelled, or the budget is spent (then it gives the lease up, and the next run carries on from the cursor). */
async function work(
  deps: ImportDeps,
  job: Claimed,
  until: number,
  signal?: AbortSignal,
): Promise<boolean> {
  const reader = deps.readers[job.source];
  if (!reader) {
    await fail(deps, job, 'unsupported');
    return true;
  }
  const file: ImportFile = {
    stream: () => readImport(deps.dir, job.id, deps.ring),
    materialize: () => materializeImport(deps.dir, job.id, deps.ring, deps.workDir),
  };
  let cursor = job.cursor;
  for (;;) {
    // Still ours, and not cancelled meanwhile.
    if (!(await renew(deps, job.id))) return true;
    if (deps.now() >= until || signal?.aborted) {
      await release(deps, job.id);
      return false;
    }
    let read: CheckinsRead;
    try {
      read = await reader.checkins({ file, cursor, limit: STEP_ITEMS });
    } catch {
      // A cancel removes the file under the reader: that is not a failure.
      if (!(await renew(deps, job.id))) return true;
      await fail(deps, job, 'unreadable');
      return true;
    }
    const applied = await applyBatch(deps, job, cursor, read.items);
    cursor = read.cursor;
    const rows = await dbAll<{ id: string }>(
      deps.database,
      sql`UPDATE ${table(deps.database)}
          SET cursor = ${cursor}, checkins_done = checkins_done + ${applied.checkins},
              places_made = places_made + ${applied.places},
              checkins_skipped = checkins_skipped + ${applied.skipped + (read.unreadable ?? 0)},
              updated_at = ${deps.now()}
          WHERE id = ${job.id} AND status = 'running' RETURNING id`,
    );
    if (rows.length === 0) return true;
    if (read.done) {
      await finish(deps, job);
      return true;
    }
  }
}

export interface Worked {
  /** Imports that ended in this run (done, failed or cancelled under it). */
  readonly ended: number;
}

/** One run of the job: claims imports one after another and works each for the rest of the budget. Returns how many ended. Safe to run from two processes at once. */
export async function workOnImports(
  deps: ImportDeps,
  options: { budgetMs?: number; signal?: AbortSignal } = {},
): Promise<Worked> {
  const until = deps.now() + (options.budgetMs ?? BUDGET_MS);
  let ended = 0;
  while (deps.now() < until && !options.signal?.aborted) {
    const job = await claimImport(deps);
    if (!job) break;
    if (await work(deps, job, until, options.signal)) ended += 1;
  }
  return { ended };
}
