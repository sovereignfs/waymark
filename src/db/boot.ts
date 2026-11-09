import { type Database, openDatabase } from './client';
import { getConfig } from '../config/current';
import { type DatabaseSettings, describeConfig } from './config';
import { migrationsFolder, runMigrations } from './migrate';
import { provisionStores } from './provision';

/**
 * Bring the database up: read the configuration, make sure the stores exist, open both,
 * and apply each one's migrations. It runs once at server start (`instrumentation.ts`)
 * and fails loudly, so an instance that cannot reach or migrate its database does not
 * start. Anything that later needs a database asks `getDatabase()` (the app's tables) or
 * `getAuthDatabase()` (better-auth's), which return the ones this opened.
 *
 * Both stores are migrated whatever the sign-in settings: the auth store is part of the
 * database, and the tables of a method that is switched off are simply unused.
 */
export interface Stores {
  app: Database;
  auth: Database;
  close(): Promise<void>;
}

const KEY = Symbol.for('waymark.database');
type Holder = { [KEY]?: Promise<Stores> | undefined };

export function getStores(settings: DatabaseSettings = getConfig().database): Promise<Stores> {
  // On `globalThis`, because the development server reloads modules and a second
  // copy of this one must not open a second pool.
  const holder = globalThis as Holder;
  holder[KEY] ??= boot(settings).catch((error: unknown) => {
    // Forget a failure, so the next call tries again rather than failing forever.
    holder[KEY] = undefined;
    throw error;
  });
  return holder[KEY];
}

export async function getDatabase(settings?: DatabaseSettings): Promise<Database> {
  return (await getStores(settings)).app;
}

export async function getAuthDatabase(settings?: DatabaseSettings): Promise<Database> {
  return (await getStores(settings)).auth;
}

async function boot(settings: DatabaseSettings): Promise<Stores> {
  const { database: config, connectTimeoutMs: timeoutMs, migrationsDir } = settings;
  console.info(`[waymark] database: ${describeConfig(config)}`);
  await provisionStores(config, timeoutMs);

  const app = await openDatabase(config, 'app');
  const auth = await openDatabase(config, 'auth');
  const close = async () => {
    await Promise.all([app.close(), auth.close()]);
  };
  try {
    await runMigrations(app, migrationsFolder(app.dialect, 'app', migrationsDir));
    await runMigrations(auth, migrationsFolder(auth.dialect, 'auth', migrationsDir));
  } catch (error) {
    await close();
    throw error;
  }
  console.info('[waymark] database: ready, migrations applied');
  return { app, auth, close };
}
