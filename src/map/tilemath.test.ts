import { describe, expect, it } from 'vitest';
import {
  MAP_BASICS,
  MAX_ZOOM,
  RINGS,
  TRIP_TILE_LIMIT,
  tileOf,
  tilesAround,
  tripTiles,
} from './tilemath';

/** The map tiles a trip keeps (DESIGN.md §14.5), without a map: the tile of a point, those around it, and the bound. */
describe('the tile of a point', () => {
  it('is the standard slippy-map tile', () => {
    // Worked out apart from this code, by the formula of the OpenStreetMap wiki's slippy-map page.
    expect(tileOf({ lat: 0, lng: 0 }, 1)).toEqual({ x: 1, y: 1 });
    expect(tileOf({ lat: 51.4779, lng: 0 }, 10)).toEqual({ x: 512, y: 340 });
    expect(tileOf({ lat: 35.6586, lng: 139.7454 }, 10)).toEqual({ x: 909, y: 403 });
    expect(tileOf({ lat: 38.7223, lng: -9.1393 }, 14)).toEqual({ x: 7_776, y: 6_277 });
  });

  it('stays on the map: the poles are held to Mercator’s limit and a longitude is wrapped', () => {
    expect(tileOf({ lat: 90, lng: 0 }, 5).y).toBe(0);
    expect(tileOf({ lat: -90, lng: 0 }, 5).y).toBe(31);
    expect(tileOf({ lat: 0, lng: 540 }, 3)).toEqual(tileOf({ lat: 0, lng: 180 }, 3));
    expect(tileOf({ lat: 10, lng: 180 }, 4).x).toBe(0);
  });
});

describe('the tiles around a point', () => {
  it('are a square of the tile and its neighbours, as addresses of this server', () => {
    const got = tilesAround({ lat: 38.7223, lng: -9.1393 }, 14, 1);
    expect(got).toHaveLength(9);
    expect(got).toContain('/api/map/tiles/14/7776/6277');
    expect(got.every((a) => /^\/api\/map\/tiles\/14\/\d+\/\d+$/.test(a))).toBe(true);
    expect(tilesAround({ lat: 38.7, lng: -9.1 }, 5, 0)).toHaveLength(1);
  });

  it('wraps round the world sideways and is cut off at its top and bottom', () => {
    const edge = tilesAround({ lat: 0, lng: 179.99 }, 3, 1);
    expect(edge).toContain('/api/map/tiles/3/0/3');
    expect(edge).toContain('/api/map/tiles/3/7/3');
    expect(tilesAround({ lat: 85, lng: 0 }, 3, 1)).toHaveLength(6);
  });
});

describe('what a trip keeps', () => {
  const POINTS = [
    { lat: 38.7223, lng: -9.1393 },
    { lat: 38.8, lng: -9.38 },
    { lat: 35.6586, lng: 139.7454 },
  ];

  it('is the map’s basics and the tiles around each stop, each address once, and none above the style’s own zoom', () => {
    const got = tripTiles(POINTS);
    expect(got.slice(0, MAP_BASICS.length)).toEqual([...MAP_BASICS]);
    expect(new Set(got).size).toBe(got.length);
    const zooms = got
      .filter((a) => a.startsWith('/api/map/tiles/'))
      .map((a) => Number(a.split('/')[4]));
    expect(Math.max(...zooms)).toBeLessThanOrEqual(MAX_ZOOM);
    expect(RINGS.every((ring) => ring.z <= MAX_ZOOM)).toBe(true);
    // Every stop has its tile at the finest zoom.
    expect(got).toContain('/api/map/tiles/14/7776/6277');
    expect(got).toContain('/api/map/tiles/14/14551/6452');
  });

  it('is coarse zooms first, so that a bound cuts the finest tiles of the last stops and not a stop’s whole map', () => {
    const got = tripTiles(POINTS, 40).filter((a) => a.startsWith('/api/map/tiles/'));
    expect(got).toHaveLength(40);
    const zooms = got.map((a) => Number(a.split('/')[4]));
    expect(zooms).toEqual([...zooms].sort((a, b) => a - b));
    // The coarsest tile of every stop is there before any fine one.
    // Every stop's coarsest tile is there before any stop's finer one: Lisbon and Tokyo are in different tiles at zoom 3 (Sintra shares Lisbon's).
    expect(got.filter((a) => a.startsWith('/api/map/tiles/3/'))).toHaveLength(2);
  });

  it('is bounded for a trip of any size, and shares the tiles of stops that are close', () => {
    const many = Array.from({ length: 100 }, (_, i) => ({ lat: (i % 60) - 30, lng: i * 3 - 150 }));
    expect(tripTiles(many).filter((a) => a.startsWith('/api/map/tiles/')).length).toBe(
      TRIP_TILE_LIMIT,
    );
    const close = tripTiles([POINTS[0] as never, { lat: 38.7224, lng: -9.1394 }]);
    expect(close.filter((a) => a.startsWith('/api/map/tiles/')).length).toBeLessThan(110);
  });
});
