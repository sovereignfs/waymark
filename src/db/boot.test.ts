import { sql } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { getDatabase, getStores } from './boot';
import type { Database } from './client';
import { dbAll, dbGet } from './exec';
import { resolveDatabaseConfig } from './config';
import { APP_TABLES, AUTH_TABLES, resetStores, settingsFor, testTarget } from './test-support';

const { leg, config } = testTarget();
const KEY = Symbol.for('waymark.database');
const holder = globalThis as { [KEY]?: Promise<{ close(): Promise<void> }> | undefined };

afterEach(async () => {
  const booted = holder[KEY];
  holder[KEY] = undefined;
  await (await booted?.catch(() => undefined))?.close();
});

/** The names of the tables a store holds, for any dialect. */
async function tablesOf(database: Database): Promise<string[]> {
  const rows =
    database.dialect === 'postgres'
      ? await dbAll<{ name: string }>(
          database,
          sql`SELECT table_name AS name FROM information_schema.tables WHERE table_schema = ${database.store === 'auth' ? 'waymark_auth' : 'waymark'}`,
        )
      : await dbAll<{ name: string }>(
          database,
          sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '\\_\\_%' ESCAPE '\\' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'`,
        );
  return rows.map((r) => r.name).sort();
}

describe(`booting an instance (${leg})`, () => {
  it('from an empty database: provisions, migrates both stores, and is ready to use', async () => {
    await resetStores(config);
    const { app, auth } = await getStores(settingsFor(config));
    expect(await dbGet(app, sql`SELECT 1 AS ok`)).toMatchObject({ ok: 1 });
    expect(await dbGet(auth, sql`SELECT 1 AS ok`)).toMatchObject({ ok: 1 });
  });

  // The two must be separate databases: better-auth owns its tables and the app owns its
  // own, and neither may see or collide with the other's. For sqld this is the
  // `x-namespace` header, which sqld releases before 0.24.33 silently ignore, leaving every
  // namespace the one default database; for a file, two files; for PostgreSQL, two schemas.
  it("keeps the app's tables and better-auth's in separate stores", async () => {
    await resetStores(config);
    const { app, auth } = await getStores(settingsFor(config));
    expect(await tablesOf(app)).toEqual([...APP_TABLES]);
    // Nothing of the app's is in the auth store, and nothing of better-auth's in the app's: they are separate databases.
    expect(await tablesOf(auth)).toEqual([...AUTH_TABLES]);
  });

  it('is booted once: later callers get the same database', async () => {
    await resetStores(config);
    const first = await getDatabase(settingsFor(config));
    expect(await getDatabase(settingsFor(config))).toBe(first);
  });

  it('starts from an already-migrated database without changing it', async () => {
    await resetStores(config);
    const first = await getStores(settingsFor(config));
    await first.close();
    holder[KEY] = undefined;
    const again = await getStores(settingsFor(config));
    expect(await dbGet(again.app, sql`SELECT 1 AS ok`)).toMatchObject({ ok: 1 });
    expect(await tablesOf(again.app)).toEqual([...APP_TABLES]);
  });

  it('fails when the database cannot be reached, says why, and tries again on the next call', async () => {
    const down = {
      database: resolveDatabaseConfig({
        WAYMARK_SQLD_URL: 'http://127.0.0.1:1',
        WAYMARK_SQLD_ADMIN_URL: 'http://127.0.0.1:1',
      }),
      connectTimeoutMs: 100,
      migrationsDir: undefined,
    };
    await expect(getStores(down)).rejects.toThrow(/WAYMARK_SQLD_ADMIN_URL/);
    await resetStores(config);
    await expect(getStores(settingsFor(config))).resolves.toBeDefined();
  });
});
