import { createHash } from 'node:crypto';
import { type OutboundOptions, type OutboundResponse, outbound } from '../security/outbound';
import { DiskCache } from './cache';
import { type MapSettings, DEFAULT_UPSTREAM_URL } from './config';
import { bundled, bundledDir, parseFont, parseRange } from './glyphs';
import { PmtilesReader } from './pmtiles';
import { type Theme, styleFor } from './style';

/**
 * The map as Waymark serves it (DESIGN.md §8.1): the style, tiles and glyphs, from the source the operator chose. **The browser reaches this and nothing else**; what leaves the server goes
 * through the one outbound helper, to the upstream's host and no other.
 *
 *  - `proxy`: a tile is read from the disk cache, or fetched once from the upstream and kept. The upstream is a TileJSON (the default's is `https://tiles.openfreemap.org/planet`, whose tile address
 *    carries a version that changes) or an address with `{z}`, `{x}` and `{y}`. The cache is keyed by that address, so a new version is new tiles, and the old ones go when nothing reads them.
 *    The same tile asked for at once is one request. Nothing in a request names a person: the User-Agent names Waymark and the instance.
 *  - `pmtiles`: a tile is read from the file, by range. No request to anyone.
 *  - `off`: there is no map, and every answer is `off`.
 */
export type Served =
  | { status: 'ok'; body: Buffer; gzip: boolean; type: string }
  /** The upstream, or the file, has no tile or glyph there: not an error, a map draws the gap as empty. */
  | { status: 'empty' }
  | { status: 'bad' | 'unavailable' | 'off' };

export interface MapDeps {
  readonly settings: MapSettings;
  /** Names Waymark and the instance's address: `Waymark (https://waymark.example.com)`. */
  readonly userAgent: string;
  readonly send?: (address: string, options: OutboundOptions) => Promise<OutboundResponse>;
  /** Where the bundled glyphs are; the server's own by default. */
  readonly glyphDir?: string;
  readonly now?: () => number;
}

export const MAX_ZOOM = 14;
const TILEJSON_FRESH_MS = 60 * 60 * 1000;
const TILE_TYPE = 'application/vnd.mapbox-vector-tile';
const GLYPH_TYPE = 'application/x-protobuf';
const isGzip = (body: Buffer) => body.length > 2 && body[0] === 0x1f && body[1] === 0x8b;

/** Tile coordinates as a route gets them: whole numbers, within the map's zoom and the tile grid. */
export function parseTile(
  z: string,
  x: string,
  y: string,
): { z: number; x: number; y: number } | undefined {
  if (![z, x, y].every((part) => /^\d{1,8}$/.test(part))) return undefined;
  const [zn, xn, yn] = [Number(z), Number(x), Number(y)] as [number, number, number];
  const side = 2 ** zn;
  return zn <= MAX_ZOOM && xn < side && yn < side ? { z: zn, x: xn, y: yn } : undefined;
}

export class MapService {
  private readonly cache: DiskCache;
  private readonly flying = new Map<string, Promise<Served>>();
  private template: { url: string; at: number } | undefined;
  private reader: PmtilesReader | undefined;

  constructor(private readonly deps: MapDeps) {
    this.cache = new DiskCache(`${deps.settings.dir}/cache`);
  }

  get diskCache(): DiskCache {
    return this.cache;
  }

  /** Whether there is a map at all. */
  get on(): boolean {
    return this.deps.settings.source !== 'off';
  }

  /** What the cache may hold, and whether this source has a cache at all. */
  get limits(): Pick<MapSettings, 'source' | 'cacheMaxBytes'> {
    return this.deps.settings;
  }

  private now() {
    return (this.deps.now ?? Date.now)();
  }

  /** The style for a theme, or undefined when there is no map. */
  style(theme: Theme, origin: string) {
    return this.deps.settings.source === 'off'
      ? undefined
      : styleFor(theme, origin, this.deps.settings);
  }

  async tile(z: string, x: string, y: string): Promise<Served> {
    const { settings } = this.deps;
    if (settings.source === 'off') return { status: 'off' };
    const at = parseTile(z, x, y);
    if (!at) return { status: 'bad' };
    if (settings.source === 'pmtiles') {
      if (!settings.pmtilesPath) return { status: 'unavailable' };
      this.reader ??= new PmtilesReader(settings.pmtilesPath);
      const found = await this.reader.tile(at.z, at.x, at.y);
      return found.status === 'ok' ? { ...found, type: TILE_TYPE } : found;
    }
    return this.shared(`t:${at.z}/${at.x}/${at.y}`, () => this.proxyTile(at));
  }

  async glyph(fontstack: string, range: string): Promise<Served> {
    const { settings } = this.deps;
    if (settings.source === 'off') return { status: 'off' };
    const font = parseFont(fontstack);
    if (!font || !parseRange(range)) return { status: 'bad' };
    const local = await bundled(this.deps.glyphDir ?? bundledDir(), font, range);
    if (local) return { status: 'ok', body: local, gzip: false, type: GLYPH_TYPE };
    // Not one the image has: the default upstream's, kept like a tile, for the proxy only.
    if (settings.source !== 'proxy' || !settings.upstreamPublic) return { status: 'empty' };
    return this.shared(`g:${font}/${range}`, () => this.proxyGlyph(font, range));
  }

  /** The same thing asked for at once is one request. */
  private shared(key: string, work: () => Promise<Served>): Promise<Served> {
    const running = this.flying.get(key);
    if (running) return running;
    const started = work().finally(() => this.flying.delete(key));
    this.flying.set(key, started);
    return started;
  }

  private async fetchFrom(address: string): Promise<OutboundResponse | undefined> {
    try {
      return await (this.deps.send ?? outbound)(address, {
        allow: this.deps.settings.allow,
        headers: { 'user-agent': this.deps.userAgent, accept: '*/*', 'accept-encoding': 'gzip' },
        timeoutMs: 10_000,
        maxBytes: 4 * 1024 * 1024,
        maxRedirects: 1,
      });
    } catch {
      return undefined;
    }
  }

  /** The tile address of the upstream, with `{z}`, `{x}` and `{y}` still in it: its own if it is one, or the TileJSON's, looked at again each hour. */
  private async tileTemplate(): Promise<string | undefined> {
    const { upstreamUrl } = this.deps.settings;
    if (!upstreamUrl) return undefined;
    if (upstreamUrl.includes('{z}')) return upstreamUrl;
    if (this.template && this.now() - this.template.at < TILEJSON_FRESH_MS)
      return this.template.url;
    const response = await this.fetchFrom(upstreamUrl);
    let url: string | undefined;
    if (response?.status === 200) {
      try {
        const json: unknown = JSON.parse(response.body.toString('utf8'));
        const tiles = (json as { tiles?: unknown }).tiles;
        const first = Array.isArray(tiles) ? tiles[0] : undefined;
        // The tiles must be on the host the TileJSON is on: it is the one host that was allowed, and a TileJSON does not widen the list.
        if (
          typeof first === 'string' &&
          first.includes('{z}') &&
          first.includes('{x}') &&
          first.includes('{y}') &&
          new URL(first.replace(/\{[zxy]\}/g, '0')).host === new URL(upstreamUrl).host
        )
          url = first;
      } catch {
        url = undefined;
      }
    }
    if (url) {
      this.template = { url, at: this.now() };
      // Kept, so that a restart while the upstream is unreachable still finds the tiles it has.
      await this.cache.put('tilejson/template', Buffer.from(url));
      return url;
    }
    // Unreachable or wrong: the last one that worked, in memory or from before the restart, so that what is kept can still be shown.
    if (this.template) return this.template.url;
    const kept = (await this.cache.get('tilejson/template'))?.toString('utf8');
    if (kept?.includes('{z}')) {
      this.template = { url: kept, at: this.now() - TILEJSON_FRESH_MS + 60_000 };
      return kept;
    }
    return undefined;
  }

  private async proxyTile(at: { z: number; x: number; y: number }): Promise<Served> {
    const template = await this.tileTemplate();
    if (!template) return { status: 'unavailable' };
    // The address, not a version number, names what is kept: a new planet is new tiles.
    const version = createHash('sha256').update(template).digest('hex').slice(0, 10);
    const key = `tiles/${version}/${at.z}/${at.x}/${at.y}`;
    const kept = await this.cache.get(key);
    if (kept) return { status: 'ok', body: kept, gzip: isGzip(kept), type: TILE_TYPE };
    const address = template
      .replace('{z}', String(at.z))
      .replace('{x}', String(at.x))
      .replace('{y}', String(at.y));
    const response = await this.fetchFrom(address);
    if (!response) return { status: 'unavailable' };
    if (response.status === 404 || response.status === 204) return { status: 'empty' };
    if (response.status !== 200 || response.body.length === 0) return { status: 'unavailable' };
    await this.cache.put(key, response.body);
    return { status: 'ok', body: response.body, gzip: isGzip(response.body), type: TILE_TYPE };
  }

  private async proxyGlyph(font: string, range: string): Promise<Served> {
    const key = `glyphs/${font}/${range}`;
    const kept = await this.cache.get(key);
    if (kept) return { status: 'ok', body: kept, gzip: isGzip(kept), type: GLYPH_TYPE };
    const base = new URL(DEFAULT_UPSTREAM_URL).origin;
    const response = await this.fetchFrom(`${base}/fonts/${encodeURIComponent(font)}/${range}`);
    if (!response) return { status: 'unavailable' };
    if (response.status === 404) return { status: 'empty' };
    if (response.status !== 200 || response.body.length === 0) return { status: 'unavailable' };
    await this.cache.put(key, response.body);
    return { status: 'ok', body: response.body, gzip: isGzip(response.body), type: GLYPH_TYPE };
  }
}

export type { Theme };
