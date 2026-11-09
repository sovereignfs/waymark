import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig, devices } from '@playwright/test';
import { PORTS } from './e2e/ports.ts';

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
const SECRET = 'e2e-only-secret-not-for-anything-real-0123456789';
// Playwright loads this file again in every worker: the first load makes the directory and the others, which inherit the variable, use it.
const directory = process.env.WAYMARK_E2E_DIR ?? mkdtempSync(join(tmpdir(), 'waymark-e2e-'));
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
  ].map((name) => [name, '']),
);

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
    {
      command: `node scripts/serve-standalone.mjs ${PORT}`,
      url: `http://localhost:${PORT}/api/health`,
      timeout: 90_000,
      reuseExistingServer: false,
      env: {
        ...BLANK,
        ...database,
        WAYMARK_URL: `http://localhost:${PORT}`,
        WAYMARK_AUTH_SECRET: SECRET,
        WAYMARK_ENCRYPTION_KEY: 'e2e0e2e0e2e0e2e0e2e0e2e0e2e0e2e0e2e0e2e0e2e0e2e0e2e0e2e0e2e0e2e0',
      } as Record<string, string>,
    },
  ],
});
