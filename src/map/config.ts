import type { Problem } from '../config';
import type { HostRule } from '../security/outbound';

/**
 * Where the map's tiles come from (DESIGN.md §8.1): `WAYMARK_MAP_SOURCE` is `proxy` (the default: the server fetches tiles from `WAYMARK_MAP_UPSTREAM_URL` and keeps them on disk),
 * `pmtiles` (read from the file `WAYMARK_MAP_PMTILES_PATH`, with no request to anyone, ever) or `off` (no map: every map view shows its list). The browser asks Waymark for all of it
 * (`/api/map/*`) and loads nothing from elsewhere.
 *
 * **The default upstream is OpenFreeMap's planet** (README, "The map"): free, no key, built from OpenStreetMap in the OpenMapTiles schema, which is the schema Waymark's own style is written
 * for, and so is a PMTiles file's (made with `planetiler`, whose default is that schema). An address of the operator's own, a tile server of their own, may be http on a private network.
 */
export type MapSource = 'proxy' | 'pmtiles' | 'off';

export interface MapSettings {
  readonly source: MapSource;
  /** The TileJSON of the upstream, or a tile address with `{z}`, `{x}` and `{y}`; for `proxy` only. */
  readonly upstreamUrl: string | undefined;
  /** Whether the upstream is the default public one, which is always https and never a private address. */
  readonly upstreamPublic: boolean;
  /** What the outbound helper may reach for the tiles, glyphs and TileJSON, and nothing else. Empty unless `proxy`. */
  readonly allow: readonly HostRule[];
  /** The PMTiles file; for `pmtiles` only. */
  readonly pmtilesPath: string | undefined;
  /** `<data>/map`: where the cache is (`cache/`) and where a PMTiles file is kept. */
  readonly dir: string;
  /** The most the cache may hold, in bytes. */
  readonly cacheMaxBytes: number;
}

export const DEFAULT_UPSTREAM_URL = 'https://tiles.openfreemap.org/planet';
/** The upstream's own glyph ranges are proxied from the same host, under `/fonts/`: see `glyphs.ts`. */
export const DEFAULT_CACHE_MAX_MB = 2048;

export function resolveMap(
  read: (name: string) => string | undefined,
  dataDir: string,
  problems: Problem[],
): MapSettings {
  const dir = `${dataDir === '/' ? '' : dataDir}/map`;
  const off: MapSettings = {
    source: 'off',
    upstreamUrl: undefined,
    upstreamPublic: false,
    allow: [],
    pmtilesPath: undefined,
    dir,
    cacheMaxBytes: DEFAULT_CACHE_MAX_MB * 1024 * 1024,
  };
  const source = (read('WAYMARK_MAP_SOURCE') ?? 'proxy').trim().toLowerCase();
  if (source !== 'proxy' && source !== 'pmtiles' && source !== 'off') {
    problems.push('WAYMARK_MAP_SOURCE is proxy, pmtiles or off.');
    return off;
  }

  let cacheMaxBytes = DEFAULT_CACHE_MAX_MB * 1024 * 1024;
  const rawLimit = read('WAYMARK_MAP_CACHE_MAX_MB');
  if (rawLimit !== undefined) {
    const parsed = Number(rawLimit);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 10_000_000)
      problems.push('WAYMARK_MAP_CACHE_MAX_MB is a whole number of megabytes, 1 or more.');
    else cacheMaxBytes = parsed * 1024 * 1024;
  }
  if (source === 'off') return { ...off, cacheMaxBytes };

  if (source === 'pmtiles') {
    const path = read('WAYMARK_MAP_PMTILES_PATH');
    if (path === undefined)
      problems.push(
        'WAYMARK_MAP_SOURCE is pmtiles, and the map needs WAYMARK_MAP_PMTILES_PATH, the file to read tiles from.',
      );
    else if (!path.startsWith('/') || path.endsWith('/'))
      problems.push('WAYMARK_MAP_PMTILES_PATH is the absolute path of a file.');
    return {
      ...off,
      source,
      pmtilesPath: path !== undefined && path.startsWith('/') ? path : undefined,
      cacheMaxBytes,
    };
  }

  const raw = (read('WAYMARK_MAP_UPSTREAM_URL') ?? DEFAULT_UPSTREAM_URL).trim();
  let parsed: URL | undefined;
  try {
    // `{z}` and the rest are not a valid host or path, so they are set aside to judge the address by the rest of it.
    parsed = new URL(raw.replace(/\{[zxy]\}/g, '0'));
  } catch {
    problems.push(
      'WAYMARK_MAP_UPSTREAM_URL is not an address. Give it as https://tiles.example.com/planet.',
    );
  }
  if (parsed) {
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:')
      problems.push('WAYMARK_MAP_UPSTREAM_URL must be an http or https address.');
    else if (parsed.username || parsed.password)
      problems.push('WAYMARK_MAP_UPSTREAM_URL must not carry a user name or password.');
    else if (parsed.search || parsed.hash)
      problems.push('WAYMARK_MAP_UPSTREAM_URL is an address with no query or fragment.');
  }
  const publicHost = new URL(DEFAULT_UPSTREAM_URL).hostname;
  const isPublic = parsed?.hostname.toLowerCase() === publicHost;
  if (parsed && isPublic && parsed.protocol === 'http:')
    problems.push('The public tile service is https only.');
  return {
    ...off,
    source,
    upstreamUrl: parsed ? raw.replace(/\/+$/, '') : undefined,
    upstreamPublic: isPublic,
    allow: parsed
      ? [{ host: parsed.hostname.toLowerCase(), allowPrivate: !isPublic, allowHttp: !isPublic }]
      : [],
    cacheMaxBytes,
  };
}
