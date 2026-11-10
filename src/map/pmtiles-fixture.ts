import { gzipSync } from 'node:zlib';
import { zxyToTileId } from 'pmtiles';

/** A PMTiles v3 archive in memory, for the tests: its tiles are given by `[z, x, y]`, in one directory with no compression inside, and `compression` is that of the tiles (1 none, 2 gzip). */
export function makePmtiles(
  tiles: readonly { z: number; x: number; y: number; data: Buffer }[],
  options: { compression?: 1 | 2; tileType?: number } = {},
): Buffer {
  const varint = (n: number): number[] => {
    const out: number[] = [];
    let v = n;
    while (v >= 0x80) {
      out.push((v & 0x7f) | 0x80);
      v = Math.floor(v / 128);
    }
    out.push(v);
    return out;
  };
  const sorted = tiles
    .map((tile) => ({ ...tile, id: zxyToTileId(tile.z, tile.x, tile.y) }))
    .sort((a, b) => a.id - b.id);
  const bytes: number[] = [...varint(sorted.length)];
  let last = 0;
  for (const tile of sorted) {
    bytes.push(...varint(tile.id - last));
    last = tile.id;
  }
  for (const _ of sorted) bytes.push(...varint(1)); // run length
  for (const tile of sorted) bytes.push(...varint(tile.data.length));
  let offset = 0;
  for (const tile of sorted) {
    bytes.push(...varint(offset === 0 && tile === sorted[0] ? 1 : 0)); // 0: straight after the one before
    offset += tile.data.length;
  }
  const directory = Buffer.from(bytes);
  const header = Buffer.alloc(127);
  header.write('PMTiles', 0, 'latin1');
  header[7] = 3;
  const big = (value: number, at: number) => header.writeBigUInt64LE(BigInt(value), at);
  const data = Buffer.concat(sorted.map((tile) => tile.data));
  big(127, 8); // root directory
  big(directory.length, 16);
  big(127 + directory.length, 24); // metadata: none
  big(0, 32);
  big(127 + directory.length, 40); // leaf directories: none
  big(0, 48);
  big(127 + directory.length, 56); // tile data
  big(data.length, 64);
  big(sorted.length, 72);
  big(sorted.length, 80);
  big(sorted.length, 88);
  header[96] = 1; // clustered
  header[97] = 1; // directories are not compressed
  header[98] = options.compression ?? 1;
  header[99] = options.tileType ?? 1; // MVT
  header[100] = 0;
  header[101] = 14;
  return Buffer.concat([header, directory, data]);
}

export const gzipped = (text: string) => gzipSync(Buffer.from(text));
