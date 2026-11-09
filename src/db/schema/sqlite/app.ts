import { index, sqliteTable } from 'drizzle-orm/sqlite-core';
import { counter, epochMs, id } from './columns';

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
