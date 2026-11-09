import { sql } from 'drizzle-orm';
import { getDatabase } from '@/src/db/boot';
import { dbGet } from '@/src/db/exec';

export const dynamic = 'force-dynamic';

/**
 * The instance asks this before it sends anyone to the app (the manifest's `health`), and a container's health check and CI ask it too. It
 * answers 200 only when the database does, and says which dialect it is talking to, so that a fresh instance can be checked against the one it
 * was told to use (scripts/boot-check.mjs). That `/data` is writable joins when the first thing is stored there (3.2).
 */
export async function GET() {
  try {
    const database = await getDatabase();
    await dbGet(database, sql`SELECT 1 AS one`);
    return Response.json(
      { status: 'ok', database: database.dialect },
      { headers: { 'cache-control': 'no-store' } },
    );
  } catch {
    // Not the error: it can name an address, and this is answered to anyone.
    return Response.json(
      { status: 'database unavailable' },
      { status: 503, headers: { 'cache-control': 'no-store' } },
    );
  }
}
