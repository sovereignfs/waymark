// Runs the built, standalone server the way the image does, from a checkout: Next's standalone output holds the server and not its static
// files, which the image copies beside it (the Dockerfile), so this does the same, once.
import { cpSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../..');
const standalone = resolve(root, '.next/standalone');

/** The server's entry, with its static files and public folder beside it. Throws, saying what to run, if there is no build. */
export function prepareStandalone() {
  const entry = resolve(standalone, 'server.js');
  if (!existsSync(entry)) throw new Error(`${entry} is not there: run pnpm build first`);
  // Several servers start at once when the browser tests are sharded: the one that started them has already put the files there (`scripts/e2e-shard.mjs`),
  // and copying them again, all at once, over each other, is how a file is read half written.
  if (process.env.WAYMARK_STANDALONE_READY === '1') return entry;
  cpSync(resolve(root, '.next/static'), resolve(standalone, '.next/static'), { recursive: true });
  if (existsSync(resolve(root, 'public'))) {
    cpSync(resolve(root, 'public'), resolve(standalone, 'public'), { recursive: true });
  }
  return entry;
}

/**
 * The migrations are not beside the standalone server in a checkout, as they are in the image (task 1.10), so they are named, as an operator
 * may name them.
 */
export const migrationsDir = process.env.WAYMARK_MIGRATIONS_DIR || resolve(root, 'migrations');
