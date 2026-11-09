/**
 * Background work inside the web process (DESIGN.md §5): the import (8.1), the mail outbox (12.2), reminders (13.4), pruning (6.7) and the sweeps. Fjord decided against a separate
 * worker for the same reason: a single container wants one process, and a second entry point is a second bundle for no behaviour.
 *
 * Several processes may share one database, so a job is written to be run by any of them at once: **the database decides who does a piece of
 * work** (`claim`, in `./claim.ts`), and nothing else coordinates, because SQLite has no lock to coordinate with. Within one process a job never
 * overlaps itself: the next run is scheduled when the last one has ended. A job that throws is logged by its name and the kind of error, never its
 * message, which can hold a title or an address, and it runs again at its next time: one failure stops nothing.
 *
 * The clock is given to the job, not read by it, so that a test calls a job with a time of its choosing and needs no fake timers.
 */
export interface JobContext {
  /** When this run started, from the runner's clock. */
  readonly now: Date;
  /** Aborted when the process is stopping: a job that can stop early should, and one that cannot is waited for, up to the grace period. */
  readonly signal: AbortSignal;
}

export interface JobDefinition {
  /** A stable name, for the log. */
  readonly name: string;
  /** How long after a run ends the next one starts, in milliseconds. */
  readonly everyMs: number;
  /** Start the first run at once and not after `everyMs`. */
  readonly runAtStart?: boolean;
  run(context: JobContext): Promise<void>;
}

/** What the runner needs of the world, all of it replaceable so that the runner can be tested without waiting. */
export interface RunnerDeps {
  now(): Date;
  setTimer(callback: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  log(line: string): void;
}

export const realDeps: RunnerDeps = {
  now: () => new Date(),
  setTimer: (callback, ms) => {
    const handle = setTimeout(callback, ms);
    // A timer alone must not keep the process alive: the server does that.
    handle.unref();
    return handle;
  },
  clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  log: (line) => console.info(line),
};

/** How long a stop waits for runs in flight. Under Docker's own ten seconds to stop a container. */
export const STOP_GRACE_MS = 8000;

/** What may be said about an error: its name and, if it has one, its code, never its message. */
export function kindOf(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === 'string' ? `${error.name} ${code}` : error.name;
  }
  return typeof error;
}

interface Registered {
  job: JobDefinition;
  timer: unknown;
  running: Promise<void> | undefined;
}

export class JobRunner {
  private readonly jobs = new Map<string, Registered>();
  private readonly abort = new AbortController();
  private started = false;
  private stopped = false;

  constructor(private readonly deps: RunnerDeps = realDeps) {}

  register(job: JobDefinition): void {
    if (this.started)
      throw new Error(`The job ${job.name} was registered after the runner started.`);
    if (this.jobs.has(job.name)) throw new Error(`There is already a job called ${job.name}.`);
    if (!Number.isFinite(job.everyMs) || job.everyMs <= 0) {
      throw new Error(`The job ${job.name} needs a positive interval.`);
    }
    this.jobs.set(job.name, { job, timer: undefined, running: undefined });
  }

  /** Starts every job's timer. A second call does nothing. */
  start(): void {
    if (this.started || this.stopped) return;
    this.started = true;
    for (const entry of this.jobs.values()) {
      if (entry.job.runAtStart) void this.runOnce(entry);
      else this.schedule(entry);
    }
  }

  /**
   * Runs a job now, as its timer would, and resolves when the run ends. A job already running is not run again: this resolves when that run
   * ends. Never rejects: a failure is logged.
   */
  runNow(name: string): Promise<void> {
    const entry = this.jobs.get(name);
    if (!entry) return Promise.reject(new Error(`There is no job called ${name}.`));
    return this.runOnce(entry);
  }

  /**
   * Stops the timers at once, aborts the runs in flight and waits for them up to `graceMs`. Resolves to whether they all ended in time. A run
   * that is cut off is safe, because every job claims its work in the database and the next process to run it finds the claim.
   */
  async stop(graceMs = STOP_GRACE_MS): Promise<{ graceful: boolean }> {
    if (this.stopped) return { graceful: true };
    this.stopped = true;
    this.abort.abort();
    const running: Promise<void>[] = [];
    for (const entry of this.jobs.values()) {
      if (entry.timer !== undefined) this.deps.clearTimer(entry.timer);
      entry.timer = undefined;
      if (entry.running) running.push(entry.running);
    }
    if (running.length === 0) return { graceful: true };

    let timer: unknown;
    const expired = new Promise<'late'>((resolve) => {
      timer = this.deps.setTimer(() => resolve('late'), graceMs);
    });
    const result = await Promise.race([Promise.all(running).then(() => 'done' as const), expired]);
    this.deps.clearTimer(timer);
    if (result === 'late') {
      this.deps.log(
        `[waymark] jobs: stopping, and ${running.length} had not ended after ${graceMs} ms`,
      );
    }
    return { graceful: result === 'done' };
  }

  private schedule(entry: Registered): void {
    if (this.stopped) return;
    entry.timer = this.deps.setTimer(() => {
      entry.timer = undefined;
      void this.runOnce(entry);
    }, entry.job.everyMs);
  }

  private runOnce(entry: Registered): Promise<void> {
    // A run never overlaps itself: a call while one is going joins it.
    if (entry.running) return entry.running;
    const run = (async () => {
      try {
        await entry.job.run({ now: this.deps.now(), signal: this.abort.signal });
      } catch (error) {
        this.deps.log(`[waymark] job ${entry.job.name} failed: ${kindOf(error)}`);
      }
    })().finally(() => {
      entry.running = undefined;
      // The next run is scheduled when this one has ended, so one that is slow is not stacked on itself.
      if (this.started) this.schedule(entry);
    });
    entry.running = run;
    return run;
  }
}
