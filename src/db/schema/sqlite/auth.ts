import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { epochMs } from './columns';

/**
 * better-auth's tables, in the auth store (`waymark_auth`, DESIGN.md §24.1). Their shape is
 * better-auth's, not ours: it reads and writes through its Drizzle adapter, which looks a
 * table up by the key it is exported under, so the keys are its model names, and its dates
 * are real `Date` values (`timestamp_ms` here, `timestamp` on PostgreSQL) and not the epoch
 * milliseconds of our own tables. The tables are what better-auth 1.7 reports it needs for
 * email and password and database-backed rate limits. Two-factor and passkeys have theirs below (task 2.4).
 *
 * Changed only with a better-auth upgrade, from what it reports (see `auth.test.ts`).
 */
const timestamp = (name: string) => integer(name, { mode: 'timestamp_ms' });
const boolean = (name: string) => integer(name, { mode: 'boolean' });

export const user = sqliteTable('user', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: boolean('email_verified').notNull().default(false),
  image: text('image'),
  /** Whether an authenticator app is on for the account (the two-factor plugin). */
  twoFactorEnabled: boolean('two_factor_enabled').default(false),
  createdAt: timestamp('created_at').notNull(),
  updatedAt: timestamp('updated_at').notNull(),
});

export const session = sqliteTable(
  'session',
  {
    id: text('id').primaryKey(),
    expiresAt: timestamp('expires_at').notNull(),
    token: text('token').notNull().unique(),
    createdAt: timestamp('created_at').notNull(),
    updatedAt: timestamp('updated_at').notNull(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
  },
  (table) => [index('session_user_id_idx').on(table.userId)],
);

export const account = sqliteTable(
  'account',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id').notNull(),
    providerId: text('provider_id').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    idToken: text('id_token'),
    accessTokenExpiresAt: timestamp('access_token_expires_at'),
    refreshTokenExpiresAt: timestamp('refresh_token_expires_at'),
    scope: text('scope'),
    password: text('password'),
    createdAt: timestamp('created_at').notNull(),
    updatedAt: timestamp('updated_at').notNull(),
  },
  (table) => [index('account_user_id_idx').on(table.userId)],
);

export const verification = sqliteTable(
  'verification',
  {
    id: text('id').primaryKey(),
    identifier: text('identifier').notNull(),
    value: text('value').notNull(),
    expiresAt: timestamp('expires_at').notNull(),
    createdAt: timestamp('created_at').notNull(),
    updatedAt: timestamp('updated_at').notNull(),
  },
  (table) => [index('verification_identifier_idx').on(table.identifier)],
);

/** The authenticator secret and the backup codes of an account (the two-factor plugin), sealed by it; `verified` is false until a code has been shown to work. */
export const twoFactor = sqliteTable(
  'two_factor',
  {
    id: text('id').primaryKey(),
    secret: text('secret').notNull(),
    backupCodes: text('backup_codes').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    verified: boolean('verified').default(true),
    failedVerificationCount: integer('failed_verification_count').default(0),
    lockedUntil: timestamp('locked_until'),
  },
  (table) => [
    index('two_factor_secret_idx').on(table.secret),
    index('two_factor_user_id_idx').on(table.userId),
  ],
);

/** A passkey of an account (the passkey plugin). */
export const passkey = sqliteTable(
  'passkey',
  {
    id: text('id').primaryKey(),
    name: text('name'),
    publicKey: text('public_key').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    credentialID: text('credential_id').notNull(),
    counter: integer('counter').notNull(),
    deviceType: text('device_type').notNull(),
    backedUp: boolean('backed_up').notNull(),
    transports: text('transports'),
    createdAt: timestamp('created_at'),
    aaguid: text('aaguid'),
  },
  (table) => [
    index('passkey_user_id_idx').on(table.userId),
    index('passkey_credential_id_idx').on(table.credentialID),
  ],
);

/** Request counts per key, so a limit holds across every process (DESIGN.md §25). */
export const rateLimit = sqliteTable('rate_limit', {
  id: text('id').primaryKey(),
  key: text('key').notNull().unique(),
  count: integer('count').notNull(),
  lastRequest: epochMs('last_request').notNull(),
});
