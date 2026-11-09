import { sql } from 'drizzle-orm';
import { pgSchema } from 'drizzle-orm/pg-core';
import { sqliteTable } from 'drizzle-orm/sqlite-core';
import {
  generateDrizzleJson,
  generateMigration,
  generateSQLiteDrizzleJson,
  generateSQLiteMigration,
} from 'drizzle-kit/api';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from './client';
import { dbAll, dbGet, dbRun } from './exec';
import * as pgColumns from './schema/postgres/columns';
import * as sqliteColumns from './schema/sqlite/columns';
import { freshDatabase, testTarget } from './test-support';

/**
 * The column vocabulary (DESIGN.md §24.2) is only worth anything if each word means the same thing on both dialects, so this makes a table
 * out of every word, with the SQL the generator really writes for it, and reads values back through each. The tables are the test's own and
 * are dropped afterwards; the app's schema is not touched.
 */
const { leg } = testTarget();

/** A schema of the test's own in PostgreSQL, so that dropping it cannot reach anything else. */
const probeSchema = pgSchema('waymark_probe');

const sqliteProbe = sqliteTable('vocabulary_probe', {
  id: sqliteColumns.id('id'),
  owner: sqliteColumns.ref('owner').notNull(),
  at: sqliteColumns.epochMs('at').notNull(),
  seq: sqliteColumns.counter('seq').notNull(),
  done: sqliteColumns.bool('done').notNull(),
  day: sqliteColumns.isoDate('day'),
  time: sqliteColumns.hhmm('time'),
  data: sqliteColumns.fields('data').notNull(),
  rank: sqliteColumns.position('rank').notNull(),
  envelope: sqliteColumns.sealed('envelope'),
});

const pgProbe = probeSchema.table('vocabulary_probe', {
  id: pgColumns.id('id'),
  owner: pgColumns.ref('owner').notNull(),
  at: pgColumns.epochMs('at').notNull(),
  seq: pgColumns.counter('seq').notNull(),
  done: pgColumns.bool('done').notNull(),
  day: pgColumns.isoDate('day'),
  time: pgColumns.hhmm('time'),
  data: pgColumns.fields('data').notNull(),
  rank: pgColumns.position('rank').notNull(),
  envelope: pgColumns.sealed('envelope'),
});

/** The statements the generator writes to make the probe, as the migrations of the app are made. */
async function createStatements(dialect: Database['dialect']): Promise<string[]> {
  if (dialect === 'sqlite') {
    return generateSQLiteMigration(
      await generateSQLiteDrizzleJson({}),
      await generateSQLiteDrizzleJson({ sqliteProbe }),
    );
  }
  return generateMigration(
    await generateDrizzleJson({}),
    await generateDrizzleJson({ probeSchema, pgProbe }),
  );
}

let database: Database;
let table: ReturnType<typeof sql.raw>;

beforeAll(async () => {
  ({ database } = await freshDatabase());
  table =
    database.dialect === 'postgres'
      ? sql.raw('"waymark_probe"."vocabulary_probe"')
      : sql.raw('"vocabulary_probe"');
  if (database.dialect === 'postgres') {
    await dbRun(database, sql`DROP SCHEMA IF EXISTS waymark_probe CASCADE`);
  }
  for (const statement of await createStatements(database.dialect)) {
    await dbRun(database, sql.raw(statement));
  }
});

afterAll(async () => {
  if (database.dialect === 'postgres') {
    await dbRun(database, sql`DROP SCHEMA IF EXISTS waymark_probe CASCADE`);
  }
  await database.close();
});

describe(`the column vocabulary (${leg})`, () => {
  it('stores a time in milliseconds and a counter as numbers, exactly, past 2^32', async () => {
    const at = 1_800_000_000_123;
    const seq = 5_000_000_000;
    await dbRun(
      database,
      sql`INSERT INTO ${table} (id, owner, at, seq, done, data, rank) VALUES ('t1', 'a', ${at}, ${seq}, ${true}, '{}', 'a0')`,
    );
    const row = await dbGet<{ at: unknown; seq: unknown }>(
      database,
      sql`SELECT at, seq FROM ${table} WHERE id = 't1'`,
    );
    expect(row).toEqual({ at, seq });
    expect(typeof row?.at).toBe('number');
    expect(typeof row?.seq).toBe('number');
  });

  it('stores a boolean that can be read back as true and false', async () => {
    await dbRun(
      database,
      sql`INSERT INTO ${table} (id, owner, at, seq, done, data, rank) VALUES ('t2', 'a', 1, 1, ${false}, '{}', 'a1')`,
    );
    const rows = await dbAll<{ id: string; done: unknown }>(
      database,
      sql`SELECT id, done FROM ${table} WHERE id IN ('t1', 't2') ORDER BY id`,
    );
    // SQLite returns 0 and 1 where PostgreSQL returns booleans: raw reads cast where it matters (exec.ts), and a query says `done = ...`.
    expect(rows.map((r) => [r.id, Boolean(r.done)])).toEqual([
      ['t1', true],
      ['t2', false],
    ]);
  });

  it('keeps a date and a time of day as the text it was given, and they sort as dates and times', async () => {
    for (const [id, day, time] of [
      ['d3', '2026-11-30', '09:05'],
      ['d1', '2026-02-01', '14:30'],
      ['d2', '2026-11-04', '08:00'],
    ] as const) {
      await dbRun(
        database,
        sql`INSERT INTO ${table} (id, owner, at, seq, done, day, time, data, rank) VALUES (${id}, 'a', 1, 1, ${false}, ${day}, ${time}, '{}', ${id})`,
      );
    }
    const byDay = await dbAll<{ id: string; day: string; time: string }>(
      database,
      sql`SELECT id, day, time FROM ${table} WHERE id LIKE 'd%' ORDER BY day`,
    );
    expect(byDay.map((r) => r.id)).toEqual(['d1', 'd2', 'd3']);
    expect(byDay[2]).toMatchObject({ day: '2026-11-30', time: '09:05' });
    const byTime = await dbAll<{ id: string }>(
      database,
      sql`SELECT id FROM ${table} WHERE id LIKE 'd%' ORDER BY time`,
    );
    expect(byTime.map((r) => r.id)).toEqual(['d2', 'd3', 'd1']);
  });

  it('keeps JSON text exactly, without reformatting it', async () => {
    const data = '{"title":{"v":"Water the plants"},"done":{"c":"AAEC"}}';
    await dbRun(
      database,
      sql`INSERT INTO ${table} (id, owner, at, seq, done, data, rank) VALUES ('j1', 'a', 1, 1, ${false}, ${data}, 'j')`,
    );
    expect(
      await dbGet<{ data: string }>(database, sql`SELECT data FROM ${table} WHERE id = 'j1'`),
    ).toEqual({ data });
  });

  // The reason the word exists. PostgreSQL's own collation puts "aa" before "aA" (and "a1" in places a byte order never would); a position is
  // only meaningful compared by bytes, so two devices and two databases must agree on the order.
  it('orders a position by bytes: digits, then upper case, then lower case', async () => {
    for (const rank of ['aa', 'a0', 'aA', 'a1', 'Zz', 'b', 'a']) {
      await dbRun(
        database,
        sql`INSERT INTO ${table} (id, owner, at, seq, done, data, rank) VALUES (${`r-${rank}`}, 'a', 1, 1, ${false}, '{}', ${rank})`,
      );
    }
    const rows = await dbAll<{ rank: string }>(
      database,
      sql`SELECT rank FROM ${table} WHERE id LIKE 'r-%' ORDER BY rank`,
    );
    expect(rows.map((r) => r.rank)).toEqual(['Zz', 'a', 'a0', 'a1', 'aA', 'aa', 'b']);
    // And it is the order JavaScript gives when it compares code units, which is what the client does.
    const inJs = ['aa', 'a0', 'aA', 'a1', 'Zz', 'b', 'a'].sort((x, y) =>
      x < y ? -1 : x > y ? 1 : 0,
    );
    expect(rows.map((r) => r.rank)).toEqual(inJs);
  });

  // The ordering above passes on a PostgreSQL whose default collation is already by bytes (Alpine's, which has no locale collation), so the
  // column's own collation is asked as well: it is "C" on every PostgreSQL, whatever the database was made with.
  it.runIf(leg === 'postgres')('declares the byte collation on the column itself', async () => {
    const row = await dbGet<{ collation: string | null }>(
      database,
      sql`SELECT collation_name AS collation FROM information_schema.columns WHERE table_schema = 'waymark_probe' AND table_name = 'vocabulary_probe' AND column_name = 'rank'`,
    );
    expect(row?.collation).toBe('C');
  });

  // The envelope is binary on both dialects: every byte value survives, a zero in the middle included, and it reads back as the bytes it was given
  // through the query builder's own types (what `src/crypto/sealed.ts` uses) and through raw SQL, where the two drivers hand back different classes.
  it('keeps a sealed envelope as bytes, every value of a byte, and reads it back through raw SQL', async () => {
    const bytes = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
    await dbRun(
      database,
      sql`INSERT INTO ${table} (id, owner, at, seq, done, data, rank, envelope) VALUES ('s1', 'a', 1, 1, ${false}, '{}', 's', ${bytes})`,
    );
    const row = await dbGet<{ envelope: unknown }>(
      database,
      sql`SELECT envelope FROM ${table} WHERE id = 's1'`,
    );
    const read = row?.envelope;
    expect(
      Buffer.from(read instanceof ArrayBuffer ? new Uint8Array(read) : (read as Buffer)).equals(
        bytes,
      ),
    ).toBe(true);
    // Not text: nothing of it can be searched, which is the point.
    const length = await dbGet<{ n: number }>(
      database,
      sql`SELECT length(envelope) AS n FROM ${table} WHERE id = 's1'`,
    );
    expect(Number(length?.n)).toBe(256);
  });

  it('has a primary key on the id', async () => {
    await expect(
      dbRun(
        database,
        sql`INSERT INTO ${table} (id, owner, at, seq, done, data, rank) VALUES ('t1', 'a', 1, 1, ${false}, '{}', 'x')`,
      ),
    ).rejects.toThrow();
  });
});

describe('the generated SQL', () => {
  it('names the byte collation for a position on PostgreSQL, and nothing on SQLite', async () => {
    const pg = (await createStatements('postgres')).join('\n');
    const lite = (await createStatements('sqlite')).join('\n');
    expect(pg).toContain('"rank" text COLLATE "C" NOT NULL');
    expect(lite).toContain('`rank` text NOT NULL');
    expect(pg).toMatch(/"envelope" "?bytea"?/);
    expect(lite).toContain('`envelope` blob');
    expect(lite).not.toContain('COLLATE');
  });
});
