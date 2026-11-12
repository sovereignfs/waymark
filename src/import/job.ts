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
import { enqueueCore } from '../sovereign/outbox';
import type { MediaDeps } from '../media/service';
import { putMedia } from '../media/service';
import type { Address, PlaceSource } from '../places/clean';
import { offsetMinutes } from '../places/tz';
import { type ApplyDeps, applyMutation } from '../sync/apply';
import { type Change, type CheckinSource, type Mutation, ACCOUNT_STREAM } from '../sync/format';
import { idFor } from './ids';
import { type TripSource, importTrips } from './trips';
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

export type ImportSource = 'swarm' | 'waymark';
export type ImportStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';
export const ACTIVE: readonly ImportStatus[] = ['queued', 'running'];

/** What a reader gets of the file: a stream of its plain bytes, or a plain copy on disk for a format that must seek (a ZIP's index is at its end). Either is read chunk by chunk, never whole in memory. */
export interface ImportFile {
  stream(): AsyncGenerator<Buffer, void, void>;
  /** A plain file the reader removes when it is done with it. */
  materialize(): Promise<PlainFile>;
}

/** A photo of a check-in in an export: the file's own id for it, from which the job makes the id it has here (from the account too, so a second run makes the same), and how to read its bytes when the job needs them (one at a time). */
export interface ImportPhoto {
  readonly key: string;
  load(): Promise<Buffer>;
}

/** One check-in of an export, with its place: what a reader finds, in the shape the job makes rows from. */
export interface ImportItem {
  /** The service's own id for the check-in, which is what makes a second run create nothing. It is kept on the row for Swarm's (`import:swarm`) and for no other source. */
  readonly externalId: string;
  /** What is kept on the row as the import's own id for a Swarm check-in (`import:swarm`), when that is not `externalId`: a Waymark file's own id for the check-in is `externalId`, and the Foursquare id it carries is this. */
  readonly rowExternalId?: string | undefined;
  /** The moment, milliseconds since the epoch. */
  readonly at: number;
  /** The zone it was made in, and its offset then in minutes; absent, they are found from the place's point. */
  readonly tz?: string | undefined;
  readonly offsetMin?: number | undefined;
  readonly note?: string | undefined;
  readonly companions?: readonly string[] | undefined;
  /** How it was made; absent, the source's own (`import:swarm` for Swarm's). A Waymark file keeps what each check-in was. */
  readonly source?: CheckinSource | undefined;
  /** Its photos, at most ten: stored for the person **before** the check-in is made, one at a time; one that cannot be stored is left off the check-in and counted. */
  readonly photos?: readonly ImportPhoto[] | undefined;
  readonly place: {
    /** The service's own id for the place, kept on it as its source's id (a Foursquare venue's, an OpenStreetMap node's). Absent for a place that has none. */
    readonly sourceId?: string | undefined;
    /** What makes the place one place however often it is checked in at, so that a second run makes none: the service's own id for it. It is the `sourceId` unless that is not the same thing (a Waymark file's own id for the place). */
    readonly key?: string | undefined;
    readonly name: string;
    readonly lat: number;
    readonly lng: number;
    readonly address?: Address | undefined;
    readonly category?: string | undefined;
    /** Where the place came from; absent, `import`. */
    readonly source?: PlaceSource | undefined;
    readonly tz?: string | undefined;
  };
}

/** A place of an export, as a reader finds it. */
export type ImportPlace = ImportItem['place'];

export interface CheckinsRead {
  readonly items: readonly ImportItem[];
  /** Places with no check-in, which a file may also hold (a place made and never checked in at): after its check-ins, in steps of their own. Made once, by the same rules, and counted as places. */
  readonly places?: readonly ImportPlace[] | undefined;
  /** Where to carry on from, which the job keeps. */
  readonly cursor: number;
  readonly done: boolean;
  /** Entries the reader read and could not turn into a check-in (counted, never shown). */
  readonly unreadable?: number;
}

/** A file the job has refused: **the sentence a person is shown**, which says what to do and repeats nothing from the file. A reader throws this for a file that is not its format or is from a newer version. */
export class ImportRefusal extends Error {
  override name = 'ImportRefusal';
  constructor(readonly sentence: string) {
    super('the import was refused');
  }
}

/** A reader's hold on one file for one run of the job: opened once, so that a format that must be opened whole (a ZIP's directory) is not opened for every step. */
export interface ReaderSession {
  /** The trips a file also holds (a Waymark file's, 15.3), once the check-ins are in: made whole or not at all, once. A format with none has no such method. */
  trips?(): Promise<TripSource | undefined>;
  /** The check-ins after `cursor`, at most `limit`. Throws for a file that cannot be read, and an `ImportRefusal` for one it will not take. */
  checkins(input: { cursor: number; limit: number }): Promise<CheckinsRead>;
  close(): Promise<void>;
}

export interface ImportReader {
  readonly source: ImportSource;
  /** Opens the file, and **checks all of it before anything is made** if the format can be (a Waymark file is). Throws an `ImportRefusal` for a file it will not take. */
  open(file: ImportFile, context: { now: () => number }): Promise<ReaderSession>;
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
  /** The media store, for the photos of a file that has some. Without it a photo is left off, counted as one that could not be stored. */
  readonly media?: MediaDeps | undefined;
  /** How notices also reach people on this server (email, if there is mail). */
  readonly delivery?: () => Delivery;
  /** Removes photos' files that left a check-in; unused by an import, passed through to the write path. */
  readonly release?: ApplyDeps['release'];
}

const table = (database: Database) =>
  database.dialect === 'postgres' ? postgresSchema.importJob : sqliteSchema.importJob;
const named = (database: Database, name: string) =>
  sql.raw(database.dialect === 'postgres' ? `waymark.${name}` : name);

export { idFor, type IdKind } from './ids';

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
  readonly photos: number;
  readonly photosFailed: number;
}

const SOURCE_OF: Readonly<Record<ImportSource, CheckinSource>> = {
  swarm: 'import:swarm',
  waymark: 'manual',
};

/**
 * Makes what a batch says, as one mutation through the write path. An item that is not a valid place or check-in is skipped (counted), one that is already here or was deleted by the person is left alone
 * (counted), and a mutation the write path refuses skips its items (counted) without stopping the import: a person's file is not thrown away for one bad line.
 */
export async function applyBatch(
  deps: ImportDeps,
  job: Pick<Claimed, 'id' | 'accountId' | 'source'>,
  cursor: number,
  items: readonly ImportItem[],
  alone: readonly ImportPlace[] = [],
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
    const key = item.place.key ?? item.place.sourceId ?? '';
    const place = placeRowOf({
      name: item.place.name,
      lat: item.place.lat,
      lng: item.place.lng,
      address: item.place.address,
      category: item.place.category,
      sourceId: item.place.sourceId,
      source: item.place.source ?? 'import',
      tz: item.place.tz,
    });
    if (!place.ok || item.externalId === '' || key === '') {
      skipped += 1;
      continue;
    }
    prepared.push({
      placeId: idFor('place', job.accountId, key),
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
  // Places that have no check-in in the file: made if they are not here, by the same id a check-in's place would have.
  const lone: { placeId: string; place: ReturnType<typeof placeRowOf> }[] = [];
  for (const each of alone) {
    const key = each.key ?? each.sourceId ?? '';
    const place = placeRowOf({
      name: each.name,
      lat: each.lat,
      lng: each.lng,
      address: each.address,
      category: each.category,
      sourceId: each.sourceId,
      source: each.source ?? 'import',
      tz: each.tz,
    });
    if (!place.ok || key === '') {
      skipped += 1;
      continue;
    }
    lone.push({ placeId: idFor('place', job.accountId, key), place });
  }
  const haveLone = await existing(
    deps,
    job.accountId,
    'place',
    lone.map((each) => each.placeId),
  );
  const changes: Change[] = [];
  const placed = new Set<string>();
  const made = new Set<string>();
  let checkins = 0;
  let places = 0;
  let photosStored = 0;
  let photosFailed = 0;
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
    const source = each.item.source ?? SOURCE_OF[job.source];
    const photos = each.item.photos ?? [];
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
        source,
        // Kept on the row for Swarm's only: it is what makes a Swarm check-in once; for the rest the id above does.
        ...(source === 'import:swarm'
          ? { externalId: each.item.rowExternalId ?? each.item.externalId }
          : {}),
        ...(photos.length > 0
          ? { photos: photos.map((photo) => idFor('photo', job.accountId, photo.key)) }
          : {}),
      },
      now,
    );
    if (!row.ok) {
      skipped += 1;
      continue;
    }
    // The photos are stored **before** the check-in that names them, only for a check-in that is going to be made (one that is already here is left as it is, with its photos), and one at a time. A
    // photo that cannot be stored is left off the check-in and counted; one stored by an earlier run of this step is stored again as the same file.
    const kept: string[] = [];
    for (const photo of photos) {
      const photoId = idFor('photo', job.accountId, photo.key);
      try {
        if (!deps.media) throw new Error('no media store');
        const bytes = await photo.load();
        const stored = await putMedia(deps.media, {
          accountId: job.accountId,
          kind: 'photo',
          bytes,
          id: photoId,
        });
        if (!stored.ok) throw new Error(stored.reason);
        kept.push(photoId);
        photosStored += 1;
      } catch {
        photosFailed += 1;
      }
    }
    const { photos: _all, ...withoutPhotos } = row.value;
    const value = kept.length > 0 ? { ...withoutPhotos, photos: kept } : withoutPhotos;
    if (!havePlaces.has(each.placeId) && !placed.has(each.placeId)) {
      changes.push({ table: 'place', op: 'put', id: each.placeId, row: each.place.value });
      placed.add(each.placeId);
      places += 1;
    }
    changes.push({ table: 'checkin', op: 'put', id: each.checkinId, row: value });
    made.add(each.checkinId);
    checkins += 1;
  }
  for (const each of lone) {
    if (haveLone.has(each.placeId) || placed.has(each.placeId) || !each.place.ok) {
      skipped += 1;
      continue;
    }
    changes.push({ table: 'place', op: 'put', id: each.placeId, row: each.place.value });
    placed.add(each.placeId);
    places += 1;
  }
  if (changes.length === 0) return { checkins: 0, places: 0, skipped, photos: 0, photosFailed };
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
  if (result.status === 'refused')
    return { checkins: 0, places: 0, skipped: skipped + checkins, photos: 0, photosFailed };
  return { checkins, places, skipped, photos: photosStored, photosFailed };
}

const SENTENCES = {
  unreadable:
    'The file could not be read. Check that it is the export that service sent you, and upload it again.',
  unsupported: 'Importing from that service is not available on this server.',
  missing: 'The uploaded file is gone. Upload it again.',
} as const;

/** Ends an import that cannot go on: the file is deleted, the person is told in the bell (and by email where they want it), and the reason is sealed as a sentence of ours. */
async function fail(deps: ImportDeps, job: Claimed, sentence: string): Promise<void> {
  const now = deps.now();
  const sealed = deps.sealer.seal('import_job', job.id, {
    errors: [{ sentence, count: 1 }],
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
          detail: sentence,
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
    const rows = await dbAll<{
      done: number | string;
      skipped: number | string;
      trips: number | string;
    }>(
      tx,
      sql`UPDATE ${table(tx)} SET status = 'done', finished_at = ${now}, claimed_until = 0, updated_at = ${now}
          WHERE id = ${job.id} AND status = 'running' RETURNING checkins_done AS done, checkins_skipped AS skipped, trips_made AS trips`,
    );
    const row = rows[0];
    if (!row) return;
    const done = Number(row.done);
    const skipped = Number(row.skipped);
    const trips = Number(row.trips);
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
          detail: `${done.toLocaleString('en-GB')} ${done === 1 ? 'check-in was' : 'check-ins were'} added${trips > 0 ? `, with ${trips.toLocaleString('en-GB')} ${trips === 1 ? 'trip' : 'trips'}` : ''}${skipped > 0 ? `, and ${skipped.toLocaleString('en-GB')} ${skipped === 1 ? 'was' : 'were'} already here or could not be read` : ''}.`,
          href: '/checkins',
        },
      },
      deps.delivery?.() ?? {},
    );
    // A line on the person's activity page at their core (DESIGN.md §19.4), queued with the rest.
    if (deps.delivery?.().core)
      await enqueueCore(tx, deps.sealer, now, {
        accountId: job.accountId,
        kind: 'activity',
        content: {
          title: `Imported ${done.toLocaleString('en-GB')} ${done === 1 ? 'check-in' : 'check-ins'} into Waymark`,
          path: '/checkins',
          key: `import:${job.id}`,
        },
      });
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
    await fail(deps, job, SENTENCES.unsupported);
    return true;
  }
  const file: ImportFile = {
    stream: () => readImport(deps.dir, job.id, deps.ring),
    materialize: () => materializeImport(deps.dir, job.id, deps.ring, deps.workDir),
  };
  let cursor = job.cursor;
  let session: ReaderSession | undefined;
  /** Ends the import as failed, unless it was cancelled meanwhile (a cancel removes the file under the reader, which is not a failure): with the reader's own sentence if it refused the file. */
  const failed = async (error: unknown): Promise<true> => {
    if (await renew(deps, job.id))
      await fail(deps, job, error instanceof ImportRefusal ? error.sentence : SENTENCES.unreadable);
    return true;
  };
  try {
    for (;;) {
      // Still ours, and not cancelled meanwhile.
      if (!(await renew(deps, job.id))) return true;
      if (deps.now() >= until || signal?.aborted) {
        await release(deps, job.id);
        return false;
      }
      let read: CheckinsRead;
      try {
        // Opened once for the run, at its first step: a format that must be opened whole is not opened for every step, and a file the reader will not take is refused before anything is made.
        session ??= await reader.open(file, { now: deps.now });
        read = await session.checkins({ cursor, limit: STEP_ITEMS });
      } catch (error) {
        return await failed(error);
      }
      const applied = await applyBatch(deps, job, cursor, read.items, read.places);
      cursor = read.cursor;
      const rows = await dbAll<{ id: string }>(
        deps.database,
        sql`UPDATE ${table(deps.database)}
            SET cursor = ${cursor}, checkins_done = checkins_done + ${applied.checkins},
                places_made = places_made + ${applied.places},
                photos_done = photos_done + ${applied.photos},
                photos_failed = photos_failed + ${applied.photosFailed},
                checkins_skipped = checkins_skipped + ${applied.skipped + (read.unreadable ?? 0)},
                updated_at = ${deps.now()}
            WHERE id = ${job.id} AND status = 'running' RETURNING id`,
      );
      if (rows.length === 0) return true;
      if (read.done) {
        // The trips a file also holds, once the check-ins are in so that they fall into them: made whole or not at all, and only once, so a restart here makes none twice.
        if (session.trips) {
          try {
            const source = await session.trips();
            if (source) {
              const done = await importTrips(
                { database: deps.database, sealer: deps.sealer, now: deps.now, media: deps.media },
                job.accountId,
                source,
              );
              await dbAll(
                deps.database,
                sql`UPDATE ${table(deps.database)} SET trips_made = trips_made + ${done.made}, photos_failed = photos_failed + ${done.attachmentsFailed}, updated_at = ${deps.now()}
                    WHERE id = ${job.id} AND status = 'running' RETURNING id`,
              );
            }
          } catch (error) {
            return await failed(error);
          }
        }
        await finish(deps, job);
        return true;
      }
    }
  } finally {
    await session?.close().catch(() => undefined);
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
