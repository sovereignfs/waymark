import { sql } from 'drizzle-orm';
import type { Database } from '../db/client';
import { dbAll, dbGet } from '../db/exec';
import * as postgresSchema from '../db/schema/postgres';
import * as sqliteSchema from '../db/schema/sqlite';
import type { Sealer } from '../crypto/sealed';

/**
 * Waymark's own copy of an account's name and email, and a person's choices (DESIGN.md §6.1, §21). **Names and emails are read from here and never from the auth
 * store or from core**, so no feature depends on core for who someone is. The name and email are sealed (3.1) and are the profile's only sealed fields: this is the one
 * place that writes or reads `profile.sealed`. Every statement names the account, which is the key.
 *
 * The profile is made when the account is (`createProfile`, from better-auth's hook after the sign-up policy), and **once**: the key is the account, so a second attempt
 * writes nothing, and `ensureProfile` makes the one an account somehow lacks (a hook that did not run) the first time it is read.
 */
export type Units = 'km' | 'mi';
export type ShareDefault = 'ask' | 'on' | 'off';

export interface Profile {
  readonly accountId: string;
  /** The account's `sub` at core, when it came in through core: an identity, never matched to anything by an email. */
  readonly coreSub: string | null;
  readonly name: string;
  readonly email: string;
  readonly units: Units;
  /** 0 for Sunday to 6 for Saturday. */
  readonly weekStart: number;
  readonly shareDefault: ShareDefault;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface NewProfile {
  readonly accountId: string;
  readonly name: string;
  readonly email: string;
  readonly coreSub?: string | undefined;
}

/** A value that is not a valid name, email or choice. The message says which, and never what it was given. */
export class ProfileError extends Error {
  override name = 'ProfileError';
}

const table = (database: Database) =>
  database.dialect === 'postgres' ? postgresSchema.profile : sqliteSchema.profile;

export const NAME_MAX = 100;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** A name as it is kept: trimmed, one to 100 characters, no line breaks. */
export function cleanName(name: string): string {
  const trimmed = name.trim();
  if (trimmed === '' || trimmed.length > NAME_MAX || /[\r\n]/.test(trimmed))
    throw new ProfileError(`a name is 1 to ${NAME_MAX} characters on one line`);
  return trimmed;
}

/** An email as it is kept: trimmed and lower case, with an `@` and a dot after it. */
export function cleanEmail(email: string): string {
  const trimmed = email.trim().toLowerCase();
  if (trimmed.length > 254 || !EMAIL.test(trimmed))
    throw new ProfileError('an email is an address with an @ and a dot after it');
  return trimmed;
}

interface Row {
  accountId: string;
  coreSub: string | null;
  units: string;
  weekStart: number | string;
  shareDefault: string;
  sealed: ArrayBuffer | Uint8Array;
  createdAt: number | string;
  updatedAt: number | string;
}

const COLUMNS = sql`account_id AS "accountId", core_sub AS "coreSub", units, week_start AS "weekStart", share_default AS "shareDefault", sealed, created_at AS "createdAt", updated_at AS "updatedAt"`;

function profileOf(sealer: Sealer, row: Row): Profile {
  const bytes = row.sealed instanceof Uint8Array ? row.sealed : new Uint8Array(row.sealed);
  const { name, email } = sealer.unseal('profile', row.accountId, bytes);
  return {
    accountId: row.accountId,
    coreSub: row.coreSub,
    name,
    email,
    units: row.units === 'mi' ? 'mi' : 'km',
    weekStart: Number(row.weekStart),
    shareDefault:
      row.shareDefault === 'on' || row.shareDefault === 'off' ? row.shareDefault : 'ask',
    createdAt: Number(row.createdAt),
    updatedAt: Number(row.updatedAt),
  };
}

/** Makes the account's profile. Returns whether it made one: an account has exactly one, so a second call writes nothing. */
export async function createProfile(
  database: Database,
  sealer: Sealer,
  input: NewProfile,
  now: number,
): Promise<boolean> {
  const name = cleanName(input.name);
  const email = cleanEmail(input.email);
  const sealed = sealer.seal('profile', input.accountId, { name, email });
  const written = await dbAll<{ accountId: string }>(
    database,
    sql`INSERT INTO ${table(database)} (account_id, core_sub, sealed, created_at, updated_at)
        VALUES (${input.accountId}, ${input.coreSub ?? null}, ${sealed}, ${now}, ${now})
        ON CONFLICT (account_id) DO NOTHING
        RETURNING account_id AS "accountId"`,
  );
  return written.length > 0;
}

/** The account's profile, or undefined. */
export async function getProfile(
  database: Database,
  sealer: Sealer,
  accountId: string,
): Promise<Profile | undefined> {
  const row = await dbGet<Row>(
    database,
    sql`SELECT ${COLUMNS} FROM ${table(database)} WHERE account_id = ${accountId}`,
  );
  return row ? profileOf(sealer, row) : undefined;
}

/** The account's profile, made first if it has none. */
export async function ensureProfile(
  database: Database,
  sealer: Sealer,
  input: NewProfile,
  now: number,
): Promise<Profile> {
  const existing = await getProfile(database, sealer, input.accountId);
  if (existing) return existing;
  await createProfile(database, sealer, input, now);
  const made = await getProfile(database, sealer, input.accountId);
  if (!made) throw new Error('a profile could not be made');
  return made;
}

export interface ProfilePatch {
  readonly name?: string;
  readonly email?: string;
  readonly units?: Units;
  readonly weekStart?: number;
  readonly shareDefault?: ShareDefault;
}

/** Changes what Settings changes (§21), for this account only. Returns the profile as it is now, or undefined if the account has none. */
export async function updateProfile(
  database: Database,
  sealer: Sealer,
  accountId: string,
  patch: ProfilePatch,
  now: number,
): Promise<Profile | undefined> {
  const current = await getProfile(database, sealer, accountId);
  if (!current) return undefined;
  const name = patch.name === undefined ? current.name : cleanName(patch.name);
  const email = patch.email === undefined ? current.email : cleanEmail(patch.email);
  if (patch.units !== undefined && patch.units !== 'km' && patch.units !== 'mi')
    throw new ProfileError('units are km or mi');
  if (
    patch.weekStart !== undefined &&
    (!Number.isInteger(patch.weekStart) || patch.weekStart < 0 || patch.weekStart > 6)
  )
    throw new ProfileError('the first day of the week is 0 (Sunday) to 6 (Saturday)');
  if (patch.shareDefault !== undefined && !['ask', 'on', 'off'].includes(patch.shareDefault))
    throw new ProfileError('sharing by default is ask, on or off');
  const sealed = sealer.seal('profile', accountId, { name, email });
  await dbAll(
    database,
    sql`UPDATE ${table(database)}
        SET sealed = ${sealed}, units = ${patch.units ?? current.units}, week_start = ${patch.weekStart ?? current.weekStart},
            share_default = ${patch.shareDefault ?? current.shareDefault}, updated_at = ${now}
        WHERE account_id = ${accountId}
        RETURNING account_id`,
  );
  return getProfile(database, sealer, accountId);
}
