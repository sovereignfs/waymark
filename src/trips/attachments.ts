import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { ATTACHMENT_READERS, EDITORS, memberOf, tableOf } from '../access/trip';
import type { Database } from '../db/client';
import { dbAll, dbGet, transaction } from '../db/exec';
import { readSealed, removeFile } from '../media/files';
import { type MediaDeps, SENTENCES, type Refusal, putTripMedia, readMedia } from '../media/service';
import { readSharedPhoto } from '../sharing/read';
import { recordGone } from './gone';
import { TRIP_ID } from './format';
import type { TripDeps } from './trips';

/**
 * A trip's attachments (DESIGN.md §10.6, §11.1): a receipt, a booking, an accommodation record, a ticket or something else, **a file** (a PDF kept as it is, or an image re-encoded with a thumbnail, up to 15 MB, judged by its
 * bytes) with a title and a kind, on the trip or on one day.
 *
 * **Organizers and Travelers add, see, rename, move and delete them, and Followers never do** (bookings carry names, numbers and addresses): every statement here names `ATTACHMENT_READERS` or `EDITORS` (`src/access/trip.ts`), so for a
 * Follower, a person who left and a stranger the row, the file and the thumbnail are not there, and the answer is the one for none. A change is **one transaction that begins with the guarded `UPDATE trip`** that shows the caller
 * may and takes the trip's row; what is written after it is stamped with the trip's counter. The file is stored first and the row last, in the statement that carries the permission, and **a file whose row was not made is removed**
 * (what a crash leaves, the orphan sweep finds). **The title is sealed**; the file is sealed on disk under its own data key. Uploaded online only (§15.7).
 */
export const ATTACHMENT_KINDS = ['receipt', 'booking', 'accommodation', 'ticket', 'other'] as const;
export type AttachmentKind = (typeof ATTACHMENT_KINDS)[number];
export const ATTACHMENT_TITLE_MAX = 200;

export interface AttachmentDeps extends TripDeps {
  /** The media store the files are in. */
  readonly media: MediaDeps;
}

export interface AttachmentView {
  readonly id: string;
  /** The day it is on, or null for the trip. */
  readonly dayId: string | null;
  readonly kind: AttachmentKind;
  readonly title: string;
  /** The file's id, for `GET /api/media/<id>`, and its thumbnail's when it is an image. */
  readonly fileId: string;
  readonly thumbId: string | null;
  readonly type: string;
  readonly bytes: number;
  readonly createdBy: string | null;
  readonly createdAt: number;
  readonly seq: number;
}

/** What an attachment would not take, with a sentence of its own that repeats nothing typed or in the file. */
export class AttachmentRefused extends Error {
  override name = 'AttachmentRefused';
  constructor(
    readonly reason: 'invalid' | 'limit' | Refusal,
    readonly sentence: string,
  ) {
    super(sentence);
  }
}

const bytes = (value: Uint8Array | ArrayBuffer): Uint8Array =>
  value instanceof Uint8Array ? value : new Uint8Array(value);

function cleanTitle(title: unknown): string {
  const trimmed = typeof title === 'string' ? title.trim() : '';
  if (trimmed === '' || trimmed.length > ATTACHMENT_TITLE_MAX || /[\r\n]/.test(trimmed))
    throw new AttachmentRefused(
      'invalid',
      `An attachment's title is 1 to ${ATTACHMENT_TITLE_MAX} characters on one line.`,
    );
  return trimmed;
}

function cleanKind(kind: unknown): AttachmentKind {
  if (kind === undefined || kind === null) return 'other';
  if (typeof kind === 'string' && (ATTACHMENT_KINDS as readonly string[]).includes(kind))
    return kind as AttachmentKind;
  throw new AttachmentRefused(
    'invalid',
    `An attachment's kind is one of ${ATTACHMENT_KINDS.join(', ')}.`,
  );
}

const tooMany = (limit: number) =>
  new AttachmentRefused('limit', `A trip has at most ${limit} attachments on this server.`);

/** Removes the file and thumbnail of an attachment whose row is not there (or is gone): the rows, named by trip and id, and then the files. */
async function discard(
  media: MediaDeps,
  tripId: string,
  ids: readonly (string | null)[],
): Promise<void> {
  for (const id of ids) {
    if (!id) continue;
    await dbAll(
      media.database,
      sql`DELETE FROM ${tableOf(media.database, 'media')} WHERE id = ${id} AND trip_id = ${tripId} RETURNING id`,
    );
    await removeFile(media.dir, id);
  }
}

interface Row {
  id: string;
  dayId: string | null;
  kind: string;
  mediaId: string;
  thumbId: string | null;
  seq: number | string;
  createdBy: string | null;
  sealed: Uint8Array | ArrayBuffer;
  createdAt: number | string;
  type: string;
  bytes: number | string;
}

const COLUMNS = sql.raw(
  `a.id, a.day_id AS "dayId", a.kind, a.media_id AS "mediaId", a.thumb_id AS "thumbId", a.seq, a.created_by AS "createdBy", a.sealed, a.created_at AS "createdAt", m.type, m.bytes`,
);

function viewOf(deps: TripDeps, row: Row): AttachmentView {
  return {
    id: row.id,
    dayId: row.dayId,
    kind: row.kind as AttachmentKind,
    title: deps.sealer.unseal('attachment', row.id, bytes(row.sealed)).title,
    fileId: row.mediaId,
    thumbId: row.thumbId,
    type: row.type,
    bytes: Number(row.bytes),
    createdBy: row.createdBy,
    createdAt: Number(row.createdAt),
    seq: Number(row.seq),
  };
}

/** The attachments of a trip, as Organizers and Travelers may read them: `undefined` for a Follower, a former member and a stranger (the trip, for them, has none to say). Oldest first. */
export async function listAttachments(
  deps: TripDeps,
  accountId: string,
  tripId: string,
): Promise<AttachmentView[] | undefined> {
  if (!TRIP_ID.test(tripId)) return undefined;
  const { database } = deps;
  const allowed = await dbGet<{ id: string }>(
    database,
    sql`SELECT t.id AS id FROM ${tableOf(database, 'trip')} t WHERE t.id = ${tripId} AND ${memberOf(database, sql`t.id`, accountId, ATTACHMENT_READERS)}`,
  );
  if (!allowed) return undefined;
  const rows = await dbAll<Row>(
    database,
    sql`SELECT ${COLUMNS} FROM ${tableOf(database, 'attachment')} a
        JOIN ${tableOf(database, 'media')} m ON m.id = a.media_id AND m.trip_id = a.trip_id
        WHERE a.trip_id = ${tripId} AND ${memberOf(database, sql`a.trip_id`, accountId, ATTACHMENT_READERS)}
        ORDER BY a.created_at, a.id`,
  );
  return rows.map((row) => viewOf(deps, row));
}

/** A day of this trip, for an attachment to be on: not another trip's. */
async function dayOk(tx: Database, tripId: string, dayId: string | null): Promise<boolean> {
  if (dayId === null) return true;
  const found = await dbGet<{ id: string }>(
    tx,
    sql`SELECT id FROM ${tableOf(tx, 'day')} WHERE id = ${dayId} AND trip_id = ${tripId}`,
  );
  return found !== undefined;
}

const dayIdOf = (value: unknown): string | null | 'bad' =>
  value === undefined || value === null
    ? null
    : typeof value === 'string' && TRIP_ID.test(value)
      ? value
      : 'bad';

export interface NewAttachment {
  readonly bytes: Uint8Array;
  readonly title: unknown;
  readonly kind?: unknown;
  readonly dayId?: unknown;
}

/**
 * Adds an attachment to a trip, or to one of its days: **Organizers and Travelers**. Throws `AttachmentRefused` for a value that is not an attachment's, for a file the store would not take (the store's own sentence), and past the trip's
 * limit; returns `undefined` for a trip the caller cannot add to. The file is not stored for a caller who may not add one.
 */
export async function addAttachment(
  deps: AttachmentDeps,
  accountId: string,
  tripId: string,
  input: NewAttachment,
): Promise<AttachmentView | undefined> {
  if (!TRIP_ID.test(tripId)) return undefined;
  const title = cleanTitle(input.title);
  const kind = cleanKind(input.kind);
  const dayId = dayIdOf(input.dayId);
  if (dayId === 'bad') throw new AttachmentRefused('invalid', 'That is not a day of this trip.');
  const limit = deps.limits.tripAttachments;
  const countSql = (db: Database) =>
    sql`SELECT COUNT(*) AS n FROM ${tableOf(db, 'attachment')} WHERE trip_id = ${tripId}`;

  // Before anything is stored: may the caller add one, is there room, is the day this trip's.
  const before = await dbGet<{ id: string }>(
    deps.database,
    sql`SELECT t.id AS id FROM ${tableOf(deps.database, 'trip')} t WHERE t.id = ${tripId} AND ${memberOf(deps.database, sql`t.id`, accountId, EDITORS)}`,
  );
  if (!before) return undefined;
  if (
    Number((await dbGet<{ n: number | string }>(deps.database, countSql(deps.database)))?.n ?? 0) >=
    limit
  )
    throw tooMany(limit);
  if (!(await dayOk(deps.database, tripId, dayId)))
    throw new AttachmentRefused('invalid', 'That is not a day of this trip.');

  const stored = await putTripMedia(deps.media, { tripId, bytes: input.bytes });
  if (!stored.ok) throw new AttachmentRefused(stored.reason, SENTENCES[stored.reason]);
  const id = randomUUID();
  const now = deps.now();
  let outcome: 'added' | 'not_allowed' | 'full' | 'bad_day';
  try {
    outcome = await transaction(deps.database, async (tx) => {
      // The statement that carries the permission, now that the file is stored: if the caller was lowered meanwhile, nothing is added.
      const touched = await dbAll<{ seq: number | string }>(
        tx,
        sql`UPDATE ${tableOf(tx, 'trip')} SET seq = seq + 1, updated_at = ${now}
            WHERE id = ${tripId} AND ${memberOf(tx, sql`${tripId}`, accountId, EDITORS)}
            RETURNING seq`,
      );
      const seq = touched[0] ? Number(touched[0].seq) : undefined;
      if (seq === undefined) return 'not_allowed' as const;
      if (Number((await dbGet<{ n: number | string }>(tx, countSql(tx)))?.n ?? 0) >= limit)
        return 'full' as const;
      if (!(await dayOk(tx, tripId, dayId))) return 'bad_day' as const;
      await dbAll(
        tx,
        sql`INSERT INTO ${tableOf(tx, 'attachment')} (id, trip_id, day_id, kind, media_id, thumb_id, seq, created_by, sealed, created_at)
            VALUES (${id}, ${tripId}, ${dayId}, ${kind}, ${stored.id}, ${stored.thumbId ?? null}, ${seq}, ${accountId},
                    ${deps.sealer.seal('attachment', id, { title })}, ${now})
            RETURNING id`,
      );
      return 'added' as const;
    });
  } catch (error) {
    await discard(deps.media, tripId, [stored.id, stored.thumbId ?? null]);
    throw error;
  }
  if (outcome !== 'added') {
    await discard(deps.media, tripId, [stored.id, stored.thumbId ?? null]);
    if (outcome === 'not_allowed') return undefined;
    if (outcome === 'full') throw tooMany(limit);
    throw new AttachmentRefused('invalid', 'That is not a day of this trip.');
  }
  return (await listAttachments(deps, accountId, tripId))?.find((each) => each.id === id);
}

export interface AttachmentPatch {
  readonly title?: unknown;
  readonly kind?: unknown;
  /** The day it is on, or `null` for the trip. */
  readonly dayId?: unknown;
}

/** Renames an attachment, changes its kind, or moves it to another day of the trip (or to the trip): **Organizers and Travelers**. `undefined` for one the caller cannot change or that is not this trip's. */
export async function updateAttachment(
  deps: AttachmentDeps,
  accountId: string,
  tripId: string,
  attachmentId: string,
  patch: AttachmentPatch,
): Promise<AttachmentView | undefined> {
  if (!TRIP_ID.test(tripId) || !TRIP_ID.test(attachmentId)) return undefined;
  if (!('title' in patch || 'kind' in patch || 'dayId' in patch))
    throw new AttachmentRefused('invalid', 'There is nothing to change.');
  const title = 'title' in patch ? cleanTitle(patch.title) : undefined;
  const kind = 'kind' in patch ? cleanKind(patch.kind) : undefined;
  const dayId = 'dayId' in patch ? dayIdOf(patch.dayId) : undefined;
  if (dayId === 'bad') throw new AttachmentRefused('invalid', 'That is not a day of this trip.');
  const now = deps.now();
  const done = await transaction(deps.database, async (tx) => {
    const touched = await dbAll<{ seq: number | string }>(
      tx,
      sql`UPDATE ${tableOf(tx, 'trip')} SET seq = seq + 1, updated_at = ${now}
          WHERE id = ${tripId} AND ${memberOf(tx, sql`${tripId}`, accountId, EDITORS)}
          RETURNING seq`,
    );
    const seq = touched[0] ? Number(touched[0].seq) : undefined;
    if (seq === undefined) return 'none' as const;
    const row = await dbGet<{
      kind: string;
      dayId: string | null;
      sealed: Uint8Array | ArrayBuffer;
    }>(
      tx,
      sql`SELECT kind, day_id AS "dayId", sealed FROM ${tableOf(tx, 'attachment')} WHERE id = ${attachmentId} AND trip_id = ${tripId}`,
    );
    if (!row) return 'none' as const;
    if (dayId !== undefined && !(await dayOk(tx, tripId, dayId))) return 'bad_day' as const;
    const current = deps.sealer.unseal('attachment', attachmentId, bytes(row.sealed));
    await dbAll(
      tx,
      sql`UPDATE ${tableOf(tx, 'attachment')}
          SET kind = ${kind ?? row.kind}, day_id = ${dayId === undefined ? row.dayId : dayId}, seq = ${seq},
              sealed = ${deps.sealer.seal('attachment', attachmentId, { title: title ?? current.title })}
          WHERE id = ${attachmentId} AND trip_id = ${tripId} RETURNING id`,
    );
    return 'changed' as const;
  });
  if (done === 'bad_day') throw new AttachmentRefused('invalid', 'That is not a day of this trip.');
  if (done === 'none') return undefined;
  return (await listAttachments(deps, accountId, tripId))?.find((each) => each.id === attachmentId);
}

/** Deletes an attachment and its file and thumbnail: **Organizers and Travelers**. The row goes in the transaction, and the files after it. Returns whether there was one the caller may delete. */
export async function deleteAttachment(
  deps: AttachmentDeps,
  accountId: string,
  tripId: string,
  attachmentId: string,
): Promise<boolean> {
  if (!TRIP_ID.test(tripId) || !TRIP_ID.test(attachmentId)) return false;
  const now = deps.now();
  const gone = await transaction(deps.database, async (tx) => {
    const touched = await dbAll<{ seq: number | string }>(
      tx,
      sql`UPDATE ${tableOf(tx, 'trip')} SET seq = seq + 1, updated_at = ${now}
          WHERE id = ${tripId} AND ${memberOf(tx, sql`${tripId}`, accountId, EDITORS)}
          RETURNING seq`,
    );
    if (!touched[0]) return undefined;
    const rows = await dbAll<{ mediaId: string; thumbId: string | null }>(
      tx,
      sql`DELETE FROM ${tableOf(tx, 'attachment')} WHERE id = ${attachmentId} AND trip_id = ${tripId}
          RETURNING media_id AS "mediaId", thumb_id AS "thumbId"`,
    );
    if (rows[0])
      await recordGone(tx, tripId, 'attachment', [attachmentId], Number(touched[0].seq), now);
    return rows[0];
  });
  if (!gone) return false;
  await discard(deps.media, tripId, [gone.mediaId, gone.thumbId]);
  return true;
}

/**
 * A file of an attachment, for a person who may see attachments, and for nobody else: **one statement joins the file to its attachment and to the caller's membership as an Organizer or Traveler**, so for a Follower, a former
 * member and a stranger the file and its thumbnail are not there, and that is all they are told. This is what `/api/media/<id>` falls back to after the caller's own files.
 */
export async function readAttachmentFile(
  deps: Pick<AttachmentDeps, 'database' | 'media'>,
  accountId: string,
  fileId: string,
): Promise<{ type: string; bytes: Buffer } | undefined> {
  const { database, media } = deps;
  const row = await dbGet<{ type: string; id: string }>(
    database,
    sql`SELECT m.type AS type, m.id AS id FROM ${tableOf(database, 'media')} m
        JOIN ${tableOf(database, 'attachment')} a ON a.trip_id = m.trip_id AND (a.media_id = m.id OR a.thumb_id = m.id)
        WHERE m.id = ${fileId} AND m.state = 'ready' AND ${memberOf(database, sql`a.trip_id`, accountId, ATTACHMENT_READERS)}`,
  );
  if (!row) return undefined;
  const content = await readSealed(media.dir, row.id, media.ring);
  return content ? { type: row.type, bytes: content } : undefined;
}

/**
 * The file `/api/media/<id>` serves to an account: **its own first, then a file of an attachment of a trip it may see attachments of, then a photo of a check-in shared with a trip it is in**. A person's own files are named by the account in their statement, so a trip's
 * file is never found that way (it has no account), and an attachment's file is found only through the attachment and the caller's membership: for a Follower, a former member and a stranger there is no such file.
 */
export async function readFileFor(
  media: MediaDeps,
  accountId: string,
  fileId: string,
): Promise<{ type: string; bytes: Buffer } | undefined> {
  return (
    (await readMedia(media, { accountId, id: fileId })) ??
    (await readAttachmentFile({ database: media.database, media }, accountId, fileId)) ??
    // A photo of a check-in someone shared with a trip this account is in (DESIGN.md §11.3): Followers see these too.
    (await readSharedPhoto(media, accountId, fileId))
  );
}
