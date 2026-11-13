import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

/**
 * MapLibre's web worker, served from this origin (DESIGN.md §8.1, §25) so that the page's policy needs only `worker-src 'self'`. **Only the two files the worker is made of** (it imports the second by name, beside it).
 * They are read from the installed `maplibre-gl`: in a checkout that is `node_modules/maplibre-gl/dist`; in a standalone build, which keeps what the route traced under pnpm's own layout and leaves out the link, it is
 * `node_modules/.pnpm/maplibre-gl@<version>/node_modules/maplibre-gl/dist`.
 */
export const WORKER_FILES: ReadonlySet<string> = new Set([
  'maplibre-gl-worker.mjs',
  'maplibre-gl-shared.mjs',
]);

/** The folder MapLibre's files are in, or `undefined`. `root` is the working directory the server was started in. */
export async function distDir(root: string = process.cwd()): Promise<string | undefined> {
  const direct = path.join(root, 'node_modules', 'maplibre-gl', 'dist');
  try {
    await readFile(path.join(direct, 'maplibre-gl-worker.mjs'));
    return direct;
  } catch {
    // Not linked here: look in pnpm's store layout.
  }
  try {
    const store = path.join(root, 'node_modules', '.pnpm');
    const found = (await readdir(store)).filter((name) => name.startsWith('maplibre-gl@')).sort();
    const last = found.at(-1);
    return last ? path.join(store, last, 'node_modules', 'maplibre-gl', 'dist') : undefined;
  } catch {
    return undefined;
  }
}

/** One of the worker's files, or `undefined` for any other name or a file that is not there. */
export async function workerFile(name: string, root?: string): Promise<Buffer | undefined> {
  if (!WORKER_FILES.has(name)) return undefined;
  const dir = await distDir(root);
  if (!dir) return undefined;
  try {
    return await readFile(path.join(dir, name));
  } catch {
    return undefined;
  }
}
