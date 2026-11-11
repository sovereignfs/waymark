import { sql } from 'drizzle-orm';
import { MEMBERS, memberOf, tableOf } from '../access/trip';
import type { Sealer } from '../crypto/sealed';
import type { Database } from '../db/client';
import { dbAll, dbGet } from '../db/exec';
import { readSealed, thumbIdOf } from '../media/files';
import type { MediaDeps } from '../media/service';
import { TRIP_ID } from '../trips/format';
import type { SharedBody } from './copies';

/**
 * What the members of a trip are given of the check-ins shared with it (DESIGN.md §11.3, §15.3): **the copies, never the originals**, and only to an active member of the trip, Followers included. The statement names the reader's
 * membership, so a stranger, a former member and a trip that is not there are all the same answer (`undefined`); an author's own copies are left out (the device has them in its own stream), and **a check-in that was not shared
 * has no copy to give**, so there is nothing of it here to leak. Each copy is opened for the reader here, on the server, and nowhere else.
 */
export interface SharedCheckin extends SharedBody {
  readonly id: string;
  readonly authorId: string;
  readonly seq: number;
}

export async function listShared(
  database: Database,
  sealer: Sealer,
  accountId: string,
  tripId: string,
  after = 0,
): Promise<SharedCheckin[] | undefined> {
  if (!TRIP_ID.test(tripId)) return undefined;
  const there = await dbGet<{ id: string }>(
    database,
    sql`SELECT t.id AS id FROM ${tableOf(database, 'trip')} t WHERE t.id = ${tripId} AND ${memberOf(database, sql`t.id`, accountId, MEMBERS)}`,
  );
  if (!there) return undefined;
  const rows = await dbAll<{
    id: string;
    authorId: string;
    seq: number | string;
    sealed: Uint8Array | ArrayBuffer;
  }>(
    database,
    sql`SELECT s.checkin_id AS id, s.account_id AS "authorId", s.seq AS seq, s.sealed AS sealed
        FROM ${tableOf(database, 'shared_checkin')} s
        WHERE s.trip_id = ${tripId} AND s.account_id <> ${accountId} AND s.seq > ${after}
          AND ${memberOf(database, sql`s.trip_id`, accountId, MEMBERS)}
        ORDER BY s.seq, s.checkin_id`,
  );
  return rows.map((row) => ({
    id: row.id,
    authorId: row.authorId,
    seq: Number(row.seq),
    ...(sealer.unseal(
      'shared_checkin',
      row.id,
      row.sealed instanceof Uint8Array ? row.sealed : new Uint8Array(row.sealed),
    ).copy as SharedBody),
  }));
}

/**
 * The file `/api/media/<id>` may serve to an account **as a photo of a shared check-in** (3.2's check, extended): one statement joins the photo to the copy and to the reader's membership of the copy's trip, so a photo of a check-in
 * that is not shared, or shared with a trip the reader is not in, is not there. A thumbnail is found through its photo: its id is derived from the photo's, so the candidates are the author's shared photos that this reader may see.
 * Returns the id of the file to read (the photo's own, or the thumbnail's), or nothing.
 */
export async function sharedPhotoFile(
  database: Database,
  accountId: string,
  fileId: string,
): Promise<{ id: string; type: string } | undefined> {
  const direct = await dbGet<{ id: string; type: string }>(
    database,
    sql`SELECT m.id AS id, m.type AS type FROM ${tableOf(database, 'media')} m
        JOIN ${tableOf(database, 'checkin_photo')} p ON p.id = m.id
        JOIN ${tableOf(database, 'shared_checkin')} s ON s.checkin_id = p.checkin_id AND s.account_id = p.account_id
        WHERE m.id = ${fileId} AND m.state = 'ready' AND ${memberOf(database, sql`s.trip_id`, accountId, MEMBERS)}`,
  );
  if (direct) return direct;
  const thumb = await dbGet<{ id: string; type: string; accountId: string }>(
    database,
    sql`SELECT id, type, account_id AS "accountId" FROM ${tableOf(database, 'media')} WHERE id = ${fileId} AND kind = 'thumb' AND state = 'ready'`,
  );
  if (!thumb) return undefined;
  const photos = await dbAll<{ id: string }>(
    database,
    sql`SELECT p.id AS id FROM ${tableOf(database, 'checkin_photo')} p
        JOIN ${tableOf(database, 'shared_checkin')} s ON s.checkin_id = p.checkin_id AND s.account_id = p.account_id
        WHERE p.account_id = ${thumb.accountId} AND ${memberOf(database, sql`s.trip_id`, accountId, MEMBERS)}`,
  );
  return photos.some((photo) => thumbIdOf(photo.id) === fileId)
    ? { id: thumb.id, type: thumb.type }
    : undefined;
}

/** A photo of a check-in shared with a trip the reader is in, and its thumbnail: the bytes, or nothing. Used by `/api/media/<id>` after the reader's own files and the attachments they may see. */
export async function readSharedPhoto(
  media: MediaDeps,
  accountId: string,
  fileId: string,
): Promise<{ type: string; bytes: Buffer } | undefined> {
  const file = await sharedPhotoFile(media.database, accountId, fileId);
  if (!file) return undefined;
  const content = await readSealed(media.dir, file.id, media.ring);
  return content ? { type: file.type, bytes: content } : undefined;
}
