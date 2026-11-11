import { releasePhotos } from '../checkins/photos';
import { serverSealer } from '../crypto/server';
import { getDatabase } from '../db/boot';
import { RateLimiter } from '../limits/rate';
import { serverMedia } from '../media/server';
import { noticeDelivery } from '../notices/server';
import type { ApplyDeps } from './apply';

/** The sync as the server runs it: this process's database, instance key and media store (the files of photos that leave a check-in are removed after the transaction). */
export async function serverSync(): Promise<ApplyDeps> {
  const media = await serverMedia();
  return {
    database: await getDatabase(),
    sealer: serverSealer(),
    now: Date.now,
    release: releasePhotos(media),
    // The members who chose to hear of a shared check-in, beyond the bell (DESIGN.md §17.1).
    notify: { delivery: noticeDelivery },
  };
}

/** A device syncs after a write, on load, on focus and every thirty seconds while it is open (DESIGN.md §15.3): a hundred and twenty a minute for an account is room for several devices. */
export async function takeSync(accountId: string): Promise<boolean> {
  const limiter = new RateLimiter(await getDatabase());
  const taken = await limiter.take(`sync:${accountId}`, { limit: 120, windowMs: 60_000 });
  return taken.ok;
}
