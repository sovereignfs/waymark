import { index, pgSchema, text } from 'drizzle-orm/pg-core';
import { APP_STORE } from '../../config';
import { counter, epochMs, id, ref, sealed } from './columns';

/** The app's schema; better-auth's is `waymark_auth` (DESIGN.md §24.1). */
export const app = pgSchema(APP_STORE);

/** See `schema/sqlite/app.ts`. */
export const rateBucket = app.table(
  'rate_bucket',
  {
    key: id('key'),
    windowStart: epochMs('window_start').notNull(),
    count: counter('count').notNull(),
  },
  (table) => [index('rate_bucket_window_idx').on(table.windowStart)],
);

/** See `schema/sqlite/app.ts`. */
export const jobClaim = app.table('job_claim', {
  job: id('job'),
  claimedUntil: epochMs('claimed_until').notNull(),
});

/** See `schema/sqlite/app.ts`. */
export const profile = app.table('profile', {
  accountId: ref('account_id').primaryKey(),
  coreSub: ref('core_sub'),
  units: text('units').notNull().default('km'),
  weekStart: counter('week_start').notNull().default(1),
  shareDefault: text('share_default').notNull().default('ask'),
  sealed: sealed('sealed').notNull(),
  createdAt: epochMs('created_at').notNull(),
  updatedAt: epochMs('updated_at').notNull(),
});
