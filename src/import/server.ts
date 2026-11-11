import path from 'node:path';
import { getConfig } from '../config/current';
import { serverSealer } from '../crypto/server';
import { getDatabase } from '../db/boot';
import { noticeDelivery } from '../notices/server';
import { importDirOf } from './files';
import type { ImportDeps } from './job';
import { READERS } from './readers';

/** The import as the server runs it: this process's database, instance key and data directory, the readers this build has, and how notices also reach people here. */
export async function serverImport(now: () => number = Date.now): Promise<ImportDeps> {
  const config = getConfig();
  return {
    database: await getDatabase(),
    sealer: serverSealer(),
    ring: config.encryption,
    dir: importDirOf(config.media.dataDir),
    workDir: path.join(config.media.dataDir, 'tmp'),
    now,
    readers: READERS,
    delivery: noticeDelivery,
  };
}
