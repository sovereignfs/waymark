import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { type Database, openDatabase } from './client';
import { dbAll, dbGet } from './exec';
import { migrationsFolder, runMigrations } from './migrate';
import { APP_TABLES, AUTH_TABLES, freshDatabase, testTarget } from './test-support';

const { leg } = testTarget();

/** How many migrations the committed journal says there are. */
function journalLength(database: Database): number {
  const journal = JSON.parse(
    readFileSync(
      join(migrationsFolder(database.dialect, database.store), 'meta', '_journal.json'),
      'utf8',
    ),
  );
  return journal.entries.length;
}

/** How many Drizzle has recorded as applied. */
async function appliedCount(database: Database): Promise<number> {
  const table =
    database.dialect === 'postgres'
      ? database.store === 'auth'
        ? sql`"drizzle_auth"."__drizzle_migrations"`
        : sql`"drizzle"."__drizzle_migrations"`
      : sql`"__drizzle_migrations"`;
  const row = await dbGet<{ n: number | string }>(
    database,
    sql`SELECT COUNT(*) AS n FROM ${table}`,
  );
  return Number(row?.n);
}

async function tableNames(database: Database): Promise<string[]> {
  const rows =
    database.dialect === 'postgres'
      ? await dbAll<{ name: string }>(
          database,
          sql`SELECT table_name AS name FROM information_schema.tables WHERE table_schema = ${database.store === 'auth' ? 'waymark_auth' : 'waymark'}`,
        )
      : await dbAll<{ name: string }>(
          database,
          sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '\\_\\_%' ESCAPE '\\' AND name NOT LIKE 'sqlite_%'`,
        );
  return rows.map((r) => r.name).sort();
}

const open: Database[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((d) => d.close()));
});

describe(`migrations (${leg})`, () => {
  it("apply to an empty database and make the app's tables", async () => {
    const { database } = await freshDatabase();
    open.push(database);
    expect(await tableNames(database)).toEqual([]);

    await runMigrations(database);

    expect(await tableNames(database)).toEqual([...APP_TABLES]);
    expect(await appliedCount(database)).toBe(journalLength(database));
  });

  it("apply to an empty auth store and make better-auth's tables, not the app's", async () => {
    const { database } = await freshDatabase('auth');
    open.push(database);
    await runMigrations(database);
    expect(await tableNames(database)).toEqual([...AUTH_TABLES]);
    expect(await appliedCount(database)).toBe(journalLength(database));
  });

  it('fail on a folder with no migrations, since an app with no tables is a mistake', async () => {
    const { database } = await freshDatabase('auth');
    open.push(database);
    await expect(
      runMigrations(database, join(tmpdir(), 'waymark-no-migrations')),
    ).rejects.toThrow();
  });

  it('do nothing the second time', async () => {
    const { database } = await freshDatabase();
    open.push(database);
    await runMigrations(database);
    const before = await appliedCount(database);

    await runMigrations(database);

    expect(await appliedCount(database)).toBe(before);
  });

  it('are safe when two processes start at once', async () => {
    const { database, config } = await freshDatabase();
    const second = await openDatabase(config);
    open.push(database, second);

    await Promise.all([runMigrations(database), runMigrations(second)]);

    expect(await appliedCount(database)).toBe(journalLength(database));
    expect(await tableNames(database)).toEqual([...APP_TABLES]);
  });

  it('fail, and say so, when the migrations are missing', async () => {
    const { database } = await freshDatabase();
    open.push(database);
    await expect(runMigrations(database, '/nonexistent/migrations')).rejects.toThrow();
  });

  it("leave PostgreSQL's advisory lock released after a failure", async () => {
    // A leaked lock hangs every later start (see migrate.ts), so a failed run must let go.
    if (leg !== 'postgres') return;
    const { database } = await freshDatabase();
    open.push(database);
    await expect(runMigrations(database, '/nonexistent/migrations')).rejects.toThrow();
    await runMigrations(database);
    expect(await tableNames(database)).toEqual([...APP_TABLES]);
  });
});

describe('the migration files', () => {
  it.each(['sqlite', 'postgres'] as const)(
    '%s: every journal entry has its SQL file',
    (dialect) => {
      const folder = migrationsFolder(dialect, 'app');
      const journal = JSON.parse(readFileSync(join(folder, 'meta', '_journal.json'), 'utf8'));
      expect(journal.entries.length).toBeGreaterThan(0);
      for (const entry of journal.entries)
        expect(() => readFileSync(join(folder, `${entry.tag}.sql`), 'utf8')).not.toThrow();
    },
  );

  it('are named alike on both dialects, so a reviewer reads a pair', () => {
    const tags = (dialect: 'sqlite' | 'postgres') =>
      JSON.parse(
        readFileSync(join(migrationsFolder(dialect, 'app'), 'meta', '_journal.json'), 'utf8'),
      ).entries.map((e: { tag: string }) => e.tag);
    expect(tags('postgres')).toEqual(tags('sqlite'));
  });
});
