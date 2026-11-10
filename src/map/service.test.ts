import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { OutboundOptions, OutboundResponse } from '../security/outbound';
import { DEFAULT_UPSTREAM_URL, type MapSettings } from './config';
import { FONTS, parseFont, parseRange } from './glyphs';
import { mapResponse } from './http';
import { gzipped, makePmtiles } from './pmtiles-fixture';
import { MapService, parseTile } from './service';

/**
 * The tile service (DESIGN.md §8.1), without a network: the upstream is a function that answers as OpenFreeMap does, and counts what it was asked. Nothing here reaches the internet.
 */
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'waymark-map-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const VERSION_ONE = 'https://tiles.openfreemap.org/planet/20261101_080013_pt/{z}/{x}/{y}.pbf';
const VERSION_TWO = 'https://tiles.openfreemap.org/planet/20261108_080013_pt/{z}/{x}/{y}.pbf';

const settings = (over: Partial<MapSettings> = {}): MapSettings => ({
  source: 'proxy',
  upstreamUrl: DEFAULT_UPSTREAM_URL,
  upstreamPublic: true,
  allow: [{ host: 'tiles.openfreemap.org' }],
  pmtilesPath: undefined,
  dir,
  cacheMaxBytes: 1024 * 1024,
  ...over,
});

/** An upstream that answers the TileJSON with the template it is told to, and a tile with its own address as the bytes. */
function upstream(
  state: { template: string; tilejson?: number; tile?: number } = { template: VERSION_ONE },
) {
  const asked: { address: string; headers: Record<string, string> | undefined }[] = [];
  const send = async (address: string, options: OutboundOptions): Promise<OutboundResponse> => {
    asked.push({ address, headers: options.headers });
    const reply = (status: number, body: string | Buffer): OutboundResponse => ({
      status,
      headers: {},
      body: Buffer.from(body),
    });
    if (address === DEFAULT_UPSTREAM_URL)
      return reply(
        state.tilejson ?? 200,
        JSON.stringify({ tilejson: '3.0.0', tiles: [state.template] }),
      );
    if (address.includes('/fonts/')) return reply(200, `glyphs ${address}`);
    return reply(state.tile ?? 200, `tile ${address}`);
  };
  return { asked, send, state };
}
const service = (over: Partial<MapSettings> = {}, send?: ReturnType<typeof upstream>['send']) =>
  new MapService({
    settings: settings(over),
    userAgent: 'Waymark (https://waymark.example.com)',
    ...(send ? { send } : {}),
  });
const tilesAsked = (u: ReturnType<typeof upstream>) =>
  u.asked.filter((a) => a.address.includes('/planet/2'));

describe('tile coordinates', () => {
  it('are whole numbers within the zoom and the grid, and nothing else reaches a file or an address', () => {
    expect(parseTile('0', '0', '0')).toEqual({ z: 0, x: 0, y: 0 });
    expect(parseTile('14', '16383', '16383')).toEqual({ z: 14, x: 16383, y: 16383 });
    for (const [z, x, y] of [
      ['15', '0', '0'],
      ['2', '4', '0'],
      ['2', '0', '4'],
      ['-1', '0', '0'],
      ['1', '1.5', '0'],
      ['1', '0', '0.pbf'],
      ['1', '0x1', '0'],
      ['', '0', '0'],
      ['1', '../0', '0'],
      ['00000000001', '0', '0'],
      ['1', '0', '1e1'],
    ] as const)
      expect(parseTile(z, x, y), `${z}/${x}/${y}`).toBeUndefined();
  });
});

describe('the proxy source', () => {
  it('finds the tile address in the upstream’s TileJSON, fetches a tile once, and keeps it', async () => {
    const u = upstream();
    const map = service({}, u.send);
    const first = await map.tile('3', '4', '2');
    expect(first).toMatchObject({
      status: 'ok',
      gzip: false,
      type: 'application/vnd.mapbox-vector-tile',
    });
    expect(first.status === 'ok' && first.body.toString()).toBe(
      'tile https://tiles.openfreemap.org/planet/20261101_080013_pt/3/4/2.pbf',
    );
    const second = await map.tile('3', '4', '2');
    expect(second).toEqual(first);
    expect(tilesAsked(u)).toHaveLength(1);
    // Another process, or this one after a restart, finds it on disk and asks for no tile.
    const again = service({}, u.send);
    expect((await again.tile('3', '4', '2')).status).toBe('ok');
    expect(tilesAsked(u)).toHaveLength(1);
  });

  it('names Waymark and the instance to the upstream, and nothing of a person', async () => {
    const u = upstream();
    await service({}, u.send).tile('1', '0', '0');
    for (const request of u.asked)
      expect(request.headers?.['user-agent']).toBe('Waymark (https://waymark.example.com)');
    expect(JSON.stringify(u.asked)).not.toMatch(/cookie|authorization/i);
  });

  it('serves a gzip tile as gzip, for the browser to open', async () => {
    const send = async (address: string): Promise<OutboundResponse> => ({
      status: 200,
      headers: {},
      body:
        address === DEFAULT_UPSTREAM_URL
          ? Buffer.from(JSON.stringify({ tiles: [VERSION_ONE] }))
          : gzipped('compressed tile'),
    });
    const map = service({}, send);
    expect(await map.tile('1', '0', '0')).toMatchObject({ status: 'ok', gzip: true });
    expect(await map.tile('1', '0', '0')).toMatchObject({ status: 'ok', gzip: true }); // and from the disk
    const response = mapResponse(await map.tile('1', '0', '0'), 'tile');
    expect(response.headers.get('content-encoding')).toBe('gzip');
    expect(response.headers.get('cache-control')).toBe('private, max-age=86400');
  });

  it('keeps a new planet apart from the old: the address names what is kept', async () => {
    const u = upstream();
    const map = service({}, u.send);
    await map.tile('1', '0', '0');
    u.state.template = VERSION_TWO;
    // The TileJSON is looked at again after an hour.
    const later = new MapService({
      settings: settings(),
      userAgent: 'Waymark',
      send: u.send,
      now: () => Date.now() + 2 * 60 * 60 * 1000,
    });
    const fresh = await later.tile('1', '0', '0');
    expect(fresh.status === 'ok' && fresh.body.toString()).toContain('20261108');
    expect(readdirSync(path.join(dir, 'cache', 'tiles'))).toHaveLength(2);
  });

  it('keeps nothing of a tile that is not there or an upstream that failed, and asks again', async () => {
    const u = upstream();
    const map = service({}, u.send);
    u.state.tile = 404;
    expect(await map.tile('5', '1', '1')).toEqual({ status: 'empty' });
    u.state.tile = 503;
    expect(await map.tile('5', '1', '1')).toEqual({ status: 'unavailable' });
    u.state.tile = 200;
    expect((await map.tile('5', '1', '1')).status).toBe('ok');
    expect(tilesAsked(u)).toHaveLength(3);
  });

  it('is one request for the same tile asked for at once', async () => {
    const u = upstream();
    const map = service({}, u.send);
    const all = await Promise.all([
      map.tile('6', '2', '2'),
      map.tile('6', '2', '2'),
      map.tile('6', '2', '2'),
    ]);
    expect(all.every((each) => each.status === 'ok')).toBe(true);
    expect(tilesAsked(u)).toHaveLength(1);
  });

  it('says it is unavailable when the upstream cannot be reached and there is nothing kept, and shows what is kept when it cannot', async () => {
    const u = upstream();
    await service({}, u.send).tile('1', '1', '1');
    const down = async (): Promise<OutboundResponse> => {
      throw new Error('unreachable');
    };
    const offline = service({}, down);
    expect((await offline.tile('1', '1', '1')).status).toBe('ok'); // the address it kept, and the tile it kept
    expect(await offline.tile('1', '0', '0')).toEqual({ status: 'unavailable' });
    const nothing = new MapService({
      settings: settings({ dir: path.join(dir, 'empty') }),
      userAgent: 'Waymark',
      send: down,
    });
    expect(await nothing.tile('1', '1', '1')).toEqual({ status: 'unavailable' });
  });

  it('does not follow a TileJSON to a host it was not given', async () => {
    const u = upstream({ template: 'https://evil.example.com/{z}/{x}/{y}.pbf' });
    const map = service({}, u.send);
    expect(await map.tile('1', '0', '0')).toEqual({ status: 'unavailable' });
    expect(u.asked.filter((a) => a.address.includes('evil'))).toEqual([]);
  });

  it('takes an upstream that is a tile address, with no TileJSON to ask for', async () => {
    const u = upstream();
    const map = service(
      { upstreamUrl: 'https://tiles.openfreemap.org/own/{z}/{x}/{y}', upstreamPublic: false },
      u.send,
    );
    expect((await map.tile('2', '1', '1')).status).toBe('ok');
    expect(u.asked.map((a) => a.address)).toEqual(['https://tiles.openfreemap.org/own/2/1/1']);
  });

  it('refuses coordinates that are not a tile, asking no one', async () => {
    const u = upstream();
    const map = service({}, u.send);
    expect(await map.tile('99', '0', '0')).toEqual({ status: 'bad' });
    expect(await map.tile('1', '../etc', '0')).toEqual({ status: 'bad' });
    expect(u.asked).toEqual([]);
  });
});

describe('glyphs', () => {
  it('are in the image for Latin, Greek, Cyrillic and punctuation, and are served with no request to anyone', async () => {
    const u = upstream();
    const map = service({}, u.send);
    for (const font of FONTS)
      for (const range of ['0-255.pbf', '256-511.pbf', '1280-1535.pbf', '8192-8447.pbf']) {
        const served = await map.glyph(font, range);
        expect(served, `${font} ${range}`).toMatchObject({
          status: 'ok',
          gzip: false,
          type: 'application/x-protobuf',
        });
        expect(served.status === 'ok' && served.body.length).toBeGreaterThan(1000);
      }
    expect(u.asked).toEqual([]);
  });

  it('are fetched from the default upstream and kept, for a range the image does not have, when the source is the proxy', async () => {
    const u = upstream();
    const map = service({}, u.send);
    const first = await map.glyph('Noto Sans Regular', '19968-20223.pbf');
    expect(first.status === 'ok' && first.body.toString()).toBe(
      'glyphs https://tiles.openfreemap.org/fonts/Noto%20Sans%20Regular/19968-20223.pbf',
    );
    await map.glyph('Noto Sans Regular', '19968-20223.pbf');
    expect(u.asked).toHaveLength(1);
  });

  it('are not fetched from anyone with `pmtiles`, or from an upstream that is not the default: the range is absent', async () => {
    const u = upstream();
    expect(
      await service(
        {
          source: 'pmtiles',
          pmtilesPath: path.join(dir, 'x.pmtiles'),
          upstreamUrl: undefined,
          upstreamPublic: false,
          allow: [],
        },
        u.send,
      ).glyph('Noto Sans Bold', '19968-20223.pbf'),
    ).toEqual({ status: 'empty' });
    expect(
      await service(
        {
          upstreamUrl: 'https://t.example.com/planet',
          upstreamPublic: false,
          allow: [{ host: 't.example.com' }],
        },
        u.send,
      ).glyph('Noto Sans Bold', '19968-20223.pbf'),
    ).toEqual({ status: 'empty' });
    expect(u.asked).toEqual([]);
  });

  it('are only the style’s two fonts, in ranges of 256, and never a path', async () => {
    expect(parseFont('Noto Sans Regular')).toBe('Noto Sans Regular');
    for (const font of [
      'Arial',
      '../x',
      'Noto Sans Italic',
      '',
      'Noto Sans Regular,Noto Sans Bold',
    ])
      expect(parseFont(font), font).toBeUndefined();
    expect(parseRange('0-255.pbf')).toEqual({ start: 0, end: 255 });
    for (const range of [
      '0-256.pbf',
      '1-256.pbf',
      '0-255',
      '0-255.pbf/..',
      '../0-255.pbf',
      '65536-65791.pbf',
      'a-b.pbf',
    ])
      expect(parseRange(range), range).toBeUndefined();
    const u = upstream();
    const map = service({}, u.send);
    expect(await map.glyph('Arial', '0-255.pbf')).toEqual({ status: 'bad' });
    expect(await map.glyph('Noto Sans Regular', '../../x.pbf')).toEqual({ status: 'bad' });
    expect(u.asked).toEqual([]);
  });
});

describe('the pmtiles source', () => {
  const file = (name: string, content: Buffer) => {
    const where = path.join(dir, name);
    writeFileSync(where, content);
    return where;
  };
  const pmtiles = (pmtilesPath: string, send?: ReturnType<typeof upstream>['send']) =>
    service(
      { source: 'pmtiles', pmtilesPath, upstreamUrl: undefined, upstreamPublic: false, allow: [] },
      send,
    );

  it('reads a tile by range from the file, and asks no one', async () => {
    const u = upstream();
    const where = file(
      'region.pmtiles',
      makePmtiles([
        { z: 0, x: 0, y: 0, data: Buffer.from('zero') },
        { z: 1, x: 1, y: 0, data: Buffer.from('one-one-zero') },
        { z: 2, x: 3, y: 3, data: Buffer.from('two') },
      ]),
    );
    const map = pmtiles(where, u.send);
    const zero = await map.tile('0', '0', '0');
    expect(zero).toMatchObject({
      status: 'ok',
      gzip: false,
      type: 'application/vnd.mapbox-vector-tile',
    });
    expect(zero.status === 'ok' && zero.body.toString()).toBe('zero');
    expect(
      (await map.tile('1', '1', '0')).status === 'ok' && (await map.tile('1', '1', '0')).status,
    ).toBe('ok');
    const two = await map.tile('2', '3', '3');
    expect(two.status === 'ok' && two.body.toString()).toBe('two');
    expect(await map.tile('1', '0', '0')).toEqual({ status: 'empty' });
    expect(u.asked).toEqual([]);
  });

  it('opens a file whose tiles are gzip inside, and serves the tile as it is', async () => {
    const where = file(
      'gz.pmtiles',
      makePmtiles([{ z: 0, x: 0, y: 0, data: gzipped('compressed') }], { compression: 2 }),
    );
    const served = await pmtiles(where).tile('0', '0', '0');
    expect(served.status === 'ok' && served.body.toString()).toBe('compressed');
  });

  it('is unavailable for a file that is not there, is not a PMTiles file, or holds something else than vector tiles', async () => {
    expect(await pmtiles(path.join(dir, 'missing.pmtiles')).tile('0', '0', '0')).toEqual({
      status: 'unavailable',
    });
    expect(
      await pmtiles(file('junk.pmtiles', Buffer.from('this is not a map'))).tile('0', '0', '0'),
    ).toEqual({ status: 'unavailable' });
    const raster = file(
      'raster.pmtiles',
      makePmtiles([{ z: 0, x: 0, y: 0, data: Buffer.from('png') }], { tileType: 2 }),
    );
    expect(await pmtiles(raster).tile('0', '0', '0')).toEqual({ status: 'unavailable' });
    expect(await pmtiles(raster).tile('99', '0', '0')).toEqual({ status: 'bad' });
  });

  it('is a file that is put there later: the map starts to work when it arrives', async () => {
    const where = path.join(dir, 'later.pmtiles');
    const map = pmtiles(where);
    expect(await map.tile('0', '0', '0')).toEqual({ status: 'unavailable' });
    writeFileSync(where, makePmtiles([{ z: 0, x: 0, y: 0, data: Buffer.from('arrived') }]));
    expect((await map.tile('0', '0', '0')).status).toBe('ok');
  });
});

describe('with the map off', () => {
  it('has no style, tile or glyph, and asks no one', async () => {
    const u = upstream();
    const map = service(
      { source: 'off', upstreamUrl: undefined, upstreamPublic: false, allow: [] },
      u.send,
    );
    expect(map.on).toBe(false);
    expect(map.style('light', 'https://w.example.com')).toBeUndefined();
    expect(await map.tile('0', '0', '0')).toEqual({ status: 'off' });
    expect(await map.glyph('Noto Sans Regular', '0-255.pbf')).toEqual({ status: 'off' });
    expect(mapResponse({ status: 'off' }, 'tile').status).toBe(404);
    expect(u.asked).toEqual([]);
  });
});

describe('what a map route answers', () => {
  it('is a tile for a tile, a gap for an empty one, a 404 for none, and when to try again for an upstream that is out of reach', async () => {
    expect(
      mapResponse(
        { status: 'ok', body: Buffer.from('x'), gzip: false, type: 'application/x-protobuf' },
        'glyph',
      ).status,
    ).toBe(200);
    expect(mapResponse({ status: 'empty' }, 'tile').status).toBe(204);
    expect(mapResponse({ status: 'empty' }, 'glyph').status).toBe(404);
    expect(mapResponse({ status: 'bad' }, 'tile').status).toBe(404);
    const waiting = mapResponse({ status: 'unavailable' }, 'tile');
    expect([waiting.status, waiting.headers.get('retry-after')]).toEqual([503, '5']);
    const ok = mapResponse(
      { status: 'ok', body: Buffer.from('x'), gzip: false, type: 'application/x-protobuf' },
      'tile',
    );
    expect(ok.headers.get('x-content-type-options')).toBe('nosniff');
    expect(ok.headers.get('content-encoding')).toBeNull();
  });

  it('is the bundled glyph, byte for byte', async () => {
    const served = await service().glyph('Noto Sans Regular', '0-255.pbf');
    const same = readFileSync(
      path.join(process.cwd(), 'src/map/assets/fonts/Noto Sans Regular/0-255.pbf'),
    );
    expect(served.status === 'ok' && served.body.equals(same)).toBe(true);
  });
});
