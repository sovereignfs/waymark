import type { Config } from '../config';
import { getDatabase } from '../db/boot';
import { RateLimiter } from '../limits/rate';
import { serverMedia } from '../media/server';
import { sweepOrphans } from '../media/service';
import { sweepUnattachedPhotos } from '../checkins/photos';
import { pruneHistory } from '../sync/history';
import { serverMap } from '../map/server';
import { nameWaitingPlaces } from '../places/naming';
import { serverFind } from '../places/server';
import { claimJob } from './claim';
import { JobRunner, realDeps, type JobDefinition, type RunnerDeps } from './runner';

/**
 * Every job the app has. Each task that has one adds it here: the import (8.1), the mail outbox (12.2), pruning (6.7), reminders (13.4), the media
 * orphan sweep (3.2) and the map cache (4.3).
 */
export const jobs: readonly JobDefinition[] = [
  {
    // The counts of rate limits whose window is long over go (`src/limits/rate.ts`). It has no row to claim, so a process takes the lease first (`claimJob`):
    // of several that share a database, one sweeps each hour, and a process killed holding the lease costs the hour.
    name: 'sweep-rate-buckets',
    everyMs: 60 * 60 * 1000,
    runAtStart: true,
    run: async ({ now }) => {
      const database = await getDatabase();
      if (!(await claimJob(database, 'sweep-rate-buckets', 55 * 60 * 1000, now.getTime()))) return;
      await new RateLimiter(database, () => now.getTime()).sweep();
    },
  },
  {
    // What a crash left in the media store: rows whose file never came, and files with no row (DESIGN.md §18.3). Under a lease like the sweep above, so that one process of
    // several sweeps each hour; and it removes only what is already of no use, so a second one would be harmless too.
    name: 'sweep-media',
    everyMs: 60 * 60 * 1000,
    runAtStart: true,
    run: async ({ now }) => {
      const media = await serverMedia();
      if (!(await claimJob(media.database, 'sweep-media', 55 * 60 * 1000, now.getTime()))) return;
      const swept = await sweepOrphans({ ...media, now: () => now.getTime() });
      const unattached = await sweepUnattachedPhotos({ ...media, now: () => now.getTime() });
      if (unattached > 0)
        console.info(`[waymark] media: swept ${unattached} photos that no check-in names`);
      if (swept.rows + swept.files > 0)
        console.info(
          `[waymark] media: swept ${swept.rows} rows and ${swept.files} files with no use`,
        );
    },
  },
  {
    // The map's cache is kept under its limit (DESIGN.md §8.1): what was read longest ago goes first. Under a lease, so that one process of several prunes each ten minutes.
    name: 'prune-map-cache',
    everyMs: 10 * 60 * 1000,
    runAtStart: false,
    run: async ({ now }) => {
      const map = serverMap();
      if (map.limits.source !== 'proxy') return;
      const database = await getDatabase();
      if (!(await claimJob(database, 'prune-map-cache', 9 * 60 * 1000, now.getTime()))) return;
      const pruned = await map.diskCache.prune(map.limits.cacheMaxBytes, now.getTime());
      if (pruned.files > 0)
        console.info(`[waymark] map: pruned ${pruned.files} files from the cache`);
    },
  },
  {
    // Places made from a point alone are named by reverse lookup once they have reached the server (DESIGN.md §9.2), a few at a time, under a lease of their own.
    name: 'name-places',
    everyMs: 60 * 1000,
    runAtStart: false,
    run: async ({ now }) => {
      const find = await serverFind();
      const named = await nameWaitingPlaces({
        database: find.database,
        sealer: find.sealer,
        finder: find.finder,
        now: () => now.getTime(),
      });
      if (named > 0) console.info(`[waymark] places: named ${named} from where they are`);
    },
  },
  {
    // Tombstones and the record of applied mutations are kept for ninety days (DESIGN.md §15.8); a device behind the floor that pruning raises is given a fresh snapshot. Under a lease, so that one
    // process of several prunes each six hours.
    name: 'prune-history',
    everyMs: 6 * 60 * 60 * 1000,
    runAtStart: false,
    run: async ({ now }) => {
      const database = await getDatabase();
      if (!(await claimJob(database, 'prune-history', 5 * 60 * 60 * 1000, now.getTime()))) return;
      const pruned = await pruneHistory(database, now.getTime());
      if (pruned.tombstones + pruned.mutations > 0)
        console.info(
          `[waymark] sync: pruned ${pruned.tombstones} tombstones and ${pruned.mutations} mutation records`,
        );
    },
  },
];

/**
 * Starts the jobs, or says why not. `WAYMARK_WORKER=off` runs nothing in this process: when several share a database, one runs the jobs and the
 * others only serve (DESIGN.md §5). Returns the runner, so that the server can stop it.
 */
export function startJobs(
  config: Pick<Config, 'worker'>,
  definitions: readonly JobDefinition[] = jobs,
  deps: RunnerDeps = realDeps,
): JobRunner | undefined {
  if (!config.worker) {
    deps.log('[waymark] jobs: off in this process (WAYMARK_WORKER=off)');
    return undefined;
  }
  const runner = new JobRunner(deps);
  for (const job of definitions) runner.register(job);
  runner.start();
  deps.log(
    `[waymark] jobs: running ${definitions.length} job${definitions.length === 1 ? '' : 's'}`,
  );
  return runner;
}
