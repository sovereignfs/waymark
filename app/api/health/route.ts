import { sql } from 'drizzle-orm';
import { access, constants, mkdir } from 'node:fs/promises';
import { getConfig } from '@/src/config/current';
import { rotationOf } from '@/src/crypto/rotate';
import { getDatabase } from '@/src/db/boot';
import { dbGet } from '@/src/db/exec';

export const dynamic = 'force-dynamic';

/**
 * The instance asks this before it sends anyone to the app (the manifest's `health`), and a container's health check and CI ask it too. It answers 200 only when the database
 * does **and the data directory (`/data`) is writable**, since photos and files are written there (DESIGN.md §25), and says which dialect it is talking to, so that a fresh
 * instance can be checked against the one it was told to use (scripts/boot-check.mjs).
 */
export async function GET() {
  try {
    const database = await getDatabase();
    await dbGet(database, sql`SELECT 1 AS one`);
    const dataDir = getConfig().media.dataDir;
    await mkdir(dataDir, { recursive: true });
    await access(dataDir, constants.W_OK);
    // While a previous key is given beside the instance key, it says whether the rotation to the new one is under way or complete (the cue that the previous key can be removed): nothing else about keys.
    const rotation = await rotationOf(database, getConfig().encryption);
    return Response.json(
      {
        status: 'ok',
        database: database.dialect,
        ...(rotation.state === 'none'
          ? {}
          : { keyRotation: rotation.state === 'done' ? 'complete' : 'in_progress' }),
      },
      { headers: { 'cache-control': 'no-store' } },
    );
  } catch {
    // Not the error: it can name an address or a path, and this is answered to anyone.
    return Response.json(
      { status: 'unavailable' },
      { status: 503, headers: { 'cache-control': 'no-store' } },
    );
  }
}
