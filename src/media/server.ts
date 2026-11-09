import { getConfig } from '../config/current';
import { getDatabase } from '../db/boot';
import { RateLimiter } from '../limits/rate';
import { mediaDirOf } from './files';
import type { MediaDeps } from './service';

/** The media store as the server runs it: this process's database, instance key and data directory, and the limit it was started with. */
export async function serverMedia(): Promise<MediaDeps> {
  const config = getConfig();
  return {
    database: await getDatabase(),
    ring: config.encryption,
    dir: mediaDirOf(config.media.dataDir),
    maxAccountBytes: config.media.maxAccountBytes,
    now: Date.now,
  };
}

/** Uploads are limited for each account (DESIGN.md §25 Security): sixty a minute, which is more than a person takes photos. */
export async function takeUpload(accountId: string): Promise<boolean> {
  const limiter = new RateLimiter(await getDatabase());
  const taken = await limiter.take(`media:upload:${accountId}`, { limit: 60, windowMs: 60_000 });
  return taken.ok;
}
