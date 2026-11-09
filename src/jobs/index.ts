import type { Config } from '../config';
import { getDatabase } from '../db/boot';
import { RateLimiter } from '../limits/rate';
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
