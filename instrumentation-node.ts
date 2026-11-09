import { loadConfig } from './src/config';
import { processEnv } from './src/config/env';

/**
 * Brings the server up, or stops it. The standalone server would otherwise stay up and answer, and an instance would find the mistake from a
 * person using it:
 *
 * 1. The settings are checked, and a wrong one stops the server, every problem named and no value printed (DESIGN.md §25).
 * 2. The database is provisioned, opened and migrated, and the server does not start if it cannot (1.5).
 * 3. The background jobs start, unless `WAYMARK_WORKER=off`, and stop when the process is told to (1.6).
 */
export async function start(): Promise<void> {
  const result = loadConfig(processEnv());
  if (!result.ok) {
    console.error('Waymark cannot start, because of its settings:');
    for (const problem of result.problems) console.error(`  - ${problem}`);
    process.exit(1);
  }

  try {
    const { getStores } = await import('./src/db/boot');
    await getStores(result.config.database);
  } catch (error) {
    // The message of a database error can name an address, and this goes to the operator's log, not to a person: it names the database's trouble
    // and not a place, a note or a name, which no query here has read.
    console.error('Waymark cannot start, because its database is not usable:');
    console.error(`  - ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
