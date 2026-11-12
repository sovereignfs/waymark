import path from 'node:path';
import { sql } from 'drizzle-orm';
import { type AuthSettings } from '../auth/config';
import { createAuth } from '../auth/auth';
import * as postgresAuth from '../db/schema/postgres/auth';
import * as sqliteAuth from '../db/schema/sqlite/auth';
import type { KeyRing } from '../crypto/keys';
import type { Sealer } from '../crypto/sealed';
import type { Database } from '../db/client';
import { dbGet } from '../db/exec';
import { type ImportDeps, type ImportItem, STEP_ITEMS, applyBatch } from '../import/job';
import { mediaDirOf } from '../media/files';
import { createProfile } from '../profile/profile';
import { DECADE, type SeedOptions, generateCheckins } from './checkins';
import { pictureOf } from './images';

/**
 * **The development seed** (task 16.1; DESIGN.md §25 Testing): accounts, and for each the check-ins that make every screen of the phase worth looking at. It is made of the app's own parts and nothing
 * beside them. Accounts are signed up through better-auth as a person would be (so there is a profile, sealed, as for anyone), and check-ins, places and photos go in through **the one write path**,
 * the way an import's do. Running it twice makes nothing twice: the ids are made from the account and the date, and an account that is there is found by its address.
 *
 * It does not decide whether the database is a development one: `main.ts` asks `guard.ts` first.
 */
export interface SeedAccount {
  readonly name: string;
  readonly email: string;
  /** What the account has: a decade of a full life, a year of a quiet one, or nothing (to see the empty screens). */
  readonly life: 'decade' | 'year' | 'none';
}

/** The password of every seeded account. It is in this repository on purpose: the accounts exist on development databases only (`guard.ts`). */
export const SEED_PASSWORD = 'waymark-seed-password';

export const ACCOUNTS: readonly SeedAccount[] = [
  { name: 'Ada Seed', email: 'ada@seed.waymark.test', life: 'decade' },
  { name: 'Grace Seed', email: 'grace@seed.waymark.test', life: 'year' },
  { name: 'Nell Seed', email: 'nell@seed.waymark.test', life: 'none' },
];

export interface SeedDeps {
  readonly app: Database;
  readonly auth: Database;
  readonly sealer: Sealer;
  readonly ring: KeyRing;
  readonly settings: AuthSettings;
  /** `WAYMARK_DATA_DIR`. */
  readonly dataDir: string;
  readonly maxAccountBytes: number;
  readonly now: () => number;
  /** Fewer years than the seed's own, for a test: the most that any account goes back. */
  readonly years?: number | undefined;
  readonly log?: (line: string) => void;
}

export interface Seeded {
  readonly email: string;
  readonly accountId: string;
  readonly created: boolean;
  readonly checkins: number;
  readonly places: number;
  readonly photos: number;
  readonly skipped: number;
}

const BATCH = STEP_ITEMS;

/** The account with this address, or undefined. */
async function accountIdOf(database: Database, email: string): Promise<string | undefined> {
  const table = database.dialect === 'postgres' ? postgresAuth.user : sqliteAuth.user;
  const row = await dbGet<{ id: string }>(
    database,
    sql`SELECT id FROM ${table} WHERE email = ${email}`,
  );
  return row?.id;
}

async function ensureAccount(
  deps: SeedDeps,
  account: SeedAccount,
): Promise<{ id: string; created: boolean }> {
  const found = await accountIdOf(deps.auth, account.email);
  if (found) return { id: found, created: false };
  // Sign-up is open for the seed's own instance of better-auth, whatever the app's setting: the seed is the one making the accounts. The profile is made by the same hook the server uses.
  const auth = createAuth({
    settings: { ...deps.settings, signUp: 'open', local: true },
    name: 'Waymark',
    database: deps.auth,
    mailer: undefined,
    onAccountCreated: async (made) => {
      await createProfile(
        deps.app,
        deps.sealer,
        { accountId: made.id, name: made.name, email: made.email },
        deps.now(),
      );
    },
  });
  await auth.api.signUpEmail({
    body: { name: account.name, email: account.email, password: SEED_PASSWORD },
  });
  const id = await accountIdOf(deps.auth, account.email);
  if (!id) throw new Error('the account was not made');
  return { id, created: true };
}

function optionsFor(
  account: SeedAccount,
  now: number,
  years: number | undefined,
): SeedOptions | undefined {
  if (account.life === 'none') return undefined;
  const salt = account.email.split('@')[0] ?? 'seed';
  const options: SeedOptions =
    account.life === 'decade'
      ? { ...DECADE, now, salt, photo: pictureOf }
      : { now, salt, years: 1, density: 0.3, tripsPerYear: 2, photo: pictureOf };
  return years === undefined ? options : { ...options, years: Math.min(options.years, years) };
}

/** Makes the check-ins of one account, a batch at a time, and counts what was made. */
async function seedCheckins(
  deps: SeedDeps,
  accountId: string,
  options: SeedOptions,
): Promise<Pick<Seeded, 'checkins' | 'places' | 'photos' | 'skipped'>> {
  const importing: ImportDeps = {
    database: deps.app,
    sealer: deps.sealer,
    ring: deps.ring,
    dir: path.join(deps.dataDir, 'imports'),
    workDir: path.join(deps.dataDir, 'tmp'),
    now: deps.now,
    readers: {},
    media: {
      database: deps.app,
      ring: deps.ring,
      dir: mediaDirOf(deps.dataDir),
      maxAccountBytes: deps.maxAccountBytes,
      now: deps.now,
    },
  };
  // One mutation id for a batch is made from the job's and the batch's number, and a mutation seen before writes nothing: so the job is named for the day, and a run on another day, whose batches are
  // different, is not mistaken for this one's.
  const job = {
    id: `seed-${new Date(deps.now()).toISOString().slice(0, 10)}`,
    accountId,
    source: 'waymark' as const,
  };
  const total = { checkins: 0, places: 0, photos: 0, skipped: 0 };
  let batch: ImportItem[] = [];
  let cursor = 0;
  const flush = async () => {
    if (batch.length === 0) return;
    const applied = await applyBatch(importing, job, cursor, batch);
    total.checkins += applied.checkins;
    total.places += applied.places;
    total.photos += applied.photos;
    total.skipped += applied.skipped;
    cursor += batch.length;
    batch = [];
  };
  for (const item of generateCheckins(options)) {
    batch.push(item);
    if (batch.length >= BATCH) await flush();
  }
  await flush();
  return total;
}

/** Seeds every account. Safe to run again: it makes what is missing. */
export async function runSeed(deps: SeedDeps): Promise<Seeded[]> {
  const log = deps.log ?? (() => undefined);
  const done: Seeded[] = [];
  for (const account of ACCOUNTS) {
    const { id, created } = await ensureAccount(deps, account);
    log(`${created ? 'made' : 'found'} ${account.email}`);
    const options = optionsFor(account, deps.now(), deps.years);
    const made = options
      ? await seedCheckins(deps, id, options)
      : { checkins: 0, places: 0, photos: 0, skipped: 0 };
    log(
      `  ${made.checkins.toLocaleString('en-GB')} check-ins, ${made.places.toLocaleString('en-GB')} places, ${made.photos.toLocaleString('en-GB')} photos`,
    );
    done.push({ email: account.email, accountId: id, created, ...made });
  }
  return done;
}
