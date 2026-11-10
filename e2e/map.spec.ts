import { expect, test } from '@playwright/test';
import { PORTS } from './ports';
import { signedIn, watchOrigin } from './helpers';

/**
 * The map's routes, as a browser calls them (DESIGN.md §8.1), on an instance whose tiles are read from a PMTiles file made for the test: a signed-in person gets Waymark's own style, tiles and
 * glyphs, a visitor gets nothing, and nothing in any of it names another host. (The `off` source is the unit tests': this instance has a map.)
 */
const ORIGIN = `http://localhost:${PORTS.app}`;

test('a signed-in person gets the style in both themes, naming Waymark’s own addresses and no one else’s', async ({
  page,
}) => {
  await signedIn(page);
  for (const theme of ['light', 'dark']) {
    const response = await page.request.get(`/api/map/style/${theme}.json`);
    expect(response.status()).toBe(200);
    expect(response.headers()['content-type']).toContain('application/json');
    const style = await response.json();
    expect(style.sources.openmaptiles.tiles).toEqual([`${ORIGIN}/api/map/tiles/{z}/{x}/{y}`]);
    expect(style.glyphs).toBe(`${ORIGIN}/api/map/glyphs/{fontstack}/{range}.pbf`);
    expect(style.sources.openmaptiles.attribution).toContain('OpenStreetMap contributors');
    const hosts = [
      ...JSON.stringify({
        ...style,
        sources: { openmaptiles: { ...style.sources.openmaptiles, attribution: '' } },
      }).matchAll(/https?:\/\/([^/"]+)/g),
    ].map((m) => m[1]);
    expect(new Set(hosts)).toEqual(new Set([`localhost:${PORTS.app}`]));
  }
  expect((await page.request.get('/api/map/style/purple.json')).status()).toBe(404);
  expect((await page.request.get('/api/map/style/light')).status()).toBe(404);
});

test('a tile comes from the file, an empty one is a gap, and what is not a tile is not found', async ({
  page,
}) => {
  await signedIn(page);
  const zero = await page.request.get('/api/map/tiles/0/0/0');
  expect(zero.status()).toBe(200);
  expect(zero.headers()['content-type']).toBe('application/vnd.mapbox-vector-tile');
  expect(zero.headers()['cache-control']).toContain('private');
  expect(zero.headers()['x-content-type-options']).toBe('nosniff');
  expect((await zero.body()).toString()).toBe('tile-zero');
  expect((await (await page.request.get('/api/map/tiles/1/0/1')).body()).toString()).toBe(
    'tile-one',
  );
  expect((await page.request.get('/api/map/tiles/1/1/1')).status()).toBe(204);
  for (const path of ['tiles/15/0/0', 'tiles/1/2/0', 'tiles/1/0/abc', 'tiles/-1/0/0'])
    expect((await page.request.get(`/api/map/${path}`)).status(), path).toBe(404);
});

test('the glyphs of the style’s fonts come from the image, and no other font or range does', async ({
  page,
}) => {
  await signedIn(page);
  for (const font of ['Noto Sans Regular', 'Noto Sans Bold']) {
    const response = await page.request.get(
      `/api/map/glyphs/${encodeURIComponent(font)}/0-255.pbf`,
    );
    expect(response.status(), font).toBe(200);
    expect(response.headers()['content-type']).toBe('application/x-protobuf');
    expect((await response.body()).length).toBeGreaterThan(1000);
  }
  for (const path of [
    'glyphs/Arial/0-255.pbf',
    'glyphs/Noto%20Sans%20Regular/0-256.pbf',
    'glyphs/Noto%20Sans%20Regular/19968-20223.pbf',
    'glyphs/..%2F..%2Fetc/0-255.pbf',
  ])
    expect((await page.request.get(`/api/map/${path}`)).status(), path).toBe(404);
});

test('a visitor gets none of it', async ({ playwright }) => {
  const visitor = await playwright.request.newContext({ baseURL: ORIGIN });
  for (const path of ['style/light.json', 'tiles/0/0/0', 'glyphs/Noto%20Sans%20Regular/0-255.pbf'])
    expect((await visitor.get(`/api/map/${path}`)).status(), path).toBe(401);
  await visitor.dispose();
});

test('the map’s files are all this origin’s: the page that has them asks nobody else', async ({
  page,
}) => {
  await signedIn(page);
  const foreign = watchOrigin(page);
  await page.goto('/map');
  await page.request.get('/api/map/style/light.json');
  expect(foreign()).toEqual([]);
});
