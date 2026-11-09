import { sql } from 'drizzle-orm';
import type { Database } from '../db/client';
import { dbAll, dbRun } from '../db/exec';
import * as postgresSchema from '../db/schema/postgres';
import * as sqliteSchema from '../db/schema/sqlite';

/**
 * Rate limits (DESIGN.md §25): at most `limit` of a kind of thing by one holder (an account, an address) in a window. Counted in the database, as the
 * sign-in limits are, so that the limit holds across every process, and in a **fixed window**: the first count starts a window of `windowMs`, the
 * counts in it add up, and the first count after it starts the next. A holder can therefore do up to twice the limit across the edge of two windows,
 * which is the price of one statement per count and no history to keep.
 *
 * A count is made in one statement (insert, or update the row that is there), so that many at once cannot all be let through by each reading a count
 * that the others have not added to. A count that is refused still counts: asking again at once does not get nearer to being let in.
 *
 * The rules are the caller's; this knows nothing of what is limited.
 */
export interface Rule {
  limit: number;
  windowMs: number;
}

export type Taken = { ok: true } | { ok: false; retryAfterMs: number };

export interface Limiter {
  /** Count one of `key` against `rule`, and say whether it may be. */
  take(key: string, rule: Rule): Promise<Taken>;
}

const table = (database: Database) =>
  database.dialect === 'postgres' ? postgresSchema.rateBucket : sqliteSchema.rateBucket;

/** How often (in counts made by one limiter) it sweeps up the rows whose window is long over. */
const SWEEP_EVERY = 200;
/** A row whose window began this long ago is of no use to any rule. */
export const KEEP_MS = 24 * 60 * 60 * 1000;

export class RateLimiter implements Limiter {
  private takes = 0;

  constructor(
    private readonly database: Database,
    private readonly now: () => number = Date.now,
  ) {}

  async take(key: string, rule: Rule): Promise<Taken> {
    const now = this.now();
    const rows = await dbAll<{ count: number | string; windowStart: number | string }>(
      this.database,
      sql`INSERT INTO ${table(this.database)} AS b ("key", window_start, "count") VALUES (${key}, ${now}, 1)
          ON CONFLICT ("key") DO UPDATE SET
            "count" = CASE WHEN ${now} - b.window_start >= ${rule.windowMs} THEN 1 ELSE b."count" + 1 END,
            window_start = CASE WHEN ${now} - b.window_start >= ${rule.windowMs} THEN ${now} ELSE b.window_start END
          RETURNING "count", window_start AS "windowStart"`,
    );
    if (++this.takes % SWEEP_EVERY === 0) await this.sweep();
    const row = rows[0];
    if (!row) throw new Error('a rate limit could not be counted');
    if (Number(row.count) <= rule.limit) return { ok: true };
    return { ok: false, retryAfterMs: Math.max(1, Number(row.windowStart) + rule.windowMs - now) };
  }

  /** Forget the rows whose window began more than a day ago. */
  async sweep(): Promise<void> {
    await dbRun(
      this.database,
      sql`DELETE FROM ${table(this.database)} WHERE window_start < ${this.now() - KEEP_MS}`,
    );
  }
}
