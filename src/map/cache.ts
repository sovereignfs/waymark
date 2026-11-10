import { randomBytes } from 'node:crypto';
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  unlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';

/**
 * The map's cache on disk (DESIGN.md §8.1): `<data>/map/cache`, tiles and glyphs the server fetched, **public map data and nothing about who asked for it**, so it is not sealed. A file is
 * named by what it is (`tiles/<version>/<z>/<x>/<y>`), never by anything a person typed, and every key is checked to stay inside the directory.
 *
 * It is bounded: `prune` removes the files **read longest ago** until the cache is under 90 % of its limit. A read marks the file as read now (its modification time is moved, since a
 * file system's access time cannot be relied on), so what the map keeps using stays and what no one looks at goes. A file is written to a name of its own and renamed into place, so a reader
 * never sees half a tile, and two processes writing the same tile write the same bytes.
 */
export class DiskCache {
  readonly dir: string;
  constructor(dir: string) {
    this.dir = path.resolve(dir);
  }

  /** The path of a key, or undefined for one that would leave the cache: each segment is letters, digits and `._-` alone, and not a dot. */
  pathOf(key: string): string | undefined {
    const segments = key.split('/');
    if (
      segments.some(
        (segment) => !/^[A-Za-z0-9_][A-Za-z0-9._ -]*$/.test(segment) || segment.includes('..'),
      )
    )
      return undefined;
    const full = path.resolve(this.dir, ...segments);
    return full.startsWith(this.dir + path.sep) ? full : undefined;
  }

  /** What is kept under `key`, marked as read now; undefined if there is nothing. */
  async get(key: string): Promise<Buffer | undefined> {
    const file = this.pathOf(key);
    if (!file) return undefined;
    try {
      const data = await readFile(file);
      const now = new Date();
      utimes(file, now, now).catch(() => undefined);
      return data;
    } catch {
      return undefined;
    }
  }

  /** Keeps `data` under `key`. A key that is not one, or a disk that would not take it, keeps nothing and says so. */
  async put(key: string, data: Uint8Array): Promise<boolean> {
    const file = this.pathOf(key);
    if (!file) return false;
    const temporary = `${file}.${randomBytes(6).toString('hex')}.tmp`;
    try {
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(temporary, data);
      await rename(temporary, file);
      return true;
    } catch {
      await unlink(temporary).catch(() => undefined);
      return false;
    }
  }

  /** How many bytes the cache holds, and in how many files, counting only what `prune` may remove. */
  async size(): Promise<{ bytes: number; files: number }> {
    const found = await this.files();
    return { bytes: found.reduce((sum, file) => sum + file.size, 0), files: found.length };
  }

  private async files(): Promise<{ path: string; size: number; read: number }[]> {
    const out: { path: string; size: number; read: number }[] = [];
    const walk = async (dir: string): Promise<void> => {
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) await walk(full);
        else if (entry.isFile()) {
          try {
            const info = await stat(full);
            out.push({ path: full, size: info.size, read: info.mtimeMs });
          } catch {
            // gone in the meantime: nothing to count
          }
        }
      }
    };
    for (const part of ['tiles', 'glyphs'])
      await walk(path.join(/* turbopackIgnore: true */ this.dir, part));
    return out;
  }

  /**
   * Brings the cache under `maxBytes` (to 90 % of it, so that the next tile does not call for another pass), removing the files read longest ago first, and any half-written
   * file left by a process that stopped. Returns what it removed. Safe to run at once from two processes: a file that is gone is not an error.
   */
  async prune(maxBytes: number, now = Date.now()): Promise<{ files: number; bytes: number }> {
    let removed = { files: 0, bytes: 0 };
    const found = await this.files();
    for (const file of found.filter(
      (f) => f.path.endsWith('.tmp') && now - f.read > 60 * 60 * 1000,
    )) {
      if (
        await rm(file.path, { force: true }).then(
          () => true,
          () => false,
        )
      )
        removed = { files: removed.files + 1, bytes: removed.bytes + file.size };
    }
    const live = found.filter((f) => !f.path.endsWith('.tmp'));
    let total = live.reduce((sum, file) => sum + file.size, 0);
    if (total <= maxBytes) return removed;
    const target = Math.floor(maxBytes * 0.9);
    for (const file of live.sort((a, b) => a.read - b.read)) {
      if (total <= target) break;
      if (
        await rm(file.path, { force: true }).then(
          () => true,
          () => false,
        )
      ) {
        total -= file.size;
        removed = { files: removed.files + 1, bytes: removed.bytes + file.size };
      }
    }
    // Directories that were emptied are left: they are cheap, and the next tile makes them again.
    return removed;
  }
}
