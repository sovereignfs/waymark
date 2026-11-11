import { getConfig } from '../config/current';
import { getDatabase } from '../db/boot';
import { exportDirOf } from '../portability/export';
import { importDirOf } from '../import/files';
import { mediaDirOf } from '../media/files';
import type { RotateDeps } from './rotate';

/** The rotation as the server runs it: this process's database and key ring (the current key and the previous, if one is given) and the directories of sealed files. */
export async function serverRotation(now: () => number = Date.now): Promise<RotateDeps> {
  const config = getConfig();
  const dataDir = config.media.dataDir;
  return {
    database: await getDatabase(),
    ring: config.encryption,
    dirs: {
      media: mediaDirOf(dataDir),
      imports: importDirOf(dataDir),
      exports: exportDirOf(dataDir),
    },
    now,
  };
}
