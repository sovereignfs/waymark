import type { Config } from '../config';
import { getDatabase } from '../db/boot';
import { RateLimiter } from '../limits/rate';
import { serverMedia } from '../media/server';
import { sweepOrphans } from '../media/service';
import { sweepUnattachedPhotos } from '../checkins/photos';
import { rotateKeys } from '../crypto/rotate';
import { serverRotation } from '../crypto/server-rotation';
import { serverImport } from '../import/server';
import { dropStaleCore, sendDueCore } from '../sovereign/outbox';
import { serverCoreOutbox } from '../sovereign/server-core';
import { sweepExports, workOnExports } from '../portability/export';
import { serverExport } from '../portability/server';
import { sweepImports } from '../import/service';
import { workOnImports } from '../import/job';
import { forgetSeen } from '../sovereign/verifiers';
import { dropStale, sendDue } from '../mail/outbox';
import { serverMailer, serverOutbox } from '../mail/server';
import { pruneNotices } from '../notices/notices';
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
      // The `jti` of core's notices that could no longer be replayed (DESIGN.md §19.2).
      await forgetSeen(database, now.getTime());
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
      // An export that has run out is deleted, and what a worker that died left (DESIGN.md §22).
      await sweepExports(await serverExport(() => now.getTime()));
      // What an upload that died left: a file no import names, an import whose file is gone, and old finished ones (DESIGN.md §16).
      const imports = await sweepImports(await serverImport(() => now.getTime()));
      if (imports.files + imports.orphaned + imports.pruned > 0)
        console.info(
          `[waymark] imports: swept ${imports.files} files, ${imports.orphaned} lost, ${imports.pruned} old`,
        );
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
  {
    // Notices are kept 90 days and at most 500 a person (DESIGN.md §17.1). Under a lease, so that one process of several prunes each six hours; removing what is already gone changes nothing.
    name: 'prune-notices',
    everyMs: 6 * 60 * 60 * 1000,
    runAtStart: false,
    run: async ({ now }) => {
      const database = await getDatabase();
      if (!(await claimJob(database, 'prune-notices', 5 * 60 * 60 * 1000, now.getTime()))) return;
      const pruned = await pruneNotices({ database, now: () => now.getTime() });
      if (pruned.old + pruned.over > 0)
        console.info(`[waymark] notices: pruned ${pruned.old + pruned.over}`);
    },
  },
  {
    // Mail waits in the outbox and is sent here (DESIGN.md §17.2): each message is claimed by a lease in the database, so several processes never send one twice, and one that fails is tried again later.
    // It logs how many, and never an address or a word of a message. With no `WAYMARK_SMTP_HOST` there is nothing to send with and nothing is queued.
    name: 'send-mail',
    everyMs: 30 * 1000,
    runAtStart: false,
    run: async ({ now }) => {
      const mailer = serverMailer();
      if (!mailer) return;
      const deps = await serverOutbox(() => now.getTime());
      const pass = await sendDue(deps, mailer);
      const stale = await dropStale(deps);
      if (pass.retry + pass.gaveUp + stale > 0)
        console.info(
          `[waymark] mail: ${pass.sent} sent, ${pass.retry} to try again, ${pass.gaveUp + stale} given up on`,
        );
    },
  },
  {
    // Imports are worked here (DESIGN.md §16): one is claimed by a lease in the database, worked in short steps with a cursor kept after each, and given up at the end of the budget so that the next run, or
    // another process, carries on. It runs at the start, so that an import a deploy interrupted carries on at once. It logs ids and counts, never a place, a name or a line of the file.
    name: 'import',
    everyMs: 10 * 1000,
    runAtStart: true,
    run: async ({ signal }) => {
      const worked = await workOnImports(await serverImport(), { signal });
      if (worked.ended > 0) console.info(`[waymark] imports: ${worked.ended} ended`);
    },
  },
  {
    // Exports are built here (DESIGN.md §22): one is claimed by a lease in the database, streamed into a sealed file, and marked ready for a day. It logs ids and counts, never what is in a file.
    name: 'export',
    everyMs: 15 * 1000,
    runAtStart: true,
    run: async ({ signal }) => {
      const deps = await serverExport();
      while (!signal.aborted && (await workOnExports(deps)));
    },
  },
  {
    // A rotation of the instance key (DESIGN.md §18.1): with `WAYMARK_ENCRYPTION_KEY_PREVIOUS` given, every envelope is moved to the new key, from where it left off, under a lease so that one process of several does
    // it. It does nothing without a previous key. It logs how many it moved and could not open, never what they were.
    name: 'rotate-keys',
    everyMs: 30 * 1000,
    runAtStart: true,
    run: async ({ now }) => {
      const deps = await serverRotation(() => now.getTime());
      if (!deps.ring.previous) return;
      if (!(await claimJob(deps.database, 'rotate-keys', 2 * 60 * 1000, now.getTime()))) return;
      const before = Date.now();
      const rotation = await rotateKeys(deps);
      if (rotation.state === 'done')
        console.info(
          `[waymark] keys: rotation complete (${rotation.rewrapped} moved, ${rotation.unopenable} could not be opened); the previous key can be removed`,
        );
      else
        console.info(
          `[waymark] keys: rotating (${rotation.rewrapped} moved so far, ${Date.now() - before} ms)`,
        );
    },
  },
  {
    // Calls to a Sovereign core wait in the outbox and are made here (DESIGN.md §17.2, §19.4): core's bell, core's email and a line on the person's activity page. Each is claimed by a lease so that several processes
    // make one call once, carries a key, and is tried again; an email core will not send goes by Waymark's own mail. Where there is no core there is nothing to do. It logs counts, never a title or a sub.
    name: 'send-core',
    everyMs: 20 * 1000,
    runAtStart: false,
    run: async ({ now }) => {
      const core = await serverCoreOutbox(() => now.getTime());
      if (!core) return;
      const pass = await sendDueCore(core.deps, core.sender);
      const stale = await dropStaleCore(core.deps);
      if (pass.retry + pass.gaveUp + pass.fellBack + stale > 0)
        console.info(
          `[waymark] core: ${pass.sent} sent, ${pass.retry} to try again, ${pass.fellBack} by Waymark's mail, ${pass.gaveUp + stale} given up on`,
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
