import { describe, expect, it } from 'vitest';
import { jobs, startJobs } from './index';
import { JobRunner, kindOf, type JobContext, type RunnerDeps } from './runner';

/** A world with no real time in it: timers fire when the test says so, and the clock is the test's. */
function world(start = new Date('2026-11-05T09:00:00Z')) {
  let now = start.getTime();
  let next = 1;
  const timers = new Map<number, { at: number; callback: () => void }>();
  const lines: string[] = [];
  const deps: RunnerDeps = {
    now: () => new Date(now),
    setTimer: (callback, ms) => {
      const id = next++;
      timers.set(id, { at: now + ms, callback });
      return id;
    },
    clearTimer: (handle) => void timers.delete(handle as number),
    log: (line) => void lines.push(line),
  };
  /** Moves the clock on, firing each timer that falls due, in order, and letting what it started run. */
  async function advance(ms: number) {
    const until = now + ms;
    for (;;) {
      const due = [...timers.entries()]
        .filter(([, t]) => t.at <= until)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      timers.delete(due[0]);
      now = Math.max(now, due[1].at);
      due[1].callback();
      await settle();
    }
    now = until;
  }
  return { deps, lines, advance, timers: () => timers.size };
}

/** Lets promises that are already able to run, run. */
const settle = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

/** A promise that the test resolves by hand. */
function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { opened, open };
}

describe('a job runner', () => {
  it('runs nothing until it is started, then runs a job after its interval and again after each run ends', async () => {
    const w = world();
    const runner = new JobRunner(w.deps);
    const runs: number[] = [];
    runner.register({
      name: 'tick',
      everyMs: 1000,
      run: async ({ now }) => void runs.push(now.getTime()),
    });
    await w.advance(5000);
    expect(runs).toEqual([]);
    runner.start();
    await w.advance(999);
    expect(runs).toEqual([]);
    await w.advance(1);
    expect(runs).toHaveLength(1);
    await w.advance(3000);
    expect(runs).toHaveLength(4);
    await runner.stop();
  });

  it('gives a job the time of the runner’s clock, which a test chooses', async () => {
    const w = world(new Date('2026-12-31T23:59:59Z'));
    const runner = new JobRunner(w.deps);
    const seen: string[] = [];
    runner.register({
      name: 'clock',
      everyMs: 1000,
      run: async ({ now }) => void seen.push(now.toISOString()),
    });
    runner.start();
    await w.advance(1000);
    expect(seen).toEqual(['2027-01-01T00:00:00.000Z']);
    await runner.stop();
  });

  it('can start a job at once, when it asks to', async () => {
    const w = world();
    const runner = new JobRunner(w.deps);
    let runs = 0;
    runner.register({
      name: 'now',
      everyMs: 60_000,
      runAtStart: true,
      run: async () => void runs++,
    });
    runner.start();
    await settle();
    expect(runs).toBe(1);
    await runner.stop();
  });

  it('never overlaps a job with itself: the next run is scheduled when the last has ended', async () => {
    const w = world();
    const runner = new JobRunner(w.deps);
    const hold = gate();
    let started = 0;
    runner.register({
      name: 'slow',
      everyMs: 1000,
      run: async () => {
        started++;
        await hold.opened;
      },
    });
    runner.start();
    await w.advance(1000);
    expect(started).toBe(1);
    await w.advance(10_000);
    expect(started).toBe(1);
    hold.open();
    await settle();
    await w.advance(1000);
    expect(started).toBe(2);
    await runner.stop();
  });

  it('logs a job that throws by its name and the kind of error, never the message, and runs it again', async () => {
    const w = world();
    const runner = new JobRunner(w.deps);
    let calls = 0;
    runner.register({
      name: 'flaky',
      everyMs: 1000,
      run: async () => {
        calls++;
        throw Object.assign(
          new TypeError('the title "Call Dr. Rao about the results" and a token'),
          { code: 'EBOOM' },
        );
      },
    });
    runner.start();
    await w.advance(3000);
    expect(calls).toBe(3);
    expect(w.lines[0]).toBe('[waymark] job flaky failed: TypeError EBOOM');
    expect(w.lines.join('\n')).not.toMatch(/Rao|token|title/);
    await runner.stop();
  });

  it('does not let one job’s failure stop another', async () => {
    const w = world();
    const runner = new JobRunner(w.deps);
    let good = 0;
    runner.register({
      name: 'bad',
      everyMs: 1000,
      run: async () => Promise.reject(new Error('x')),
    });
    runner.register({ name: 'good', everyMs: 1000, run: async () => void good++ });
    runner.start();
    await w.advance(2000);
    expect(good).toBe(2);
    await runner.stop();
  });

  it('runs a job on demand, and a second call while it runs joins that run', async () => {
    const w = world();
    const runner = new JobRunner(w.deps);
    const hold = gate();
    let started = 0;
    runner.register({
      name: 'job',
      everyMs: 60_000,
      run: async () => {
        started++;
        await hold.opened;
      },
    });
    const first = runner.runNow('job');
    const second = runner.runNow('job');
    await settle();
    expect(started).toBe(1);
    hold.open();
    await Promise.all([first, second]);
    await expect(runner.runNow('nope')).rejects.toThrow(/no job called nope/);
  });

  describe('registering', () => {
    it('refuses a duplicate, a bad interval, and a job after the start', () => {
      const w = world();
      const runner = new JobRunner(w.deps);
      runner.register({ name: 'a', everyMs: 1000, run: async () => undefined });
      expect(() =>
        runner.register({ name: 'a', everyMs: 1000, run: async () => undefined }),
      ).toThrow(/already/);
      for (const everyMs of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
        expect(() =>
          runner.register({ name: `b${everyMs}`, everyMs, run: async () => undefined }),
        ).toThrow(/interval/);
      }
      runner.start();
      expect(() =>
        runner.register({ name: 'late', everyMs: 1000, run: async () => undefined }),
      ).toThrow(/after the runner started/);
    });
  });

  describe('stopping', () => {
    it('clears every timer at once, so nothing runs after it', async () => {
      const w = world();
      const runner = new JobRunner(w.deps);
      let runs = 0;
      runner.register({ name: 'a', everyMs: 1000, run: async () => void runs++ });
      runner.register({ name: 'b', everyMs: 2000, run: async () => void runs++ });
      runner.start();
      expect(w.timers()).toBe(2);
      await expect(runner.stop()).resolves.toEqual({ graceful: true });
      expect(w.timers()).toBe(0);
      await w.advance(60_000);
      expect(runs).toBe(0);
    });

    it('aborts the signal a job was given, waits for the run in flight and says it ended in time', async () => {
      const w = world();
      const runner = new JobRunner(w.deps);
      let signal: AbortSignal | undefined;
      let finished = false;
      const hold = gate();
      runner.register({
        name: 'slow',
        everyMs: 1000,
        run: async (context: JobContext) => {
          signal = context.signal;
          await hold.opened;
          finished = true;
        },
      });
      runner.start();
      await w.advance(1000);
      const stopped = runner.stop(5000);
      await settle();
      expect(signal?.aborted).toBe(true);
      expect(finished).toBe(false);
      hold.open();
      await expect(stopped).resolves.toEqual({ graceful: true });
      expect(finished).toBe(true);
    });

    it('gives up on a run that outlasts the grace period, says so, and does not start another', async () => {
      const w = world();
      const runner = new JobRunner(w.deps);
      let started = 0;
      runner.register({
        name: 'stuck',
        everyMs: 1000,
        run: async () => {
          started++;
          await new Promise<void>(() => undefined);
        },
      });
      runner.start();
      await w.advance(1000);
      const stopped = runner.stop(3000);
      await settle();
      await w.advance(3000);
      await expect(stopped).resolves.toEqual({ graceful: false });
      expect(w.lines.join('\n')).toContain('1 had not ended after 3000 ms');
      await w.advance(60_000);
      expect(started).toBe(1);
    });

    it('can be called twice, and a stopped runner does not start again', async () => {
      const w = world();
      const runner = new JobRunner(w.deps);
      runner.register({ name: 'a', everyMs: 1000, run: async () => undefined });
      await runner.stop();
      await expect(runner.stop()).resolves.toEqual({ graceful: true });
      runner.start();
      expect(w.timers()).toBe(0);
    });
  });
});

describe('what may be said about an error', () => {
  it('is its name and its code, never its message', () => {
    expect(kindOf(new RangeError('secret'))).toBe('RangeError');
    expect(kindOf(Object.assign(new Error('secret'), { code: 'ECONNRESET' }))).toBe(
      'Error ECONNRESET',
    );
    expect(kindOf('a string with a secret')).toBe('string');
  });
});

describe('starting the jobs', () => {
  it('runs none in a process told WAYMARK_WORKER=off, and says so', async () => {
    const w = world();
    let runs = 0;
    const runner = startJobs(
      { worker: false },
      [{ name: 'a', everyMs: 1000, run: async () => void runs++ }],
      w.deps,
    );
    expect(runner).toBeUndefined();
    await w.advance(10_000);
    expect(runs).toBe(0);
    expect(w.lines.join('\n')).toContain('WAYMARK_WORKER=off');
  });

  it('runs them in a process that is the worker', async () => {
    const w = world();
    let runs = 0;
    const runner = startJobs(
      { worker: true },
      [{ name: 'a', everyMs: 1000, run: async () => void runs++ }],
      w.deps,
    );
    await w.advance(2000);
    expect(runs).toBe(2);
    await runner?.stop();
  });

  it('starts with nothing to run when it is given no jobs', async () => {
    const w = world();
    const runner = startJobs({ worker: true }, [], w.deps);
    expect(runner).toBeDefined();
    expect(w.lines.join('\n')).toContain('running 0 jobs');
    await runner?.stop();
  });

  it('has the jobs the app has: the sweeps of rate counts and of the media store, each hourly from the start, the map cache kept under its limit every ten minutes, and places named from where they are every minute', () => {
    expect(jobs.map((job) => job.name)).toEqual([
      'sweep-rate-buckets',
      'sweep-media',
      'prune-map-cache',
      'name-places',
      'prune-history',
      'prune-notices',
      'send-mail',
      'import',
      'export',
      'rotate-keys',
      'relink-trips',
      'send-core',
    ]);
    for (const job of jobs.filter((each) => each.name.startsWith('sweep')))
      expect(job).toMatchObject({ everyMs: 3_600_000, runAtStart: true });
    expect(jobs.find((job) => job.name === 'prune-map-cache')).toMatchObject({ everyMs: 600_000 });
    expect(jobs.find((job) => job.name === 'name-places')).toMatchObject({ everyMs: 60_000 });
  });
});
