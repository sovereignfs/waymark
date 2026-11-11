import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { unzipSync, zipSync } from 'fflate';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MAX_ENTRIES, ZipError, ZipWriter, openZip } from './zip';

/**
 * The ZIP writer and reader (DESIGN.md §22): what one writes the other reads and a reader that is not ours reads too, ZIP64 included, and a reader refuses what is made to hurt it. `fflate` is the independent
 * reader and writer here.
 */
let dir: string;
beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'waymark-zip-'));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const WHEN = new Date(Date.UTC(2026, 10, 12, 8, 30, 10));
function build(files: [string, Uint8Array, boolean?][]): Buffer {
  const zip = new ZipWriter(WHEN);
  const parts: Buffer[] = [];
  for (const [name, data, deflate] of files)
    parts.push(...zip.add(name, data, { deflate: deflate ?? false }));
  parts.push(...zip.finish());
  return Buffer.concat(parts);
}
let n = 0;
const save = (bytes: Uint8Array): string => {
  const file = path.join(dir, `z${++n}.zip`);
  writeFileSync(file, bytes);
  return file;
};

describe('what the writer writes', () => {
  const files: [string, Uint8Array, boolean?][] = [
    ['waymark.json', Buffer.from(JSON.stringify({ a: 'é'.repeat(5000) })), true],
    ['photos/one.webp', Buffer.from([1, 2, 3, 4, 5]), false],
    ['photos/two.webp', Buffer.alloc(300_000, 7), false],
    ['empty.txt', new Uint8Array(0), false],
    ['ünï/cødé ☃.txt', Buffer.from('names are UTF-8'), true],
  ];

  it('is read back by its reader, byte for byte, checked', async () => {
    const zip = await openZip(save(build(files)));
    expect(zip.entries.map((e) => e.name)).toEqual(files.map(([name]) => name));
    for (const [name, data] of files)
      expect(Buffer.from(await zip.read(name, 1_000_000)).equals(Buffer.from(data)), name).toBe(
        true,
      );
    await zip.close();
  });

  it('is read back by a reader that is not ours', () => {
    const out = unzipSync(new Uint8Array(build(files)));
    for (const [name, data] of files)
      expect(Buffer.from(out[name] as Uint8Array).equals(Buffer.from(data)), name).toBe(true);
  });

  it('is a ZIP that the system’s tool finds sound', () => {
    const file = save(build(files));
    const checked = spawnSync('unzip', ['-t', file], { encoding: 'utf8' });
    if (checked.error) return; // no unzip on this machine
    expect(checked.status, checked.stdout).toBe(0);
    expect(checked.stdout).toContain('No errors detected');
  });

  it('reads what another writer wrote', async () => {
    const other = zipSync(
      { 'a.txt': new Uint8Array([97, 98]), 'dir/b.txt': Buffer.from('hello') },
      { level: 6 },
    );
    const zip = await openZip(save(other));
    expect(Buffer.from(await zip.read('a.txt', 10)).toString()).toBe('ab');
    expect(Buffer.from(await zip.read('dir/b.txt', 10)).toString()).toBe('hello');
    await zip.close();
  });
});

describe('an archive of more than 65,535 files', () => {
  it('is written with the ZIP64 end record and read back whole, every entry and the last as it was', async () => {
    const count = 70_000;
    const zip = new ZipWriter(WHEN);
    const parts: Buffer[] = [];
    for (let i = 0; i < count; i += 1)
      for (const part of zip.add(`photos/${i}.bin`, Buffer.from([i & 255]))) parts.push(part);
    // Not spread: 210,000 arguments is more than a call may take.
    for (const part of zip.finish()) parts.push(part);
    const file = save(Buffer.concat(parts));
    const read = await openZip(file);
    expect(read.entries).toHaveLength(count);
    expect((await read.read('photos/69999.bin', 4))[0]).toBe(69_999 & 255);
    expect((await read.read('photos/65535.bin', 4))[0]).toBe(65_535 & 255);
    await read.close();
    const listed = spawnSync('zipinfo', ['-h', file], { encoding: 'utf8' });
    if (!listed.error) expect(listed.stdout).toContain(`number of entries: ${count}`);
  }, 60_000);
});

describe('what the reader refuses', () => {
  const sound = () => build([['a.txt', Buffer.from('hello world'), true]]);

  it('is not a ZIP: nothing, text, a ZIP cut short, a directory that points past the file', async () => {
    for (const bytes of [
      Buffer.alloc(0),
      Buffer.from('this is not a zip file at all, just text'),
      sound().subarray(0, sound().length - 8),
      Buffer.concat([sound().subarray(0, 40), Buffer.alloc(30)]),
    ])
      await expect(openZip(save(bytes))).rejects.toBeInstanceOf(ZipError);
  });

  it('has a changed byte in an entry: the checksum says so', async () => {
    const bytes = Buffer.from(build([['a.txt', Buffer.from('hello world, a longer text'), false]]));
    bytes[bytes.indexOf('hello')] = 0x48; // an H for the h
    const zip = await openZip(save(bytes));
    await expect(zip.read('a.txt', 100)).rejects.toBeInstanceOf(ZipError);
    await zip.close();
  });

  it('is a bomb: a small entry that says it is small and expands to a great deal', async () => {
    const huge = Buffer.alloc(50 * 1024 * 1024, 0);
    const packed = deflateRawSync(huge);
    expect(packed.length).toBeLessThan(100_000);
    // An honest writer would say 50 MB; a hostile one says 10 bytes and sends the same data.
    const zip = new ZipWriter(WHEN);
    const parts = zip.add('bomb.bin', Buffer.from('0123456789'), { deflate: true });
    const bytes = Buffer.concat([...parts, ...zip.finish()]);
    const body = parts[2] as Buffer;
    const at = bytes.indexOf(body);
    const hostile = Buffer.concat([
      bytes.subarray(0, at),
      packed,
      bytes.subarray(at + body.length),
    ]);
    // The directory still says: stored length of the small body. Make the stored length and offsets agree with the new body.
    const central = hostile.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    hostile.writeUInt32LE(packed.length, 20 + central);
    hostile.writeUInt32LE(
      packed.length,
      18 + hostile.indexOf(Buffer.from([0x50, 0x4b, 0x03, 0x04])),
    );
    const shift = packed.length - body.length;
    const end = hostile.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    hostile.writeUInt32LE(hostile.readUInt32LE(end + 16) + shift, end + 16);
    const opened = await openZip(save(hostile));
    await expect(opened.read('bomb.bin', 1024)).rejects.toBeInstanceOf(ZipError);
    await opened.close();
  });

  it('claims more than the caller allows: refused before it is expanded', async () => {
    const zip = await openZip(save(build([['big.bin', Buffer.alloc(5000, 1), true]])));
    await expect(zip.read('big.bin', 4999)).rejects.toBeInstanceOf(ZipError);
    expect((await zip.read('big.bin', 5000)).length).toBe(5000);
    await expect(zip.read('missing', 10)).rejects.toBeInstanceOf(ZipError);
    await zip.close();
  });

  it('is encrypted, or uses a compression this does not read, or repeats a name', async () => {
    const mark = (change: (bytes: Buffer, central: number) => void) => {
      const bytes = Buffer.from(sound());
      change(bytes, bytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])));
      return save(bytes);
    };
    await expect(
      openZip(mark((b, c) => b.writeUInt16LE(b.readUInt16LE(c + 8) | 1, c + 8))),
    ).rejects.toThrow('encrypted');
    await expect(openZip(mark((b, c) => b.writeUInt16LE(12, c + 10)))).rejects.toThrow(
      'compression',
    );
    await expect(
      openZip(
        save(
          build([
            ['a.txt', Buffer.from('1')],
            ['a.txt', Buffer.from('2')],
          ]),
        ),
      ),
    ).rejects.toThrow('repeated');
  });

  it('claims more entries than will be read', () => {
    expect(MAX_ENTRIES).toBeGreaterThanOrEqual(500_000);
  });
});
