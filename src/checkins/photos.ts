import { sql } from 'drizzle-orm';
import type { Database } from '../db/client';
import { dbAll } from '../db/exec';
import { type MediaDeps, deleteMedia } from '../media/service';
import * as postgresSchema from '../db/schema/postgres';
import * as sqliteSchema from '../db/schema/sqlite';

/**
 * What joins a check-in's photos to the media store (DESIGN.md §9.3, §18.3): the files of photos that left a check-in, or went with it, are removed after the transaction that said so
 * (`release`, which `applyMutation` calls), and a photo that was uploaded and **never attached to a check-in** is removed by a sweep, after a long wait, since an upload may well come
 * before the check-in it belongs to (it waits in the device's store, §15.6) and a person may be offline for days.
 */
const schemaOf = (database: Database) =>
  database.dialect === 'postgres' ? postgresSchema : sqliteSchema;

/** The callback for `ApplyDeps.release`: deletes each photo's file and its thumbnail, by owner and id. */
export function releasePhotos(media: MediaDeps) {
  return async (accountId: string, mediaIds: readonly string[]): Promise<void> => {
    for (const id of mediaIds) await deleteMedia(media, { accountId, id });
  };
}

/** How long an uploaded photo may stay with no check-in before the sweep takes it: thirty days. */
export const UNATTACHED_GRACE_MS = 30 * 24 * 60 * 60 * 1000;

/** Removes photos uploaded more than the grace ago that no check-in names, files and thumbnails with them. Returns how many. Safe to run from any process at any time. */
export async function sweepUnattachedPhotos(media: MediaDeps): Promise<number> {
  const s = schemaOf(media.database);
  const cutoff = media.now() - UNATTACHED_GRACE_MS;
  const stray = await dbAll<{ id: string; accountId: string }>(
    media.database,
    sql`SELECT m.id, m.account_id AS "accountId" FROM ${s.media} m
        WHERE m.kind = 'photo' AND m.created_at < ${cutoff}
          AND NOT EXISTS (SELECT 1 FROM ${s.checkinPhoto} p WHERE p.id = m.id)
        ORDER BY m.created_at LIMIT 200`,
  );
  for (const photo of stray) await deleteMedia(media, { accountId: photo.accountId, id: photo.id });
  return stray.length;
}
