import { boolean, index, integer, pgSchema, text, timestamp } from 'drizzle-orm/pg-core';
import { AUTH_STORE } from '../../config';
import { epochMs } from './columns';

/** The auth store's schema; the app's is `waymark`. */
export const auth = pgSchema(AUTH_STORE);

/**
 * better-auth's tables on PostgreSQL; the same tables as `schema/sqlite/auth.ts`, which
 * says why they have the shape they have. The schema parity test keeps the two equal.
 */
const date = (name: string) => timestamp(name, { withTimezone: true });

export const user = auth.table('user', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: boolean('email_verified').notNull().default(false),
  image: text('image'),
  /** Whether an authenticator app is on for the account (the two-factor plugin). */
  twoFactorEnabled: boolean('two_factor_enabled').default(false),
  createdAt: date('created_at').notNull(),
  updatedAt: date('updated_at').notNull(),
});

export const session = auth.table(
  'session',
  {
    id: text('id').primaryKey(),
    expiresAt: date('expires_at').notNull(),
    token: text('token').notNull().unique(),
    createdAt: date('created_at').notNull(),
    updatedAt: date('updated_at').notNull(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
  },
  (table) => [index('session_user_id_idx').on(table.userId)],
);

export const account = auth.table(
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
    accessTokenExpiresAt: date('access_token_expires_at'),
    refreshTokenExpiresAt: date('refresh_token_expires_at'),
    scope: text('scope'),
    password: text('password'),
    createdAt: date('created_at').notNull(),
    updatedAt: date('updated_at').notNull(),
  },
  (table) => [index('account_user_id_idx').on(table.userId)],
);

export const verification = auth.table(
  'verification',
  {
    id: text('id').primaryKey(),
    identifier: text('identifier').notNull(),
    value: text('value').notNull(),
    expiresAt: date('expires_at').notNull(),
    createdAt: date('created_at').notNull(),
    updatedAt: date('updated_at').notNull(),
  },
  (table) => [index('verification_identifier_idx').on(table.identifier)],
);

/** The authenticator secret and the backup codes of an account (the two-factor plugin), sealed by it; `verified` is false until a code has been shown to work. */
export const twoFactor = auth.table(
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
    lockedUntil: date('locked_until'),
  },
  (table) => [
    index('two_factor_secret_idx').on(table.secret),
    index('two_factor_user_id_idx').on(table.userId),
  ],
);

/** A passkey of an account (the passkey plugin). */
export const passkey = auth.table(
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
    createdAt: date('created_at'),
    aaguid: text('aaguid'),
  },
  (table) => [
    index('passkey_user_id_idx').on(table.userId),
    index('passkey_credential_id_idx').on(table.credentialID),
  ],
);

/** Request counts per key, so a limit holds across every process (DESIGN.md §25). */
export const rateLimit = auth.table('rate_limit', {
  id: text('id').primaryKey(),
  key: text('key').notNull().unique(),
  count: integer('count').notNull(),
  lastRequest: epochMs('last_request').notNull(),
});
