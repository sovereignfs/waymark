/**
 * Which map tiles a trip needs with no network (DESIGN.md §14.5), pure: the standard slippy-map tile of a point at a zoom, the tiles around it, and the addresses a trip keeps. **Around each stop, to a street level, and a
 * bounded number for the whole trip**: the style's tiles stop at zoom 14 (`src/map/style.ts`), so that is the most that is ever fetched, and the addresses are the app's own (`/api/map/tiles/<z>/<x>/<y>`, which the server
 * proxies or reads from its own file): nothing here names another host.
 */
export const MAX_ZOOM = 14;

/** What is kept around a stop: the zoom and how many tiles out from the one that holds the stop (1 is the three by three around it). */
export const RINGS: readonly { readonly z: number; readonly radius: number }[] = [
  ...[3, 4, 5, 6, 7].map((z) => ({ z, radius: 0 })),
  ...[8, 9, 10, 11, 12, 13].map((z) => ({ z, radius: 1 })),
  { z: 14, radius: 2 },
];

/** The most tiles a trip keeps, with the style and the glyphs on top. */
export const TRIP_TILE_LIMIT = 600;

export interface Point {
  readonly lat: number;
  readonly lng: number;
}

/** The tile that holds a point at a zoom, with the latitude held to what the map can show (Web Mercator stops at about ±85.05°). */
export function tileOf(point: Point, z: number): { x: number; y: number } {
  const n = 2 ** z;
  const lat = Math.max(-85.0511, Math.min(85.0511, point.lat));
  const lng = ((((point.lng + 180) % 360) + 360) % 360) - 180;
  const x = Math.floor(((lng + 180) / 360) * n);
  const rad = (lat * Math.PI) / 180;
  const y = Math.floor(((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n);
  return { x: Math.max(0, Math.min(n - 1, x)), y: Math.max(0, Math.min(n - 1, y)) };
}

export const tileAddress = (z: number, x: number, y: number): string =>
  `/api/map/tiles/${z}/${x}/${y}`;

/** The addresses of the tiles around a point at a zoom: a square of `2 * radius + 1` tiles, wrapping round the world sideways and cut off at its top and bottom. */
export function tilesAround(point: Point, z: number, radius: number): string[] {
  const n = 2 ** z;
  const centre = tileOf(point, z);
  const out: string[] = [];
  for (let dy = -radius; dy <= radius; dy++)
    for (let dx = -radius; dx <= radius; dx++) {
      const y = centre.y + dy;
      if (y < 0 || y >= n) continue;
      out.push(tileAddress(z, (((centre.x + dx) % n) + n) % n, y));
    }
  return out;
}

/** The style for each theme and the two fonts' first range of glyphs (the Latin letters labels are drawn in): what a map needs besides its tiles. */
export const MAP_BASICS: readonly string[] = [
  '/api/map/style/light.json',
  '/api/map/style/dark.json',
  '/api/map/glyphs/Noto%20Sans%20Regular/0-255.pbf',
  '/api/map/glyphs/Noto%20Sans%20Bold/0-255.pbf',
];

/**
 * Everything a trip keeps: the map's basics and the tiles around every stop's place, **coarse zooms first**, so that if the bound cuts anything off it is the finest tiles of the last stops, and every stop still has a map. Each address
 * once however many stops share it.
 */
export function tripTiles(points: readonly Point[], limit = TRIP_TILE_LIMIT): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const ring of RINGS)
    for (const point of points)
      for (const address of tilesAround(point, ring.z, ring.radius))
        if (!seen.has(address) && out.length < limit) {
          seen.add(address);
          out.push(address);
        }
  return [...MAP_BASICS, ...out];
}
