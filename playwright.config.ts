import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig, devices } from '@playwright/test';
import { PORTS } from './e2e/ports.ts';
import { makePmtiles } from './src/map/pmtiles-fixture.ts';

/**
 * Browser tests (`pnpm build && pnpm e2e`): the real app, built, in a real browser. They are where the things a unit test cannot show are shown:
 * a page as a visitor sees it, a policy a browser enforces, a service worker, a network that goes away, a position, a clock and a phone's width.
 *
 * One instance of the app runs, on the database form the environment names: a leg of CI sets the variables an operator would set
 * (`WAYMARK_DB_DIALECT` and its address) and this uses them as they are, and with none it is a SQLite file in a directory of its own. The three
 * forms are three runs of this, as the data-layer tests are. A test that needs an instance of its own (a different way of signing in) adds one to
 * `webServer` below, with a port in `e2e/ports.ts`.
 *
 * Two browsers: Chromium, and WebKit, which is Safari's engine and where iOS's scrolling and compositing differ most (DESIGN.md §25 Testing). WebKit here
 * is a desktop build: it does not check touch, which the iOS Simulator does, by hand, and the PR says so.
 *
 * The ports are `e2e/ports.ts`'s, shifted by `WAYMARK_E2E_PORT_OFFSET`, which is how `scripts/e2e-shard.mjs` runs several of these at once.
 *
 * The key and the secret below are for this throwaway instance only.
 */
const PORT = PORTS.app;
/** An instance with no way of signing in: its own SQLite file, so that it shares nothing with the first. `e2e/auth.spec.ts` uses it. */
const OFF_PORT = PORTS.off;
/** An instance that signs in through Sovereign only, and one that offers both ways (`e2e/sovereign.spec.ts`); each has its own database. */
const SOVEREIGN_PORT = PORTS.sovereign;
const BOTH_PORT = PORTS.both;
/** An instance that takes accounts by invitation: the first account, and whoever holds an invitation (`e2e/people.spec.ts`). */
const INVITE_PORT = PORTS.invite;
/** The fake Sovereign (`e2e/fake-sovereign-server.ts`) and how an instance is told to sign in through it. */
const CORE = {
  WAYMARK_CORE_URL: `http://localhost:${PORTS.coreAuth}/api/auth`,
  WAYMARK_CORE_CLIENT_ID: 'waymark-e2e-client',
  WAYMARK_CORE_CLIENT_SECRET: 'waymark-e2e-secret',
};
const SECRET = 'e2e-only-secret-not-for-anything-real-0123456789';
// Playwright loads this file again in every worker: the first load makes the directory and the others, which inherit the variable, use it.
const directory = process.env.WAYMARK_E2E_DIR || mkdtempSync(join(tmpdir(), 'waymark-e2e-'));
process.env.WAYMARK_E2E_DIR = directory;

// Next reads `.env.local` and does not override what is already set, so a developer's own settings there would reach this instance. Setting a
// name, even to nothing, keeps it out: an empty value is "not set" to the app.
const BLANK = Object.fromEntries(
  [
    'WAYMARK_URL',
    'WAYMARK_AUTH_LOCAL',
    'WAYMARK_AUTH_SECRET',
    'WAYMARK_AUTH_SIGNUP',
    'WAYMARK_CORE_URL',
    'WAYMARK_CORE_CLIENT_ID',
    'WAYMARK_CORE_CLIENT_SECRET',
    'WAYMARK_CORE_CLIENT_SECRET_FILE',
    'WAYMARK_SMTP_HOST',
    'WAYMARK_WORKER',
    'WAYMARK_ENCRYPTION_KEY',
    'WAYMARK_DATA_DIR',
    'WAYMARK_MEDIA_MAX_ACCOUNT_MB',
    'WAYMARK_PLACES_URL',
    'WAYMARK_MAP_UPSTREAM_URL',
    'WAYMARK_MAP_PMTILES_PATH',
    'WAYMARK_MAP_CACHE_MAX_MB',
  ].map((name) => [name, '']),
);
// A browser test never reaches a place search on the internet: with none named, there is none. The task that searches in the browser (7.2) starts the fake of `src/places/fake.ts`.
BLANK.WAYMARK_PLACES_PROVIDER = 'off';
// (The main instance is given the fake place search below, which reaches nothing.)
// Nor a map tile service: the browser tests have no map, and so no request to a tile upstream.
BLANK.WAYMARK_MAP_SOURCE = 'off';

// The map of the main instance is read from a PMTiles file made here (two tiles), so that the routes are tried for real, with nothing fetched from anyone.
const MAP_FILE = join(directory, 'map', 'region.pmtiles');
mkdirSync(join(directory, 'map'), { recursive: true });
writeFileSync(
  MAP_FILE,
  makePmtiles([
    { z: 0, x: 0, y: 0, data: Buffer.from('tile-zero') },
    { z: 1, x: 0, y: 1, data: Buffer.from('tile-one') },
  ]),
);

// A directory of its own for another instance: the auth database is `waymark_auth.db` beside the app's, so two instances in one directory would share their
// accounts, and a session cookie (which a port does not separate) would sign a person in on both.
const own = (name: string): string => {
  const folder = join(directory, name);
  mkdirSync(folder, { recursive: true });
  return join(folder, 'waymark.db');
};

// With no database named, a file in a directory of its own: the auth database is `waymark_auth.db` beside the app's, and a developer's data is not
// touched.
const database = process.env.WAYMARK_DB_DIALECT
  ? {}
  : {
      WAYMARK_DB_DIALECT: 'sqlite',
      WAYMARK_SQLITE_URL: `file:${join(directory, 'waymark.db')}`,
    };

export default defineConfig({
  testDir: 'e2e',
  // One at a time: the instance shares one database, and the tests are quick.
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: { baseURL: `http://localhost:${PORT}`, trace: 'retain-on-failure' },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
  webServer: [
    // First, so that it is up when the instances that sign in through it start and discover it.
    {
      command: 'node e2e/fake-sovereign-server.ts',
      url: `http://localhost:${PORTS.coreControl}/health`,
      timeout: 30_000,
      reuseExistingServer: false,
    },
    {
      // A place search of a few real places, answered as Nominatim answers, which reaches nothing: what the main instance searches (DESIGN.md §7.2).
      command: 'node scripts/fake-places.mjs',
      url: `http://127.0.0.1:${PORTS.places}/search?q=tokyo`,
      timeout: 30_000,
      reuseExistingServer: false,
      env: { PORT: String(PORTS.places) },
    },
    {
      command: `node scripts/serve-standalone.mjs ${PORT}`,
      url: `http://localhost:${PORT}/api/health`,
      timeout: 90_000,
      reuseExistingServer: false,
      env: {
        ...BLANK,
        ...database,
        WAYMARK_URL: `http://localhost:${PORT}`,
        WAYMARK_DATA_DIR: join(directory, 'data'),
        WAYMARK_AUTH_LOCAL: '1',
        WAYMARK_AUTH_SECRET: SECRET,
        WAYMARK_AUTH_SIGNUP: 'closed',
        WAYMARK_PLACES_PROVIDER: 'nominatim',
        WAYMARK_PLACES_URL: `http://127.0.0.1:${PORTS.places}`,
        WAYMARK_MAP_SOURCE: 'pmtiles',
        WAYMARK_MAP_PMTILES_PATH: MAP_FILE,
        WAYMARK_ENCRYPTION_KEY: 'e2e0e2e0e2e0e2e0e2e0e2e0e2e0e2e0e2e0e2e0e2e0e2e0e2e0e2e0e2e0e2e0',
      } as Record<string, string>,
    },
    {
      command: `node scripts/serve-standalone.mjs ${OFF_PORT}`,
      url: `http://localhost:${OFF_PORT}/api/health`,
      timeout: 90_000,
      reuseExistingServer: false,
      env: {
        ...BLANK,
        WAYMARK_DB_DIALECT: 'sqlite',
        WAYMARK_SQLITE_URL: `file:${own('off')}`,
        WAYMARK_URL: `http://localhost:${OFF_PORT}`,
        WAYMARK_DATA_DIR: join(directory, 'off-data'),
        WAYMARK_ENCRYPTION_KEY: 'e2e0e2e0e2e0e2e0e2e0e2e0e2e0e2e0e2e0e2e0e2e0e2e0e2e0e2e0e2e0e2e0',
      } as Record<string, string>,
    },
    {
      // Sovereign only, and sign-up closed: a core decides who may sign in to it, so this does not turn its people away.
      command: `node scripts/serve-standalone.mjs ${SOVEREIGN_PORT}`,
      url: `http://localhost:${SOVEREIGN_PORT}/api/health`,
      timeout: 90_000,
      reuseExistingServer: false,
      env: {
        ...BLANK,
        WAYMARK_DB_DIALECT: 'sqlite',
        WAYMARK_SQLITE_URL: `file:${own('sovereign')}`,
        WAYMARK_URL: `http://localhost:${SOVEREIGN_PORT}`,
        WAYMARK_DATA_DIR: join(directory, 'sovereign-data'),
        WAYMARK_AUTH_SECRET: SECRET,
        WAYMARK_AUTH_SIGNUP: 'closed',
        WAYMARK_ENCRYPTION_KEY: 'e2e0e2e0e2e0e2e0e2e0e2e0e2e0e2e0e2e0e2e0e2e0e2e0e2e0e2e0e2e0e2e0',
        ...CORE,
      } as Record<string, string>,
    },
    {
      // Both ways, sign-up open.
      command: `node scripts/serve-standalone.mjs ${BOTH_PORT}`,
      url: `http://localhost:${BOTH_PORT}/api/health`,
      timeout: 90_000,
      reuseExistingServer: false,
      env: {
        ...BLANK,
        WAYMARK_DB_DIALECT: 'sqlite',
        WAYMARK_SQLITE_URL: `file:${own('both')}`,
        WAYMARK_URL: `http://localhost:${BOTH_PORT}`,
        WAYMARK_DATA_DIR: join(directory, 'both-data'),
        WAYMARK_AUTH_LOCAL: '1',
        WAYMARK_AUTH_SECRET: SECRET,
        WAYMARK_AUTH_SIGNUP: 'open',
        WAYMARK_ENCRYPTION_KEY: 'e2e0e2e0e2e0e2e0e2e0e2e0e2e0e2e0e2e0e2e0e2e0e2e0e2e0e2e0e2e0e2e0',
        ...CORE,
      } as Record<string, string>,
    },
    {
      // Accounts by invitation: the first account is made by sign-up, and the next ones by whoever holds an invitation to a trip.
      command: `node scripts/serve-standalone.mjs ${INVITE_PORT}`,
      url: `http://localhost:${INVITE_PORT}/api/health`,
      timeout: 90_000,
      reuseExistingServer: false,
      env: {
        ...BLANK,
        WAYMARK_DB_DIALECT: 'sqlite',
        WAYMARK_SQLITE_URL: `file:${own('invite')}`,
        WAYMARK_URL: `http://localhost:${INVITE_PORT}`,
        WAYMARK_DATA_DIR: join(directory, 'invite-data'),
        WAYMARK_AUTH_LOCAL: '1',
        WAYMARK_AUTH_SECRET: SECRET,
        WAYMARK_AUTH_SIGNUP: 'invite',
        WAYMARK_ENCRYPTION_KEY: 'e2e0e2e0e2e0e2e0e2e0e2e0e2e0e2e0e2e0e2e0e2e0e2e0e2e0e2e0e2e0e2e0',
      } as Record<string, string>,
    },
  ],
});
