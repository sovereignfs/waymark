import { index, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { counter, epochMs, id, ref, sealed } from './columns';

/**
 * What the server holds that is not better-auth's (DESIGN.md §24.3). The account itself is better-auth's, in the other store, so an `account_id` is a
 * reference by value and not a foreign key. The tables of later tasks are added by their own migrations, one `pnpm db:generate` each.
 */

/**
 * Counts for rate limits, in the database so that a limit holds across every process: a key, when its window began, and how many have been counted
 * in it (`src/limits/rate.ts`). Swept when a window is long over. No key is a person's name or address in the clear: a caller hashes what it keys by.
 */
export const rateBucket = sqliteTable(
  'rate_bucket',
  {
    key: id('key'),
    windowStart: epochMs('window_start').notNull(),
    count: counter('count').notNull(),
  },
  (table) => [index('rate_bucket_window_idx').on(table.windowStart)],
);

/**
 * A lease on a job that has no row of its own to claim (`src/jobs/claim.ts`, `claimJob`): a periodic sweep, say. A process takes the lease by one
 * conditional statement, and only the one that did runs the job until `claimed_until`. A job with rows (an import, a mail in the outbox) claims the row.
 */
export const jobClaim = sqliteTable('job_claim', {
  job: id('job'),
  claimedUntil: epochMs('claimed_until').notNull(),
});

/**
 * Waymark's own copy of an account's name and email, made with the account and kept in step from Settings (DESIGN.md §6.1), as Tally keeps `person`. The account is
 * better-auth's, in the other store, so `account_id` is a reference by value. **The name and the email are sealed** (`SEALED.profile`); what is plain is what the
 * app reads without them: the account's identity at core (`core_sub`, an opaque id and not a name), and a person's choices (`units`, `km` or `mi`; `week_start`, 0
 * for Sunday to 6; `share_default`, `ask`, `on` or `off`, DESIGN.md §11.3).
 */
export const profile = sqliteTable('profile', {
  accountId: ref('account_id').primaryKey(),
  coreSub: ref('core_sub'),
  units: text('units').notNull().default('km'),
  weekStart: counter('week_start').notNull().default(1),
  shareDefault: text('share_default').notNull().default('ask'),
  sealed: sealed('sealed').notNull(),
  createdAt: epochMs('created_at').notNull(),
  updatedAt: epochMs('updated_at').notNull(),
});

/**
 * A file's row (DESIGN.md §18.3, §24.3): a photo, its thumbnail, an attachment or an uploaded import. **The file is under `/data/media`, named by this id, sealed with a data key
 * of its own**; the row holds only what the database must count and join by: the owner (`account_id`, or `trip_id` for a trip's file, exactly one), the `kind`, the stored `type`,
 * the `bytes` stored, and whether the file is `ready` (written) or still `pending` (a row made before its file, which a sweep removes if the file never comes). A file is read only
 * through `/api/media/<id>` after the access check.
 */
export const media = sqliteTable(
  'media',
  {
    id: id('id'),
    accountId: ref('account_id'),
    tripId: ref('trip_id'),
    kind: text('kind').notNull(),
    type: text('type').notNull(),
    bytes: counter('bytes').notNull(),
    state: text('state').notNull().default('pending'),
    createdAt: epochMs('created_at').notNull(),
  },
  (table) => [
    index('media_account_idx').on(table.accountId),
    index('media_trip_idx').on(table.tripId),
  ],
);
