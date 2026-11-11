import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fingerprintOfEnvelope, openBytes, rewrapBytes, sealBytes } from '../crypto/envelope';
import type { KeyEntry, KeyRing } from '../crypto/keys';

/**
 * Files on disk (DESIGN.md §18.3): under `<data>/media`, **one file per row, named by a random id, holding one envelope**: the file's bytes sealed with a data key of their own, bound
 * to the id, so that a file copied from the disk is unreadable without the instance key and one moved to another id does not open. The directory holds nothing else and says
 * nothing: no extension, no type, no owner in a name. This is the only module that touches the directory.
 */
import { FILE_ID } from '../sync/format';

export const FILE_PURPOSE = 'file';

/** A file's id is a UUID: it becomes a file name, so nothing else is let through (no `/`, no `..`). */
export const isFileId = (id: string): boolean => FILE_ID.test(id);

/** The id of the thumbnail of a photo: derived, so that a device that knows the photo's id knows its thumbnail's, and the same each time. */
export function thumbIdOf(photoId: string): string {
  const hash = createHash('sha256').update(`waymark:thumb:${photoId}`).digest();
  const hex = hash.subarray(0, 16).toString('hex').split('');
  // A UUID's version and variant, so that it is one.
  hex[12] = '8';
  hex[16] = ['8', '9', 'a', 'b'][(hash[8] ?? 0) & 3] ?? '8';
  const h = hex.join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

export const mediaDirOf = (dataDir: string): string => path.join(dataDir, 'media');

const fileOf = (dir: string, id: string): string => {
  if (!isFileId(id)) throw new Error('not a file id');
  return path.join(dir, id);
};

/** Writes a file, sealed, atomically: to a name of its own and then moved, so that a crash leaves no half-written file under an id. */
export async function writeSealed(
  dir: string,
  id: string,
  bytes: Uint8Array,
  ring: KeyRing,
): Promise<void> {
  const target = fileOf(dir, id);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const temporary = path.join(dir, `.${id}.${process.pid}.${Date.now()}.tmp`);
  await writeFile(temporary, sealBytes(bytes, { id, purpose: FILE_PURPOSE }, ring.current), {
    mode: 0o600,
  });
  await rename(temporary, target);
}

/** Reads a file and opens it for its id, or `undefined` when there is none. A file that does not open throws a `CryptoError`. */
export async function readSealed(
  dir: string,
  id: string,
  ring: KeyRing,
): Promise<Buffer | undefined> {
  let envelope: Buffer;
  try {
    envelope = await readFile(fileOf(dir, id));
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') return undefined;
    throw error;
  }
  return openBytes(envelope, { id, purpose: FILE_PURPOSE }, ring);
}

/** Removes a file; one that is not there is as removed as one that was. */
export async function removeFile(dir: string, id: string): Promise<void> {
  await rm(fileOf(dir, id), { force: true });
}

/** The files in the directory with when each was last written, for the sweep. Temporary names of a write in flight are included, with their age. */
export async function listFiles(dir: string): Promise<{ name: string; modifiedAt: number }[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') return [];
    throw error;
  }
  const out: { name: string; modifiedAt: number }[] = [];
  for (const name of names) {
    try {
      out.push({ name, modifiedAt: (await stat(path.join(dir, name))).mtimeMs });
    } catch {
      // Gone since it was listed.
    }
  }
  return out;
}

/** Removes a file by its name in the directory, which the sweep took from the listing (so it may be a temporary one). */
export async function removeByName(dir: string, name: string): Promise<void> {
  if (name.includes('/') || name.includes('..')) throw new Error('not a file name');
  await rm(path.join(dir, name), { force: true });
}

/**
 * Moves a file's data key from one instance key to another (3.3), leaving its content as it is. Returns `moved` when it did, `current` when the file is already under `to`, `unknown` when it is under a key that is
 * neither (it cannot be moved, and is counted), and `gone` when it is not there. The new file is written under a name of its own and moved over the old, **unless the old file was written meanwhile**, in which
 * case it is left as that write made it.
 */
export async function rewrapFile(
  dir: string,
  id: string,
  from: KeyEntry,
  to: KeyEntry,
): Promise<'moved' | 'current' | 'unknown' | 'gone'> {
  const target = fileOf(dir, id);
  let before;
  let envelope: Buffer;
  try {
    before = await stat(target);
    envelope = await readFile(target);
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') return 'gone';
    throw error;
  }
  const fingerprint = fingerprintOfEnvelope(envelope);
  if (fingerprint === to.fingerprint) return 'current';
  if (fingerprint !== from.fingerprint) return 'unknown';
  const moved = rewrapBytes(envelope, { id, purpose: FILE_PURPOSE }, from, to);
  const temporary = path.join(dir, `.${id}.${process.pid}.${Date.now()}.rewrap.tmp`);
  await writeFile(temporary, moved, { mode: 0o600 });
  const after = await stat(target).catch(() => undefined);
  if (!after || after.mtimeMs !== before.mtimeMs) {
    await rm(temporary, { force: true });
    return after ? 'current' : 'gone';
  }
  await rename(temporary, target);
  return 'moved';
}
