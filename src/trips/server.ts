import { getConfig } from '../config/current';
import { serverSealer } from '../crypto/server';
import { getDatabase } from '../db/boot';
import { RateLimiter } from '../limits/rate';
import { serverMedia } from '../media/server';
import { noticeDelivery } from '../notices/server';
import type { OpsDeps } from './endpoint';

/** What trips need as the server runs them: this process's database, instance key and limits. */
export async function serverOps(): Promise<OpsDeps> {
  const database = await getDatabase();
  return {
    database,
    sealer: serverSealer(),
    now: Date.now,
    limits: getConfig().limits,
    // Beyond the bell, as each person chose (DESIGN.md §17.2).
    delivery: noticeDelivery,
    limiter: new RateLimiter(database),
    // Files of a trip's attachments, for a rename's and a deletion's own part.
    media: await serverMedia(),
  };
}
