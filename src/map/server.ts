import { getConfig } from '../config/current';
import { getDatabase } from '../db/boot';
import { RateLimiter } from '../limits/rate';
import { MapService } from './service';

/** The map service lives as long as the process: its notion of the upstream's current tile address, and its tiles in flight, are the process's. */
let service: MapService | undefined;

/** The map as the server runs it: the settings it started with, and a User-Agent naming Waymark and the instance's address and no person. */
export function serverMap(): MapService {
  const config = getConfig();
  service ??= new MapService({
    settings: config.map,
    userAgent: config.url ? `Waymark (${config.url})` : 'Waymark',
  });
  return service;
}

/** The address the browser uses for Waymark, for the whole addresses a style needs: the setting, or the request's own. */
export function originFor(request: Request): string {
  return getConfig().url ?? new URL(request.url).origin;
}

/** Map requests are limited for each account (DESIGN.md §8.1): fifteen hundred a minute, which is a map panned about steadily and not a copy of the planet. */
export async function takeMap(accountId: string): Promise<boolean> {
  const limiter = new RateLimiter(await getDatabase());
  const taken = await limiter.take(`map:${accountId}`, { limit: 1500, windowMs: 60_000 });
  return taken.ok;
}
