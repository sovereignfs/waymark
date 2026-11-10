import { getConfig } from '../config/current';
import { getDatabase } from '../db/boot';
import { RateLimiter } from '../limits/rate';
import { serverSealer } from '../crypto/server';
import { PlaceFinder } from './finder';
import type { FindDeps } from './http';

/** The finder lives as long as the process: its day's cache and its in-flight searches are the process's. */
let finder: PlaceFinder | undefined;

/** Place search as the server runs it: the settings it started with, this process's database, and a User-Agent naming Waymark and the instance's address and no person. */
export async function serverFind(): Promise<FindDeps> {
  const config = getConfig();
  const database = await getDatabase();
  finder ??= new PlaceFinder({
    settings: config.places,
    database,
    userAgent: config.url ? `Waymark (${config.url})` : 'Waymark',
  });
  return { database, sealer: serverSealer(), finder };
}

/** Searches are limited for each account (DESIGN.md §25 Security): sixty a minute, which a person typing with a pause between does not reach. */
export async function takeSearch(accountId: string): Promise<boolean> {
  const limiter = new RateLimiter(await getDatabase());
  const taken = await limiter.take(`places:search:${accountId}`, { limit: 60, windowMs: 60_000 });
  return taken.ok;
}
