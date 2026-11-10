import {
  mkdtempSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  readdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DiskCache } from './cache';

let root: string;
let cache: DiskCache;
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'waymark-map-cache-'));
  cache = new DiskCache(path.join(root, 'cache'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const bytes = (n: number, fill = 1) => Buffer.alloc(n, fill);
const ago = (file: string, ms: number) => {
  const when = new Date(Date.now() - ms);
  utimesSync(file, when, when);
};

describe('the map’s disk cache', () => {
  it('keeps what it is given under a key, and gives it back, or nothing', async () => {
    expect(await cache.get('tiles/abc/1/2/3')).toBeUndefined();
    expect(await cache.put('tiles/abc/1/2/3', bytes(10, 7))).toBe(true);
    expect(await cache.get('tiles/abc/1/2/3')).toEqual(bytes(10, 7));
    expect(await cache.get('glyphs/Noto Sans Regular/0-255.pbf')).toBeUndefined();
    expect(await cache.put('glyphs/Noto Sans Regular/0-255.pbf', bytes(3))).toBe(true);
  });

  it('never leaves its directory, whatever the key says', async () => {
    for (const key of [
      '../escape',
      'tiles/../../escape',
      '/etc/passwd',
      'tiles//x',
      'tiles/./x',
      '',
      'tiles/..%2f',
      '.hidden/x',
      'tiles/a\0b',
      'tiles/a\\b',
    ]) {
      expect(cache.pathOf(key), key).toBeUndefined();
      expect(await cache.put(key, bytes(1)), key).toBe(false);
      expect(await cache.get(key), key).toBeUndefined();
    }
    expect(existsSync(path.join(root, 'escape'))).toBe(false);
    expect(cache.pathOf('tiles/abc/1/2/3')).toBe(
      path.join(root, 'cache', 'tiles', 'abc', '1', '2', '3'),
    );
  });

  it('is written whole: a half-written file is never read, and none is left behind', async () => {
    await cache.put('tiles/v/0/0/0', bytes(100));
    const names = readdirSync(path.join(root, 'cache', 'tiles', 'v', '0', '0'));
    expect(names).toEqual(['0']);
  });

  it('counts what it holds, tiles and glyphs, and not the address it keeps of the upstream', async () => {
    await cache.put('tiles/v/0/0/0', bytes(100));
    await cache.put('glyphs/F/0-255.pbf', bytes(50));
    await cache.put('tilejson/template', bytes(500));
    expect(await cache.size()).toEqual({ bytes: 150, files: 2 });
  });

  it('removes what was read longest ago first, until it is under 90 % of its limit, and keeps what is read', async () => {
    for (let i = 0; i < 10; i++) {
      await cache.put(`tiles/v/0/0/${i}`, bytes(100, i));
      ago(cache.pathOf(`tiles/v/0/0/${i}`) ?? '', (10 - i) * 60_000); // tile 0 is the oldest
    }
    // Tile 0 is the oldest, and is then read: it is the newest now.
    expect(await cache.get('tiles/v/0/0/0')).toBeDefined();
    await new Promise((resolve) => setTimeout(resolve, 30));
    const pruned = await cache.prune(1000 - 1);
    // Over by one byte: down to 899 means 2 files go (1000 → 800), the two read longest ago.
    expect(pruned).toEqual({ files: 2, bytes: 200 });
    expect(await cache.get('tiles/v/0/0/0')).toBeDefined();
    expect(await cache.get('tiles/v/0/0/1')).toBeUndefined();
    expect(await cache.get('tiles/v/0/0/2')).toBeUndefined();
    expect(await cache.get('tiles/v/0/0/3')).toBeDefined();
    expect((await cache.size()).bytes).toBe(800);
  });

  it('does nothing when it is under its limit, and does not mind a file already gone', async () => {
    await cache.put('tiles/v/0/0/0', bytes(100));
    expect(await cache.prune(1000)).toEqual({ files: 0, bytes: 0 });
    expect((await cache.size()).files).toBe(1);
    expect(await new DiskCache(path.join(root, 'nothing-here')).prune(1)).toEqual({
      files: 0,
      bytes: 0,
    });
  });

  it('sweeps up a half-written file that a stopped process left, once it is old', async () => {
    await cache.put('tiles/v/0/0/0', bytes(10));
    const dir = path.join(root, 'cache', 'tiles', 'v', '0', '0');
    mkdirSync(dir, { recursive: true });
    const fresh = path.join(dir, '1.aaaa.tmp');
    const old = path.join(dir, '2.bbbb.tmp');
    writeFileSync(fresh, bytes(5));
    writeFileSync(old, bytes(5));
    ago(old, 2 * 60 * 60 * 1000);
    expect(await cache.prune(10_000)).toEqual({ files: 1, bytes: 5 });
    expect(existsSync(old)).toBe(false);
    expect(statSync(fresh).size).toBe(5);
  });
});
