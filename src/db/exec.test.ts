import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from './client';
import { dbAll, dbGet, dbRun, transaction } from './exec';
import { freshDatabase, testTarget } from './test-support';

const { leg } = testTarget();
let database: Database;

beforeAll(async () => {
  ({ database } = await freshDatabase());
  // A table of our own: these tests are about the helpers, not about the app's tables.
  // PostgreSQL puts it in `public`, which the reset leaves alone, so drop it first as
  // well as after: a run that failed halfway must not break the next.
  await dbRun(database, sql`DROP TABLE IF EXISTS exec_probe`);
  await dbRun(
    database,
    sql`CREATE TABLE exec_probe (id INTEGER PRIMARY KEY, label TEXT NOT NULL, big BIGINT NOT NULL)`,
  );
});
afterAll(async () => {
  await dbRun(database, sql`DROP TABLE IF EXISTS exec_probe`);
  await database.close();
});

describe(`portable queries (${leg})`, () => {
  it('returns undefined, and does not throw, when a query matches no row', async () => {
    // drizzle-orm's libSQL `.get()` throws on this; `dbGet` must not.
    expect(await dbGet(database, sql`SELECT * FROM exec_probe WHERE id = 12345`)).toBeUndefined();
  });

  it('runs a statement, then reads the row and the rows back', async () => {
    await dbRun(
      database,
      sql`INSERT INTO exec_probe (id, label, big) VALUES (1, 'one', 1), (2, 'two', 2)`,
    );
    expect(await dbGet(database, sql`SELECT id, label FROM exec_probe WHERE id = 2`)).toMatchObject(
      { id: 2, label: 'two' },
    );
    const rows = await dbAll<{ id: number }>(database, sql`SELECT id FROM exec_probe ORDER BY id`);
    expect(rows.map((r) => Number(r.id))).toEqual([1, 2]);
  });

  it('returns a 64-bit integer as a number', async () => {
    const epochMs = 1_800_000_000_123; // past 2^32, well inside 2^53
    await dbRun(
      database,
      sql`INSERT INTO exec_probe (id, label, big) VALUES (3, 'big', ${epochMs})`,
    );
    const row = await dbGet<{ big: unknown }>(
      database,
      sql`SELECT big FROM exec_probe WHERE id = 3`,
    );
    expect(row?.big).toBe(epochMs);
    expect(typeof row?.big).toBe('number');
  });

  it('returns an empty list for no rows', async () => {
    expect(await dbAll(database, sql`SELECT * FROM exec_probe WHERE id < 0`)).toEqual([]);
  });

  it('binds values and does not interpolate them', async () => {
    const label = "a'; DROP TABLE exec_probe; --";
    await dbRun(database, sql`INSERT INTO exec_probe (id, label, big) VALUES (4, ${label}, 4)`);
    expect(
      await dbGet<{ label: string }>(database, sql`SELECT label FROM exec_probe WHERE id = 4`),
    ).toMatchObject({ label });
    expect(await dbGet(database, sql`SELECT id FROM exec_probe WHERE id = 1`)).toBeDefined();
  });

  it('supports ON CONFLICT … DO UPDATE the same way', async () => {
    await dbRun(
      database,
      sql`INSERT INTO exec_probe (id, label, big) VALUES (5, 'first', 5) ON CONFLICT (id) DO UPDATE SET label = excluded.label`,
    );
    await dbRun(
      database,
      sql`INSERT INTO exec_probe (id, label, big) VALUES (5, 'second', 5) ON CONFLICT (id) DO UPDATE SET label = excluded.label`,
    );
    expect(
      await dbGet<{ label: string }>(database, sql`SELECT label FROM exec_probe WHERE id = 5`),
    ).toMatchObject({ label: 'second' });
  });
});

describe(`a 64-bit integer too large for a number (${leg})`, () => {
  it.runIf(leg === 'postgres')('is an error, not a rounded value', async () => {
    // Drizzle wraps what a type parser throws; the cause is ours.
    const error = await dbGet(database, sql`SELECT 9007199254740993::bigint AS big`).catch(
      (e: unknown) => e,
    );
    expect((error as Error).cause).toBeInstanceOf(RangeError);
    expect(((error as Error).cause as Error).message).toMatch(/cannot represent/);
  });
});

describe(`transactions (${leg})`, () => {
  const count = async (where: string) =>
    Number(
      (
        await dbGet<{ n: number | string }>(
          database,
          sql`SELECT COUNT(*) AS n FROM exec_probe WHERE label = ${where}`,
        )
      )?.n,
    );

  it('commits what the work did when it returns, and returns what the work returns', async () => {
    const result = await transaction(database, async (tx) => {
      await dbRun(tx, sql`INSERT INTO exec_probe (id, label, big) VALUES (100, 'committed', 1)`);
      await dbRun(tx, sql`INSERT INTO exec_probe (id, label, big) VALUES (101, 'committed', 2)`);
      return 'done';
    });
    expect(result).toBe('done');
    expect(await count('committed')).toBe(2);
  });

  it('undoes everything the work did when it throws, and throws what the work threw', async () => {
    const failure = new Error('stop here');
    await expect(
      transaction(database, async (tx) => {
        await dbRun(tx, sql`INSERT INTO exec_probe (id, label, big) VALUES (110, 'undone', 1)`);
        await dbRun(tx, sql`INSERT INTO exec_probe (id, label, big) VALUES (111, 'undone', 2)`);
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(await count('undone')).toBe(0);
  });

  it('undoes the work when a statement in it fails, such as a repeated key', async () => {
    await expect(
      transaction(database, async (tx) => {
        await dbRun(tx, sql`INSERT INTO exec_probe (id, label, big) VALUES (120, 'half', 1)`);
        await dbRun(tx, sql`INSERT INTO exec_probe (id, label, big) VALUES (120, 'half', 2)`);
      }),
    ).rejects.toThrow();
    expect(await count('half')).toBe(0);
  });

  it('shows the work its own writes, and others nothing of them until it ends', async () => {
    await transaction(database, async (tx) => {
      await dbRun(tx, sql`INSERT INTO exec_probe (id, label, big) VALUES (130, 'inside', 1)`);
      expect(await dbGet(tx, sql`SELECT id FROM exec_probe WHERE label = 'inside'`)).toBeDefined();
    });
    expect(await count('inside')).toBe(1);
  });

  it('lets transactions that overlap each wait their turn and all finish, which a file does in JavaScript and not by its lock', async () => {
    // Each one yields between its statements, as real work does while it waits for something: the first holds the write lock across those
    // pauses, and a second that waited on SQLite's lock would stop the very thread the first needs to finish.
    const pause = () => new Promise((resolve) => setTimeout(resolve, 5));
    await Promise.all(
      Array.from({ length: 8 }, (_, n) =>
        transaction(database, async (tx) => {
          await dbRun(
            tx,
            sql`INSERT INTO exec_probe (id, label, big) VALUES (${200 + n}, 'overlap', 1)`,
          );
          await pause();
          await dbRun(
            tx,
            sql`INSERT INTO exec_probe (id, label, big) VALUES (${300 + n}, 'overlap', 2)`,
          );
        }),
      ),
    );
    expect(await count('overlap')).toBe(16);
  });

  it('keeps going after a transaction that failed, for the ones queued behind it', async () => {
    const results = await Promise.allSettled([
      transaction(database, async () => {
        throw new Error('first fails');
      }),
      transaction(database, async (tx) => {
        await dbRun(tx, sql`INSERT INTO exec_probe (id, label, big) VALUES (400, 'after', 1)`);
      }),
    ]);
    expect(results.map((r) => r.status)).toEqual(['rejected', 'fulfilled']);
    expect(await count('after')).toBe(1);
  });

  it('lets a statement that is not in a transaction take its turn beside ones that are, which a file does in JavaScript too', async () => {
    const pause = () => new Promise((resolve) => setTimeout(resolve, 5));
    const work = [
      ...Array.from({ length: 4 }, (_, n) =>
        transaction(database, async (tx) => {
          await dbRun(
            tx,
            sql`INSERT INTO exec_probe (id, label, big) VALUES (${500 + n}, 'mixed', 1)`,
          );
          await pause();
        }),
      ),
      ...Array.from({ length: 4 }, (_, n) =>
        dbRun(
          database,
          sql`INSERT INTO exec_probe (id, label, big) VALUES (${600 + n}, 'mixed', 2)`,
        ),
      ),
    ];
    await Promise.all(work);
    expect(await count('mixed')).toBe(8);
  });
});
