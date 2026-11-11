import { type FileHandle, open } from 'node:fs/promises';
import { crc32, deflateRawSync, inflateRawSync } from 'node:zlib';

/**
 * **A ZIP writer and reader** (DESIGN.md §22; also what the Swarm reader, 8.2, opens its export with), small and with the limits said. They are Waymark's own because the streaming writer in the library the
 * project tried first (`fflate`) writes the number of entries in 16 bits and no ZIP64 end record, so an archive of more than 65,535 files, which a decade of photos can be, reads back with the rest silently missing
 * (found by writing 70,000 entries and asking `zipinfo`). `fflate` stays as a development dependency, to read what these write with a reader that is not ours.
 *
 * **Writing** (`ZipWriter`): each file is written whole, so its size and checksum are known and no data descriptor is needed; a file is stored as it is (photos are already compressed) or deflated (the JSON). A
 * file's offset, or the directory's, past 4 GB, and more than 65,535 entries, are written the ZIP64 way. **Reading** (`openZip`): from a file on disk, by its directory, never the whole archive in memory; it
 * reads ZIP64, refuses what is encrypted or uses a method other than stored and deflate, **bounds what an entry may expand to** (a ZIP made to fill memory), checks every size and checksum, and refuses a name
 * that is repeated. A name's meaning (a folder, a `..`) is the caller's to check.
 */
const LOCAL = 0x04034b50;
const CENTRAL = 0x02014b50;
const EOCD = 0x06054b50;
const EOCD64 = 0x06064b50;
const LOCATOR64 = 0x07064b50;
const U16 = 0xffff;
const U32 = 0xffffffff;

export const MAX_ENTRIES = 1_000_000;
/** The most a directory may be: a million entries of ordinary names. */
export const MAX_DIRECTORY_BYTES = 256 * 1024 * 1024;

interface Written {
  readonly name: string;
  readonly crc: number;
  readonly size: number;
  readonly stored: number;
  readonly method: 0 | 8;
  readonly offset: number;
}

/** DOS date and time for a moment (two-second steps, 1980 on), which is what a ZIP records. */
function dos(date: Date): { time: number; day: number } {
  const year = Math.max(1980, date.getUTCFullYear());
  return {
    time: (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | (date.getUTCSeconds() >> 1),
    day: ((year - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate(),
  };
}

export class ZipWriter {
  private readonly entries: Written[] = [];
  private offset = 0;
  private readonly stamp: { time: number; day: number };

  constructor(when: Date) {
    this.stamp = dos(when);
  }

  /** The bytes of one file: its local header and its data. Names are UTF-8. */
  add(name: string, data: Uint8Array, options: { deflate?: boolean } = {}): Buffer[] {
    const raw = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    const method = options.deflate ? 8 : 0;
    const body = method === 8 ? deflateRawSync(raw, { level: 6 }) : raw;
    const nameBytes = Buffer.from(name, 'utf8');
    const header = Buffer.alloc(30);
    header.writeUInt32LE(LOCAL, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x0800, 6);
    header.writeUInt16LE(method, 8);
    header.writeUInt16LE(this.stamp.time, 10);
    header.writeUInt16LE(this.stamp.day, 12);
    const checksum = crc32(raw);
    header.writeUInt32LE(checksum, 14);
    header.writeUInt32LE(body.length, 18);
    header.writeUInt32LE(raw.length, 22);
    header.writeUInt16LE(nameBytes.length, 26);
    header.writeUInt16LE(0, 28);
    this.entries.push({
      name,
      crc: checksum,
      size: raw.length,
      stored: body.length,
      method,
      offset: this.offset,
    });
    this.offset += header.length + nameBytes.length + body.length;
    return [header, nameBytes, body];
  }

  /** The directory and the end of the archive. Call once, last. */
  finish(): Buffer[] {
    const out: Buffer[] = [];
    const directoryStart = this.offset;
    let directorySize = 0;
    for (const entry of this.entries) {
      const nameBytes = Buffer.from(entry.name, 'utf8');
      const big = entry.offset >= U32;
      const extra = big ? Buffer.alloc(12) : Buffer.alloc(0);
      if (big) {
        extra.writeUInt16LE(0x0001, 0);
        extra.writeUInt16LE(8, 2);
        extra.writeBigUInt64LE(BigInt(entry.offset), 4);
      }
      const header = Buffer.alloc(46);
      header.writeUInt32LE(CENTRAL, 0);
      header.writeUInt16LE(big ? 45 : 20, 4);
      header.writeUInt16LE(big ? 45 : 20, 6);
      header.writeUInt16LE(0x0800, 8);
      header.writeUInt16LE(entry.method, 10);
      header.writeUInt16LE(this.stamp.time, 12);
      header.writeUInt16LE(this.stamp.day, 14);
      header.writeUInt32LE(entry.crc, 16);
      header.writeUInt32LE(entry.stored, 20);
      header.writeUInt32LE(entry.size, 24);
      header.writeUInt16LE(nameBytes.length, 28);
      header.writeUInt16LE(extra.length, 30);
      header.writeUInt16LE(0, 32);
      header.writeUInt16LE(0, 34);
      header.writeUInt16LE(0, 36);
      header.writeUInt32LE(0, 38);
      header.writeUInt32LE(big ? U32 : entry.offset, 42);
      out.push(header, nameBytes, extra);
      directorySize += header.length + nameBytes.length + extra.length;
    }
    const count = this.entries.length;
    const needs64 = count >= U16 || directoryStart >= U32 || directorySize >= U32;
    if (needs64) {
      const record = Buffer.alloc(56);
      record.writeUInt32LE(EOCD64, 0);
      record.writeBigUInt64LE(44n, 4);
      record.writeUInt16LE(45, 12);
      record.writeUInt16LE(45, 14);
      record.writeUInt32LE(0, 16);
      record.writeUInt32LE(0, 20);
      record.writeBigUInt64LE(BigInt(count), 24);
      record.writeBigUInt64LE(BigInt(count), 32);
      record.writeBigUInt64LE(BigInt(directorySize), 40);
      record.writeBigUInt64LE(BigInt(directoryStart), 48);
      const locator = Buffer.alloc(20);
      locator.writeUInt32LE(LOCATOR64, 0);
      locator.writeUInt32LE(0, 4);
      locator.writeBigUInt64LE(BigInt(directoryStart + directorySize), 8);
      locator.writeUInt32LE(1, 16);
      out.push(record, locator);
    }
    const end = Buffer.alloc(22);
    end.writeUInt32LE(EOCD, 0);
    end.writeUInt16LE(0, 4);
    end.writeUInt16LE(0, 6);
    end.writeUInt16LE(needs64 ? U16 : count, 8);
    end.writeUInt16LE(needs64 ? U16 : count, 10);
    end.writeUInt32LE(needs64 ? U32 : directorySize, 12);
    end.writeUInt32LE(needs64 ? U32 : directoryStart, 16);
    end.writeUInt16LE(0, 20);
    out.push(end);
    return out;
  }
}

export class ZipError extends Error {
  override name = 'ZipError';
}

export interface ZipEntry {
  readonly name: string;
  readonly size: number;
  readonly stored: number;
  readonly method: number;
  readonly crc: number;
  readonly offset: number;
}

export interface Zip {
  /** Every entry, in the order of the directory. */
  readonly entries: readonly ZipEntry[];
  /** One entry's bytes, expanded and checked; never more than `maxBytes` (a larger entry throws without being expanded). */
  read(name: string, maxBytes: number): Promise<Buffer>;
  close(): Promise<void>;
}

async function readAt(handle: FileHandle, position: number, length: number): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  let done = 0;
  while (done < length) {
    const { bytesRead } = await handle.read(buffer, done, length - done, position + done);
    if (bytesRead === 0) throw new ZipError('the archive ends too soon');
    done += bytesRead;
  }
  return buffer;
}

const safeNumber = (value: bigint): number => {
  if (value > BigInt(Number.MAX_SAFE_INTEGER))
    throw new ZipError('a size in the archive is too large');
  return Number(value);
};

/** Opens a ZIP on disk by its directory. Throws a `ZipError` for anything that is not a ZIP this reads. */
export async function openZip(path: string): Promise<Zip> {
  const handle = await open(path, 'r');
  try {
    const size = (await handle.stat()).size;
    if (size < 22) throw new ZipError('not a ZIP');
    // The end record is in the last 64 KB (its comment is at most that).
    const tailLength = Math.min(size, 22 + U16);
    const tail = await readAt(handle, size - tailLength, tailLength);
    let eocd = -1;
    for (let at = tail.length - 22; at >= 0; at -= 1)
      if (tail.readUInt32LE(at) === EOCD) {
        eocd = at;
        break;
      }
    if (eocd < 0) throw new ZipError('not a ZIP');
    let count = tail.readUInt16LE(eocd + 10);
    let directorySize = tail.readUInt32LE(eocd + 12);
    let directoryStart = tail.readUInt32LE(eocd + 16);
    if (count === U16 || directorySize === U32 || directoryStart === U32) {
      const at = size - tailLength + eocd - 20;
      if (at < 0) throw new ZipError('not a ZIP');
      const locator = await readAt(handle, at, 20);
      if (locator.readUInt32LE(0) !== LOCATOR64) throw new ZipError('not a ZIP');
      const where = safeNumber(locator.readBigUInt64LE(8));
      const record = await readAt(handle, where, 56);
      if (record.readUInt32LE(0) !== EOCD64) throw new ZipError('not a ZIP');
      count = safeNumber(record.readBigUInt64LE(32));
      directorySize = safeNumber(record.readBigUInt64LE(40));
      directoryStart = safeNumber(record.readBigUInt64LE(48));
    }
    if (count > MAX_ENTRIES) throw new ZipError('too many entries');
    if (directorySize > MAX_DIRECTORY_BYTES || directoryStart + directorySize > size)
      throw new ZipError('the directory is not valid');
    const directory = await readAt(handle, directoryStart, directorySize);

    const entries: ZipEntry[] = [];
    const names = new Set<string>();
    let at = 0;
    for (let i = 0; i < count; i += 1) {
      if (at + 46 > directory.length || directory.readUInt32LE(at) !== CENTRAL)
        throw new ZipError('the directory is not valid');
      const flags = directory.readUInt16LE(at + 8);
      const method = directory.readUInt16LE(at + 10);
      const crc = directory.readUInt32LE(at + 16);
      let stored = directory.readUInt32LE(at + 20);
      let expanded = directory.readUInt32LE(at + 24);
      const nameLength = directory.readUInt16LE(at + 28);
      const extraLength = directory.readUInt16LE(at + 30);
      const commentLength = directory.readUInt16LE(at + 32);
      let offset = directory.readUInt32LE(at + 42);
      const next = at + 46 + nameLength + extraLength + commentLength;
      if (next > directory.length) throw new ZipError('the directory is not valid');
      if (flags & 1) throw new ZipError('an encrypted archive');
      if (method !== 0 && method !== 8) throw new ZipError('a compression this does not read');
      const name = directory.subarray(at + 46, at + 46 + nameLength).toString('utf8');
      if (names.has(name)) throw new ZipError('a name repeated');
      names.add(name);
      // The ZIP64 extra holds, in order, whichever of the sizes and the offset were too large for their fields.
      if (expanded === U32 || stored === U32 || offset === U32) {
        let extra = at + 46 + nameLength;
        const end = extra + extraLength;
        let found = false;
        while (extra + 4 <= end) {
          const tag = directory.readUInt16LE(extra);
          const length = directory.readUInt16LE(extra + 2);
          if (tag === 0x0001) {
            let p = extra + 4;
            if (expanded === U32) {
              expanded = safeNumber(directory.readBigUInt64LE(p));
              p += 8;
            }
            if (stored === U32) {
              stored = safeNumber(directory.readBigUInt64LE(p));
              p += 8;
            }
            if (offset === U32) offset = safeNumber(directory.readBigUInt64LE(p));
            found = true;
            break;
          }
          extra += 4 + length;
        }
        if (!found) throw new ZipError('the directory is not valid');
      }
      entries.push({ name, size: expanded, stored, method, crc, offset });
      at = next;
    }
    const byName = new Map(entries.map((entry) => [entry.name, entry]));

    return {
      entries,
      async read(name, maxBytes) {
        const entry = byName.get(name);
        if (!entry) throw new ZipError('no such entry');
        // The size the archive says, checked before anything is expanded, and again on what comes out.
        if (entry.size > maxBytes || entry.stored > maxBytes + 1024)
          throw new ZipError('an entry is larger than allowed');
        const local = await readAt(handle, entry.offset, 30);
        if (local.readUInt32LE(0) !== LOCAL) throw new ZipError('the archive is not valid');
        const dataAt = entry.offset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
        if (dataAt + entry.stored > size) throw new ZipError('the archive ends too soon');
        const body = await readAt(handle, dataAt, entry.stored);
        let bytes: Buffer;
        if (entry.method === 0) bytes = body;
        else {
          try {
            bytes = inflateRawSync(body, { maxOutputLength: Math.max(entry.size, 1) });
          } catch {
            throw new ZipError('an entry is not valid');
          }
        }
        if (bytes.length !== entry.size || crc32(bytes) !== entry.crc)
          throw new ZipError('an entry is not valid');
        return bytes;
      },
      close: () => handle.close(),
    };
  } catch (error) {
    await handle.close();
    throw error;
  }
}
