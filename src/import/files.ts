import { type FileHandle, mkdir, open, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { CryptoError, openBytes, sealBytes } from '../crypto/envelope';
import type { KeyRing } from '../crypto/keys';
import { isFileId } from '../media/files';

/**
 * An uploaded import on disk (DESIGN.md §16, §18.3): under `<data>/imports`, **one file per import, named by its id, sealed in chunks**. The media store seals a file whole, which is right for a photo and wrong
 * for an export of up to 200 MB that must not be held in memory by the request that receives it nor by the job that reads it. So the upload is cut into chunks of 1 MiB as it arrives, **each sealed on its own**
 * under the instance key and written as `[length][envelope]`, and read back chunk by chunk.
 *
 * Each chunk is bound to the file's id, to its place in the file and to whether it is the last: **a chunk moved, repeated, dropped or cut off after the last does not open**, so a file that was tampered with
 * on disk is refused and not read short. Nothing in a name, an extension or a header says what is inside. This is the only module that touches the directory.
 */
export const CHUNK_BYTES = 1024 * 1024;
/** The most an import may be (DESIGN.md §16). */
export const IMPORT_MAX_BYTES = 200 * 1024 * 1024;
const PURPOSE = 'import-chunk';

export const importDirOf = (dataDir: string): string => path.join(dataDir, 'imports');

const fileOf = (dir: string, id: string): string => {
  if (!isFileId(id)) throw new Error('not an import id');
  return path.join(dir, id);
};

const bindingOf = (id: string, index: number, last: boolean) => ({
  id: `${id}:${index}:${last ? 'last' : 'more'}`,
  purpose: PURPOSE,
});

/** A plain copy of an import on disk, for a reader that must seek. */
export interface PlainFile {
  readonly path: string;
  remove(): Promise<void>;
}

export type Written = { ok: true; bytes: number } | { ok: false; reason: 'too_big' | 'empty' };

/**
 * Seals what arrives, as it arrives, into a file of its own. The size is counted as it comes and the write stops (and nothing is kept) the moment it passes `maxBytes`, whatever the request said it would be. The
 * file is written under a name of its own and moved when whole, so a crash leaves no half-written import under an id.
 */
export async function writeImport(
  dir: string,
  id: string,
  source: AsyncIterable<Uint8Array>,
  ring: KeyRing,
  maxBytes = IMPORT_MAX_BYTES,
): Promise<Written> {
  const target = fileOf(dir, id);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const temporary = path.join(dir, `.${id}.${process.pid}.${Date.now()}.tmp`);
  const handle = await open(temporary, 'w', 0o600);
  let total = 0;
  let index = 0;
  let pending: Buffer[] = [];
  let pendingBytes = 0;
  const frame = async (chunk: Buffer, last: boolean) => {
    const envelope = sealBytes(chunk, bindingOf(id, index, last), ring.current);
    const header = Buffer.alloc(4);
    header.writeUInt32BE(envelope.length);
    await handle.write(Buffer.concat([header, envelope]));
    index += 1;
  };
  try {
    for await (const part of source) {
      total += part.length;
      if (total > maxBytes) {
        await handle.close();
        await rm(temporary, { force: true });
        return { ok: false, reason: 'too_big' };
      }
      pending.push(Buffer.from(part.buffer, part.byteOffset, part.length));
      pendingBytes += part.length;
      while (pendingBytes > CHUNK_BYTES) {
        // More than a chunk is waiting, so this one is not the last whatever comes.
        const all = Buffer.concat(pending);
        await frame(all.subarray(0, CHUNK_BYTES), false);
        pending = [all.subarray(CHUNK_BYTES)];
        pendingBytes = all.length - CHUNK_BYTES;
      }
    }
    if (total === 0) {
      await handle.close();
      await rm(temporary, { force: true });
      return { ok: false, reason: 'empty' };
    }
    // The last chunk, always written, so that a file always ends in one that says so.
    await frame(Buffer.concat(pending), true);
    await handle.close();
    await rename(temporary, target);
    return { ok: true, bytes: total };
  } catch (error) {
    await handle.close().catch(() => undefined);
    await rm(temporary, { force: true });
    throw error;
  }
}

async function readExactly(handle: FileHandle, length: number, position: number): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  let done = 0;
  while (done < length) {
    const { bytesRead } = await handle.read(buffer, done, length - done, position + done);
    if (bytesRead === 0) throw new CryptoError('malformed');
    done += bytesRead;
  }
  return buffer;
}

/**
 * The import's bytes, a chunk at a time, in order. **Throws a `CryptoError` for a file that has been changed** (a chunk that does not open for its place, a length that runs past the end, bytes after the last
 * chunk), and `undefined` is returned by `hasImport` first for a file that is not there. The caller never sees a short file as a whole one.
 */
export async function* readImport(
  dir: string,
  id: string,
  ring: KeyRing,
): AsyncGenerator<Buffer, void, void> {
  const file = fileOf(dir, id);
  const size = (await stat(file)).size;
  const handle = await open(file, 'r');
  try {
    let position = 0;
    let index = 0;
    while (position < size) {
      const length = (await readExactly(handle, 4, position)).readUInt32BE();
      if (length < 1 || position + 4 + length > size) throw new CryptoError('malformed');
      const envelope = await readExactly(handle, length, position + 4);
      position += 4 + length;
      yield openBytes(envelope, bindingOf(id, index, position === size), ring);
      index += 1;
    }
    if (index === 0) throw new CryptoError('malformed');
  } finally {
    await handle.close();
  }
}

export async function hasImport(dir: string, id: string): Promise<boolean> {
  try {
    return (await stat(fileOf(dir, id))).isFile();
  } catch {
    return false;
  }
}

/**
 * Opens the import into a plain file of its own for a reader that needs to seek (a ZIP's index is at its end), in `into` (a directory the caller owns), mode 0600, chunk by chunk so that it is never whole in
 * memory. Returns its path and how to remove it; **the caller removes it when it is done**, and the job does so at the end of every step that opened one.
 */
export async function materializeImport(
  dir: string,
  id: string,
  ring: KeyRing,
  into: string,
): Promise<PlainFile> {
  await mkdir(into, { recursive: true, mode: 0o700 });
  const target = path.join(into, `${id}.${process.pid}.${Date.now()}.plain`);
  const handle = await open(target, 'w', 0o600);
  try {
    for await (const chunk of readImport(dir, id, ring)) await handle.write(chunk);
  } catch (error) {
    await handle.close().catch(() => undefined);
    await rm(target, { force: true });
    throw error;
  }
  await handle.close();
  return { path: target, remove: () => rm(target, { force: true }) };
}

/** Deletes an import's file. Safe to run twice. */
export async function removeImport(dir: string, id: string): Promise<void> {
  await rm(fileOf(dir, id), { force: true });
}

/** The ids of the files in the directory, for the sweep that finds files no row names. Temporary files of an upload in flight are not ids and are not listed. */
export async function listImports(dir: string): Promise<string[]> {
  const { readdir } = await import('node:fs/promises');
  try {
    return (await readdir(dir)).filter((name) => isFileId(name));
  } catch {
    return [];
  }
}
