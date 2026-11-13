import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WORKER_FILES, distDir, workerFile } from './worker';

/** MapLibre's worker is served from here, and only the two files it is made of, found in a checkout and in a standalone build. */
const made: string[] = [];
function root(layout: 'linked' | 'store' | 'none'): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'waymark-worker-'));
  made.push(dir);
  const dist =
    layout === 'linked'
      ? path.join(dir, 'node_modules', 'maplibre-gl', 'dist')
      : path.join(
          dir,
          'node_modules',
          '.pnpm',
          'maplibre-gl@6.18.0',
          'node_modules',
          'maplibre-gl',
          'dist',
        );
  if (layout !== 'none') {
    mkdirSync(dist, { recursive: true });
    for (const name of [...WORKER_FILES, 'maplibre-gl.mjs', 'secret.txt'])
      writeFileSync(path.join(dist, name), `// ${name}`);
  }
  return dir;
}
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('the map’s worker', () => {
  it('is found where a checkout has it and where a standalone build has it', async () => {
    for (const layout of ['linked', 'store'] as const) {
      const dir = root(layout);
      expect(await distDir(dir), layout).toContain('maplibre-gl');
      expect((await workerFile('maplibre-gl-worker.mjs', dir))?.toString(), layout).toBe(
        '// maplibre-gl-worker.mjs',
      );
      expect((await workerFile('maplibre-gl-shared.mjs', dir))?.toString(), layout).toBe(
        '// maplibre-gl-shared.mjs',
      );
    }
  });

  it('is only the two files it is made of: not the library, not anything else in the folder, not a path', async () => {
    const dir = root('linked');
    for (const name of [
      'maplibre-gl.mjs',
      'secret.txt',
      '../package.json',
      '..%2Fx',
      'maplibre-gl-worker.mjs/../secret.txt',
      '',
    ])
      expect(await workerFile(name, dir), name).toBeUndefined();
  });

  it('is nothing when MapLibre is not installed', async () => {
    expect(await workerFile('maplibre-gl-worker.mjs', root('none'))).toBeUndefined();
  });
});
