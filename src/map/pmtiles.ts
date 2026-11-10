import { open } from 'node:fs/promises';
import { Compression, PMTiles, TileType, type RangeResponse, type Source } from 'pmtiles';

/**
 * Tiles read from a PMTiles file (DESIGN.md §8.1), by range, so that a planet is not read into memory and **nothing is requested from anyone, ever**. The file must hold vector tiles in the
 * OpenMapTiles schema (`planetiler --output=region.pmtiles` makes one), which is what Waymark's style is written for, and be uncompressed or gzip inside, as a browser can read either.
 * Directories are cached in memory by the `pmtiles` package.
 */
class FileSource implements Source {
  constructor(private readonly path: string) {}
  getKey(): string {
    return this.path;
  }
  async getBytes(offset: number, length: number): Promise<RangeResponse> {
    const handle = await open(this.path, 'r');
    try {
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, offset);
      return {
        data: buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + bytesRead) as ArrayBuffer,
      };
    } finally {
      await handle.close();
    }
  }
}

export type PmtilesTile =
  { status: 'ok'; body: Buffer; gzip: boolean } | { status: 'empty' | 'unavailable' };

export class PmtilesReader {
  private archive: PMTiles;
  private checked: Promise<'ok' | 'wrong'> | undefined;

  constructor(private readonly path: string) {
    this.archive = new PMTiles(new FileSource(path));
  }

  /** Once: whether the file is one this can serve (vector tiles, uncompressed or gzip). */
  private check(): Promise<'ok' | 'wrong'> {
    this.checked ??= this.archive
      .getHeader()
      .then((header) =>
        header.tileType === TileType.Mvt &&
        (header.tileCompression === Compression.None || header.tileCompression === Compression.Gzip)
          ? 'ok'
          : 'wrong',
      );
    return this.checked;
  }

  async tile(z: number, x: number, y: number): Promise<PmtilesTile> {
    try {
      if ((await this.check()) !== 'ok') return { status: 'unavailable' };
      const found = await this.archive.getZxy(z, x, y);
      if (!found) return { status: 'empty' };
      const body = Buffer.from(found.data);
      return { status: 'ok', body, gzip: body.length > 2 && body[0] === 0x1f && body[1] === 0x8b };
    } catch {
      // A file that is not there or not a PMTiles file is the same to a person: the map has no tile. What the archive remembered of it is forgotten, so that a file put there later is read.
      this.checked = undefined;
      this.archive = new PMTiles(new FileSource(this.path));
      return { status: 'unavailable' };
    }
  }
}
