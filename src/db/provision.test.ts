import { sql } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { type Database } from './client';
import { APP_STORE, AUTH_STORE, resolveDatabaseConfig } from './config';
import { dbGet } from './exec';
import { provisionStores } from './provision';
import { createSqldClient, provisionNamespace } from './sqld';
import { freshDatabase, resetStores, testTarget } from './test-support';

const { leg, config } = testTarget();
const open: Database[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((d) => d.close()));
});

describe(`provisioning (${leg})`, () => {
  it('can be repeated', async () => {
    await resetStores(config);
    await provisionStores(config, 15_000);
    await expect(provisionStores(config, 15_000)).resolves.toBeUndefined();
  });

  it.runIf(leg === 'sqld')('makes both namespaces exist', async () => {
    if (config.dialect !== 'sqlite' || config.form !== 'sqld') return;
    await resetStores(config);
    await provisionStores(config, 15_000);
    for (const store of [APP_STORE, AUTH_STORE]) {
      const client = await createSqldClient(config.url, store);
      try {
        expect(Number((await client.execute('SELECT 1 AS one')).rows[0]?.one)).toBe(1);
      } finally {
        client.close();
      }
    }
  });

  it.runIf(leg === 'file')("keeps the auth store's file beside the app's", () => {
    if (config.dialect !== 'sqlite' || config.form !== 'file') return;
    expect(config.authPath).toMatch(/waymark_auth\.db$/);
  });
});

describe(`creating a namespace (${leg})`, () => {
  // A namespace that has never existed, so this is about creating one and not about
  // what a reset left behind. sqld only.
  it.runIf(leg === 'sqld')('makes it usable, and is idempotent', async () => {
    if (config.dialect !== 'sqlite' || config.form !== 'sqld') return;
    const namespace = `waymark_test_${Math.random().toString(36).slice(2, 10)}`;
    await provisionNamespace(config.adminUrl, namespace);
    await provisionNamespace(config.adminUrl, namespace);
    const client = await createSqldClient(config.url, namespace);
    try {
      await client.execute('CREATE TABLE t (a)');
      expect((await client.execute('SELECT COUNT(*) AS n FROM t')).rows[0]?.n).toBe(0);
    } finally {
      client.close();
      await fetch(`${config.adminUrl}/v1/namespaces/${namespace}`, { method: 'DELETE' });
    }
  });
});

describe('provisioning a service that is not there', () => {
  it('says which setting to check for sqld', async () => {
    const down = resolveDatabaseConfig({
      WAYMARK_SQLD_URL: 'http://127.0.0.1:1',
      WAYMARK_SQLD_ADMIN_URL: 'http://127.0.0.1:1',
    });
    await expect(provisionStores(down, 100)).rejects.toThrow(/WAYMARK_SQLD_ADMIN_URL/);
  });

  it('says which setting to check for PostgreSQL', async () => {
    const down = resolveDatabaseConfig({
      WAYMARK_DB_DIALECT: 'postgres',
      WAYMARK_POSTGRES_URL: 'postgres://u:p@127.0.0.1:1/x',
    });
    await expect(provisionStores(down, 100)).rejects.toThrow(/WAYMARK_POSTGRES_URL/);
  });
});

describe('the SQLite file form', () => {
  it.runIf(leg === 'file')(
    'is in WAL mode, so a second process can read while one writes',
    async () => {
      const { database } = await freshDatabase();
      open.push(database);
      const row = await dbGet<{ journal_mode: string }>(database, sql`PRAGMA journal_mode`);
      expect(row?.journal_mode).toBe('wal');
    },
  );
});
