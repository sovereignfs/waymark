import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Database, openDatabase } from './../db/client';
import { dbGet, dbRun } from './../db/exec';
import { runMigrations } from './../db/migrate';
import { freshDatabase, testTarget } from './../db/test-support';
import { claim, claimJob } from './claim';
import { JobRunner } from './runner';

const { leg } = testTarget();
let first: Database;
/** A second connection, as a second process has. */
let second: Database;

beforeAll(async () => {
  const fresh = await freshDatabase();
  first = fresh.database;
  await runMigrations(first);
  second = await openDatabase(fresh.config);
  await dbRun(first, sql`DROP TABLE IF EXISTS claim_probe`);
  await dbRun(first, sql`CREATE TABLE claim_probe (id TEXT PRIMARY KEY, done_on TEXT)`);
});

afterAll(async () => {
  await dbRun(first, sql`DROP TABLE IF EXISTS claim_probe`);
  await Promise.all([first.close(), second.close()]);
});

/** The statement a job writes: free while `done_on` is empty or before today. */
const take = (id: string, today: string) =>
  sql`UPDATE claim_probe SET done_on = ${today} WHERE id = ${id} AND (done_on IS NULL OR done_on < ${today}) RETURNING id`;

describe(`claiming a piece of work (${leg})`, () => {
  it('is won by the process whose update changed the row, and by no one else', async () => {
    await dbRun(first, sql`INSERT INTO claim_probe (id) VALUES ('digest')`);
    expect(await claim(first, take('digest', '2026-11-05'))).toBe(true);
    expect(await claim(second, take('digest', '2026-11-05'))).toBe(false);
    expect(await claim(first, take('digest', '2026-11-05'))).toBe(false);
  });

  it('is won by exactly one of several that try at once, from different connections', async () => {
    for (let round = 0; round < 10; round++) {
      const id = `race-${round}`;
      await dbRun(first, sql`INSERT INTO claim_probe (id) VALUES (${id})`);
      const results = await Promise.all([
        claim(first, take(id, '2026-11-05')),
        claim(second, take(id, '2026-11-05')),
        claim(first, take(id, '2026-11-05')),
        claim(second, take(id, '2026-11-05')),
      ]);
      expect(results.filter(Boolean), `round ${round}`).toHaveLength(1);
    }
  });

  it('is free again when the thing that made it due is true again, as on the next day', async () => {
    await dbRun(first, sql`INSERT INTO claim_probe (id) VALUES ('daily')`);
    expect(await claim(first, take('daily', '2026-11-05'))).toBe(true);
    expect(await claim(second, take('daily', '2026-11-06'))).toBe(true);
    expect(await claim(first, take('daily', '2026-11-06'))).toBe(false);
  });

  it('is not won for a row that is not there, or that is not due', async () => {
    expect(await claim(first, take('nothing', '2026-11-05'))).toBe(false);
  });

  it('changes only the row it claimed', async () => {
    await dbRun(first, sql`INSERT INTO claim_probe (id) VALUES ('mine'), ('yours')`);
    await claim(first, take('mine', '2026-11-05'));
    expect(await dbGet(first, sql`SELECT done_on FROM claim_probe WHERE id = 'yours'`)).toEqual({
      done_on: null,
    });
  });
});

describe(`the lease of a job with no row of its own (${leg})`, () => {
  it('is taken by one of several processes that ask at once, and by no other until it runs out', async () => {
    for (let round = 0; round < 10; round++) {
      const job = `sweep-${round}`;
      const results = await Promise.all([
        claimJob(first, job, 1000, 5000),
        claimJob(second, job, 1000, 5000),
        claimJob(first, job, 1000, 5000),
        claimJob(second, job, 1000, 5000),
      ]);
      expect(results.filter(Boolean), `round ${round}`).toHaveLength(1);
      // Still held a moment later, free the moment it has run out.
      expect(await claimJob(second, job, 1000, 5999)).toBe(false);
      expect(await claimJob(second, job, 1000, 6000)).toBe(true);
    }
  });

  it('keeps one job’s lease from another’s', async () => {
    expect(await claimJob(first, 'one', 1000, 1)).toBe(true);
    expect(await claimJob(second, 'two', 1000, 1)).toBe(true);
  });

  it('makes the work of a job done once when two runners, as two processes would, run it at the same time', async () => {
    let done = 0;
    const work = (database: Database) => ({
      name: 'once',
      everyMs: 1000,
      run: async ({ now }: { now: Date }) => {
        if (!(await claimJob(database, 'once-runners', 60_000, now.getTime()))) return;
        done++;
      },
    });
    const a = new JobRunner();
    const b = new JobRunner();
    a.register(work(first));
    b.register(work(second));
    await Promise.all([a.runNow('once'), b.runNow('once')]);
    expect(done).toBe(1);
    // A run by either of them later, inside the lease, does nothing either.
    await Promise.all([a.runNow('once'), b.runNow('once')]);
    expect(done).toBe(1);
    await Promise.all([a.stop(), b.stop()]);
  });
});
