import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { pgConnectionOptions } from './client';
import { APP_STORE, AUTH_STORE, type DatabaseConfig } from './config';
import { retryUntil } from './retry';
import { provisionNamespace } from './sqld';

/**
 * Make sure the places the two stores live in exist, before anything connects to
 * them: the sqld namespaces and the directory for the SQLite files; for PostgreSQL, that
 * it can be reached. Idempotent, and it waits for a service that is still starting, up to
 * `timeoutMs`, since the app and its database come up together.
 *
 * The tables are not made here: migrations make them (`migrate.ts`), and PostgreSQL's
 * schemas `waymark` and `waymark_auth` are made by the first migration of each, which is why
 * they are not made here too: it would find them already there and fail.
 */
export async function provisionStores(config: DatabaseConfig, timeoutMs = 30_000): Promise<void> {
  if (config.dialect === 'sqlite' && config.form === 'file') {
    await mkdir(dirname(config.path), { recursive: true });
    return;
  }

  if (config.dialect === 'sqlite') {
    try {
      await retryUntil(async () => {
        await provisionNamespace(config.adminUrl, APP_STORE);
        await provisionNamespace(config.adminUrl, AUTH_STORE);
      }, timeoutMs);
    } catch (error) {
      throw new Error(
        `could not reach the sqld admin API at ${config.adminUrl} (set WAYMARK_SQLD_ADMIN_URL): ${message(error)}`,
        { cause: error },
      );
    }
    return;
  }

  const { default: pg } = await import('pg');
  await retryUntil(async () => {
    const client = new pg.Client(pgConnectionOptions(config));
    await client.connect();
    try {
      await client.query('SELECT 1');
    } finally {
      await client.end();
    }
  }, timeoutMs).catch((error: unknown) => {
    throw new Error(`could not reach PostgreSQL (check WAYMARK_POSTGRES_URL): ${message(error)}`);
  });
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
