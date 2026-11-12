import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAuth } from '../auth/auth';
import type { AuthSettings } from '../auth/config';
import { ringOf } from '../crypto/keys';
import { Sealer } from '../crypto/sealed';
import type { Database } from '../db/client';
import { dbGet } from '../db/exec';
import { runMigrations } from '../db/migrate';
import { freshDatabase, openAppBesideAuth, testTarget } from '../db/test-support';
import { mediaDirOf } from '../media/files';
import { getProfile } from '../profile/profile';
import { ACCOUNTS, SEED_PASSWORD, runSeed } from './run';

/**
 * The seed on whichever database the leg runs on (task 16.1): accounts that can sign in, a profile for each, check-ins and photos through the write path, and a second run that makes nothing.
 */
const { leg } = testTarget();
const ring = ringOf(randomBytes(32));
if (!ring) throw new Error('no ring');
const sealer = new Sealer(ring);
const NOW = Date.UTC(2026, 10, 12, 9, 0, 0);
const SETTINGS: AuthSettings = {
  url: 'http://localhost:3005',
  secret: 'test-secret-'.padEnd(40, 'x'),
  signUp: 'closed',
  passwordMinLength: 10,
  local: true,
  sovereign: undefined,
};

let auth: Database;
let app: Database;
let closeApp: () => Promise<void>;
let dataDir: string;
let first: Awaited<ReturnType<typeof runSeed>>;

const count = async (
  database: Database,
  table: string,
  accountId?: string,
  schema = 'waymark',
): Promise<number> => {
  const name = sql.raw(database.dialect === 'postgres' ? `${schema}.${table}` : table);
  const where = accountId === undefined ? sql`` : sql`WHERE account_id = ${accountId}`;
  const row = await dbGet<{ n: number | string }>(
    database,
    sql`SELECT COUNT(*) AS n FROM ${name} ${where}`,
  );
  return Number(row?.n ?? 0);
};

const deps = () => ({
  app,
  auth,
  sealer,
  ring,
  settings: SETTINGS,
  dataDir,
  maxAccountBytes: 500 * 1024 * 1024,
  now: () => NOW,
  years: 1,
});

beforeAll(async () => {
  ({ database: auth } = await freshDatabase('auth'));
  await runMigrations(auth);
  ({ database: app, close: closeApp } = await openAppBesideAuth());
  dataDir = mkdtempSync(path.join(tmpdir(), 'waymark-seed-'));
  first = await runSeed(deps());
}, 120_000);
afterAll(async () => {
  await closeApp?.();
  await auth?.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe(`the seed on ${leg}`, () => {
  it('makes the accounts, each with a profile, and a person can sign in with the seed’s password', async () => {
    expect(first.map((each) => each.email)).toEqual(ACCOUNTS.map((each) => each.email));
    expect(first.every((each) => each.created)).toBe(true);
    for (const account of ACCOUNTS) {
      const made = first.find((each) => each.email === account.email);
      const profile = await getProfile(app, sealer, made?.accountId ?? '');
      expect(profile?.name).toBe(account.name);
      expect(profile?.email).toBe(account.email);
    }
    const signIn = createAuth({ settings: SETTINGS, name: 'Waymark', database: auth });
    const reply = await signIn.handler(
      new Request('http://localhost:3005/api/auth/sign-in/email', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'http://localhost:3005' },
        body: JSON.stringify({ email: ACCOUNTS[0]?.email, password: SEED_PASSWORD }),
      }),
    );
    expect(reply.status).toBe(200);
  });

  it('gives each life its check-ins: a busy one, a quiet one and none', async () => {
    const [ada, grace, nell] = first;
    expect(ada?.checkins).toBeGreaterThan(100);
    expect(grace?.checkins).toBeGreaterThan(20);
    expect(grace?.checkins).toBeLessThan(ada?.checkins ?? 0);
    expect(nell?.checkins).toBe(0);
    expect(await count(app, 'checkin', ada?.accountId)).toBe(ada?.checkins);
    expect(await count(app, 'checkin', nell?.accountId)).toBe(0);
    expect(await count(app, 'place', ada?.accountId)).toBe(ada?.places);
    // Each person's rows are their own.
    expect(await count(app, 'checkin')).toBe((ada?.checkins ?? 0) + (grace?.checkins ?? 0));
  });

  it('stores the photos as files, and skips nothing', async () => {
    const ada = first[0];
    expect(ada?.photos).toBeGreaterThan(5);
    expect(ada?.skipped).toBe(0);
    expect(await count(app, 'media', ada?.accountId)).toBeGreaterThanOrEqual(ada?.photos ?? 0);
    const media = mediaDirOf(dataDir);
    expect(existsSync(media)).toBe(true);
    const files = readdirSync(media, { recursive: true, withFileTypes: true }).filter((each) =>
      each.isFile(),
    );
    expect(files.length).toBeGreaterThanOrEqual(ada?.photos ?? 0);
  });

  it('makes nothing the second time it runs, on the same day or another', async () => {
    for (const now of [NOW, NOW + 86_400_000]) {
      const again = await runSeed({ ...deps(), now: () => now });
      expect(again.every((each) => !each.created)).toBe(true);
      // A day later there may be the new day's check-ins, a handful at most; the same day, none.
      const made = again.reduce((sum, each) => sum + each.checkins, 0);
      expect(made).toBeLessThanOrEqual(now === NOW ? 0 : 8);
    }
    expect(await count(auth, 'user', undefined, 'waymark_auth')).toBe(ACCOUNTS.length);
  });
});
