import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { inertWorkerSource, workerSource } from '@/src/sw/source';

/**
 * The service worker (`src/sw/source.ts`, DESIGN.md §20.12), served at `/sw.js` from the root so that it controls the whole app. Its version is the build's,
 * so a new build is a new worker and a new cache; it is never cached by the browser, which checks it at each load.
 */
export const dynamic = 'force-dynamic';

/** The build's version, or nothing when this is not a production build. */
function buildId(): string | undefined {
  try {
    return readFileSync(join(process.cwd(), '.next', 'BUILD_ID'), 'utf8').trim();
  } catch {
    return undefined;
  }
}

/** The build's static files as the addresses they are served at: scripts, styles and the typeface, which are the same for everyone. */
function builtFiles(): string[] {
  const root = join(process.cwd(), '.next', 'static');
  const out: string[] = [];
  const walk = (directory: string, prefix: string) => {
    for (const name of readdirSync(directory)) {
      const path = join(directory, name);
      if (statSync(path).isDirectory()) walk(path, `${prefix}${name}/`);
      else if (!name.endsWith('.map')) out.push(`/_next/static/${prefix}${name}`);
    }
  };
  try {
    walk(root, '');
  } catch {
    // Not a production build: nothing to keep.
  }
  return out.sort();
}

export function GET() {
  const version = buildId();
  // A development server has no build to keep: its worker keeps nothing and goes.
  return new Response(version ? workerSource(version, builtFiles()) : inertWorkerSource(), {
    headers: {
      'content-type': 'text/javascript; charset=utf-8',
      'cache-control': 'no-cache, max-age=0',
      'service-worker-allowed': '/',
    },
  });
}
