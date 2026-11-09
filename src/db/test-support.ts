import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { is } from 'drizzle-orm';
import { SQLiteTable, getTableConfig } from 'drizzle-orm/sqlite-core';
import { type Env, processEnv } from '../config/env';
import * as sqliteApp from './schema/sqlite/app';
import * as sqliteAuth from './schema/sqlite/auth';
import { type Database, openDatabase } from './client';
import {
  APP_STORE,
  AUTH_STORE,
  type DatabaseConfig,
  type DatabaseSettings,
  resolveDatabaseConfig,
  resolveDatabaseSettings,
} from './config';
import { runMigrations } from './migrate';
import { provisionStores } from './provision';
import { createSqldClient, provisionNamespace } from './sqld';

/**
 * What the data-layer tests run against, and a way to start each from nothing.
 *
 * CI runs the whole suite three times (sqld, a `file:` database, PostgreSQL) by
 * setting the WAYMARK_TEST_* variables below. They are deliberately **not** the
 * variables the app reads: these tests drop whole schemas and namespaces, and a
 * developer with a real instance's WAYMARK_DB_DIALECT and WAYMARK_POSTGRES_URL exported in a shell
 * must never find them wiped. With none of them set the tests use a throwaway SQLite
 * file, so `pnpm test` needs no database service.
 *
 *   WAYMARK_TEST_DB_DIALECT, WAYMARK_TEST_SQLITE_URL,
 *   WAYMARK_TEST_SQLD_ADMIN_URL, WAYMARK_TEST_POSTGRES_DB_URL
 *
 * They keep the shape the app's variables had before they took Sovereign's names: a dialect of
 * `sqlite` or `postgres`, and one SQLite URL that is an sqld service's address or a `file:`.
 */
export type Leg = 'sqld' | 'file' | 'postgres';

export interface TestTarget {
  leg: Leg;
  config: DatabaseConfig;
}

let target: TestTarget | undefined;

export function testTarget(env: Env = processEnv()): TestTarget {
  if (target) return target;
  const configured = Boolean(
    env.WAYMARK_TEST_DB_DIALECT || env.WAYMARK_TEST_SQLITE_URL || env.WAYMARK_TEST_POSTGRES_DB_URL,
  );
  const config = resolveDatabaseConfig(
    configured
      ? fromTestVariables(env)
      : {
          WAYMARK_DB_DIALECT: 'sqlite',
          WAYMARK_SQLITE_URL: `file:${join(mkdtempSync(join(tmpdir(), 'waymark-test-')), 'waymark.db')}`,
        },
  );
  target = { leg: config.dialect === 'postgres' ? 'postgres' : config.form, config };
  return target;
}

/** Remove everything the app and auth stores hold, so the next test starts from empty. */
export async function resetStores(config: DatabaseConfig): Promise<void> {
  if (config.dialect === 'sqlite' && config.form === 'file') {
    for (const path of [config.path, config.authPath]) {
      for (const suffix of ['', '-wal', '-shm', '-journal'])
        await rm(`${path}${suffix}`, { force: true });
    }
    return;
  }

  if (config.dialect === 'sqlite') {
    // Empty each namespace by dropping what is in it. Deleting the namespace through
    // the admin API is not a reset: sqld (v0.24) keeps serving the data of a namespace
    // it reports as destroyed. A namespace has to exist to be emptied, so make it.
    for (const namespace of [APP_STORE, AUTH_STORE]) {
      await provisionNamespace(config.adminUrl, namespace);
      const client = await createSqldClient(config.url, namespace);
      try {
        const objects = await client.execute(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'",
        );
        for (const row of objects.rows)
          await client.execute(`DROP TABLE IF EXISTS "${String(row.name)}"`);
      } finally {
        client.close();
      }
    }
    return;
  }

  const { default: pg } = await import('pg');
  const client = new pg.Client({ connectionString: config.url });
  await client.connect();
  try {
    // `drizzle` and `drizzle_auth` are where Drizzle keeps its record of applied migrations.
    for (const schema of [APP_STORE, AUTH_STORE, 'drizzle', 'drizzle_auth']) {
      await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    }
  } finally {
    await client.end();
  }
}

/** An empty, provisioned database, opened but not migrated. */
export async function freshDatabase(
  store: 'app' | 'auth' = 'app',
): Promise<{ database: Database } & TestTarget> {
  const { config, leg } = testTarget();
  await resetStores(config);
  await provisionStores(config, 15_000);
  return { database: await openDatabase(config, store), config, leg };
}

/**
 * A migrated app store, from empty: what the tests of a table share. A test that also needs the auth store's tables resets both first
 * (`freshDatabase` and `runMigrations` each), because on sqld and PostgreSQL the stores are shared and this resets them both.
 */
export async function makeStore(): Promise<{ database: Database; close(): Promise<void> }> {
  const { database } = await freshDatabase('app');
  await runMigrations(database);
  return { database, close: () => database.close() };
}

/** The app's variables for what the WAYMARK_TEST_* variables name. */
function fromTestVariables(env: Env): Env {
  if ((env.WAYMARK_TEST_DB_DIALECT ?? '').trim().toLowerCase() === 'postgres') {
    return {
      WAYMARK_DB_DIALECT: 'postgres',
      WAYMARK_POSTGRES_URL: env.WAYMARK_TEST_POSTGRES_DB_URL,
    };
  }
  const url = (env.WAYMARK_TEST_SQLITE_URL ?? '').trim();
  if (url.startsWith('file:')) return { WAYMARK_DB_DIALECT: 'sqlite', WAYMARK_SQLITE_URL: url };
  return {
    WAYMARK_DB_DIALECT: 'sqld',
    WAYMARK_SQLD_URL: url,
    WAYMARK_SQLD_ADMIN_URL: env.WAYMARK_TEST_SQLD_ADMIN_URL,
  };
}

/** The environment that makes `resolveDatabaseConfig` return this target's configuration. */
export function envFor(config: DatabaseConfig): Env {
  if (config.dialect === 'postgres')
    return { WAYMARK_DB_DIALECT: 'postgres', WAYMARK_POSTGRES_URL: config.url };
  if (config.form === 'file')
    return { WAYMARK_DB_DIALECT: 'sqlite', WAYMARK_SQLITE_URL: `file:${config.path}` };
  return {
    WAYMARK_DB_DIALECT: 'sqld',
    WAYMARK_SQLD_URL: config.url,
    WAYMARK_SQLD_ADMIN_URL: config.adminUrl,
  };
}

/** The settings that start the database on this target, as the app would be given them. */
export function settingsFor(config: DatabaseConfig): DatabaseSettings {
  return resolveDatabaseSettings(envFor(config));
}

/** The names of the tables of a schema module, sorted: what a store holds after its migrations, so that a test need not list them by hand. */
const namesIn = (module: Record<string, unknown>): string[] =>
  Object.values(module)
    .filter((value): value is SQLiteTable => is(value, SQLiteTable))
    .map((table) => getTableConfig(table).name)
    .sort();

/** What the app store holds once it is migrated. */
export const APP_TABLES: readonly string[] = namesIn(sqliteApp);

/** What the auth store holds once it is migrated. */
export const AUTH_TABLES: readonly string[] = namesIn(sqliteAuth);
