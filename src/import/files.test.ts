import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CryptoError } from '../crypto/envelope';
import { type KeyRing, ringOf } from '../crypto/keys';
import {
  CHUNK_BYTES,
  hasImport,
  listImports,
  materializeImport,
  readImport,
  removeImport,
  writeImport,
} from './files';

/** An uploaded import on disk (DESIGN.md §16, §18.3): sealed in chunks, written as it arrives, read back in order, and refused if it has been touched. */
const made = [ringOf(randomBytes(32)), ringOf(randomBytes(32))];
if (!made[0] || !made[1]) throw new Error('no ring');
const ring: KeyRing = made[0];
const other: KeyRing = made[1];
let dir: string;
beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'waymark-imports-'));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
async function* parts(bytes: Buffer, size: number) {
  for (let at = 0; at < bytes.length; at += size) yield bytes.subarray(at, at + size);
}
async function whole(id: string, key = ring): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of readImport(dir, id, key)) chunks.push(chunk);
  return Buffer.concat(chunks);
}

describe('an import on disk', () => {
  it('is read back as it was written, whatever size the pieces it arrived in were, and is in no readable form on disk', async () => {
    const bytes = Buffer.concat([
      Buffer.from('PK\x03\x04 zxqv marker '),
      randomBytes(CHUNK_BYTES * 2 + 123),
    ]);
    for (const [n, piece] of [
      [1, 7],
      [2, 65_536],
      [3, CHUNK_BYTES],
      [4, bytes.length],
    ] as const) {
      const written = await writeImport(dir, ID(n), parts(bytes, piece), ring);
      expect(written).toEqual({ ok: true, bytes: bytes.length });
      expect((await whole(ID(n))).equals(bytes)).toBe(true);
    }
    expect(readFileSync(path.join(dir, ID(1))).includes(Buffer.from('zxqv'))).toBe(false);
    expect(statSync(path.join(dir, ID(1))).mode & 0o777).toBe(0o600);
  });

  it('keeps no chunk longer than a chunk in memory: a file of three and a bit chunks is four frames', async () => {
    const bytes = randomBytes(CHUNK_BYTES * 3 + 5);
    await writeImport(dir, ID(5), parts(bytes, 1000), ring);
    const frames: number[] = [];
    for await (const chunk of readImport(dir, ID(5), ring)) frames.push(chunk.length);
    expect(frames).toEqual([CHUNK_BYTES, CHUNK_BYTES, CHUNK_BYTES, 5]);
  });

  it('is refused above the limit as soon as it is passed, with nothing kept, whatever was said it would be', async () => {
    const result = await writeImport(dir, ID(6), parts(randomBytes(5000), 100), ring, 4999);
    expect(result).toEqual({ ok: false, reason: 'too_big' });
    expect(await hasImport(dir, ID(6))).toBe(false);
    expect(readdirSync(dir).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    expect(await writeImport(dir, ID(7), parts(Buffer.alloc(0), 1), ring)).toEqual({
      ok: false,
      reason: 'empty',
    });
    expect(await hasImport(dir, ID(7))).toBe(false);
  });

  it('leaves nothing under an id when the source fails half way', async () => {
    async function* breaks() {
      yield randomBytes(CHUNK_BYTES * 2);
      throw new Error('the connection dropped');
    }
    await expect(writeImport(dir, ID(8), breaks(), ring)).rejects.toThrow('dropped');
    expect(await hasImport(dir, ID(8))).toBe(false);
    expect(readdirSync(dir).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('is refused if it has been touched: a changed byte, a file cut short, a file cut at a chunk, another key, another id', async () => {
    const bytes = randomBytes(CHUNK_BYTES * 2 + 50);
    await writeImport(dir, ID(10), parts(bytes, 9999), ring);
    const original = readFileSync(path.join(dir, ID(10)));
    const frameEnd = 4 + original.readUInt32BE(0);

    // A changed byte.
    const changed = Buffer.from(original);
    changed[200] = (changed[200] ?? 0) ^ 1;
    writeFileSync(path.join(dir, ID(11)), changed);
    await expect(whole(ID(11))).rejects.toBeInstanceOf(CryptoError);
    // Cut short in the middle of a chunk.
    writeFileSync(path.join(dir, ID(12)), original.subarray(0, original.length - 10));
    await expect(whole(ID(12))).rejects.toBeInstanceOf(CryptoError);
    // Cut exactly at a chunk: what is left is not marked as the last, and so does not open as one.
    writeFileSync(path.join(dir, ID(13)), original.subarray(0, frameEnd));
    await expect(whole(ID(13))).rejects.toBeInstanceOf(CryptoError);
    // The first chunk repeated, and the first two swapped.
    writeFileSync(
      path.join(dir, ID(14)),
      Buffer.concat([original.subarray(0, frameEnd), original]),
    );
    await expect(whole(ID(14))).rejects.toBeInstanceOf(CryptoError);
    // Another id, and another key.
    writeFileSync(path.join(dir, ID(15)), original);
    await expect(whole(ID(15))).rejects.toBeInstanceOf(CryptoError);
    await expect(whole(ID(10), other)).rejects.toBeInstanceOf(CryptoError);
    // The untouched one still opens.
    expect((await whole(ID(10))).equals(bytes)).toBe(true);
  });

  it('is opened into a plain file for a reader that must seek, in a directory of the caller’s, and the caller removes it', async () => {
    const bytes = randomBytes(CHUNK_BYTES + 99);
    await writeImport(dir, ID(20), parts(bytes, 4096), ring);
    const into = path.join(dir, 'work');
    const plain = await materializeImport(dir, ID(20), ring, into);
    expect(readFileSync(plain.path).equals(bytes)).toBe(true);
    expect(statSync(plain.path).mode & 0o777).toBe(0o600);
    await plain.remove();
    expect(readdirSync(into)).toEqual([]);
    // A file that does not open leaves no plain file behind.
    await expect(materializeImport(dir, ID(11), ring, into)).rejects.toBeInstanceOf(CryptoError);
    expect(readdirSync(into)).toEqual([]);
  });

  it('refuses a name that is not an id, lists only ids, and removes twice without complaint', async () => {
    await expect(writeImport(dir, '../escape', parts(Buffer.from('x'), 1), ring)).rejects.toThrow();
    expect(await hasImport(dir, ID(1))).toBe(true);
    await removeImport(dir, ID(1));
    await removeImport(dir, ID(1));
    expect(await hasImport(dir, ID(1))).toBe(false);
    expect((await listImports(dir)).every((name) => /^[0-9a-f-]{36}$/.test(name))).toBe(true);
  });
});
