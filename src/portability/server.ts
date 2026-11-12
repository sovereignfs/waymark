import { getConfig } from '../config/current';
import { serverSealer } from '../crypto/server';
import { getDatabase } from '../db/boot';
import { serverMedia } from '../media/server';
import { noticeDelivery } from '../notices/server';
import { type ExportDeps, exportDirOf } from './export';

/** The export as the server runs it: this process's database, instance key and data directory, and the media store the photos are read from. */
export async function serverExport(now: () => number = Date.now): Promise<ExportDeps> {
  const config = getConfig();
  return {
    database: await getDatabase(),
    sealer: serverSealer(),
    ring: config.encryption,
    dir: exportDirOf(config.media.dataDir),
    media: { ...(await serverMedia()), now },
    now,
    core: noticeDelivery().core === true,
  };
}
