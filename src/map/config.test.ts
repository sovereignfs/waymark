import { describe, expect, it } from 'vitest';
import { loadConfig } from '../config';
import { DEFAULT_UPSTREAM_URL, resolveMap } from './config';

const BASE = {
  WAYMARK_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
  WAYMARK_SQLITE_URL: 'file:/tmp/x.db',
  WAYMARK_DB_DIALECT: 'sqlite',
};
const map = (env: Record<string, string>, dataDir = '/data') => {
  const problems: string[] = [];
  return { settings: resolveMap((name) => env[name], dataDir, problems), problems };
};

describe('the map settings', () => {
  it('are the proxy to OpenFreeMap’s planet when nothing is said, with a cache under the data directory', () => {
    const { settings, problems } = map({});
    expect(problems).toEqual([]);
    expect(settings).toMatchObject({
      source: 'proxy',
      upstreamUrl: DEFAULT_UPSTREAM_URL,
      upstreamPublic: true,
      dir: '/data/map',
      cacheMaxBytes: 2048 * 1024 * 1024,
    });
    expect(settings.allow).toEqual([
      { host: 'tiles.openfreemap.org', allowPrivate: false, allowHttp: false },
    ]);
    expect(map({}, '/srv/waymark').settings.dir).toBe('/srv/waymark/map');
  });

  it('take an upstream of the operator’s own, TileJSON or a tile address, which may be http on a network of its own', () => {
    const own = map({ WAYMARK_MAP_UPSTREAM_URL: 'http://tiles.internal:8080/planet/' }).settings;
    expect(own).toMatchObject({
      upstreamUrl: 'http://tiles.internal:8080/planet',
      upstreamPublic: false,
    });
    expect(own.allow).toEqual([{ host: 'tiles.internal', allowPrivate: true, allowHttp: true }]);
    const template = map({ WAYMARK_MAP_UPSTREAM_URL: 'https://t.example.com/{z}/{x}/{y}.pbf' });
    expect(template.problems).toEqual([]);
    expect(template.settings.upstreamUrl).toBe('https://t.example.com/{z}/{x}/{y}.pbf');
  });

  it('take pmtiles with the file to read, and reach nothing', () => {
    const { settings, problems } = map({
      WAYMARK_MAP_SOURCE: 'pmtiles',
      WAYMARK_MAP_PMTILES_PATH: '/data/map/portugal.pmtiles',
      WAYMARK_MAP_UPSTREAM_URL: 'https://ignored.example.com',
    });
    expect(problems).toEqual([]);
    expect(settings).toMatchObject({
      source: 'pmtiles',
      pmtilesPath: '/data/map/portugal.pmtiles',
      upstreamUrl: undefined,
      allow: [],
    });
  });

  it('take off, which has no map and reaches nothing', () => {
    expect(map({ WAYMARK_MAP_SOURCE: 'off' }).settings).toMatchObject({
      source: 'off',
      upstreamUrl: undefined,
      allow: [],
    });
    expect(map({ WAYMARK_MAP_SOURCE: ' OFF ' }).settings.source).toBe('off');
  });

  it('refuse what is not a source, an address, a path or a size, naming the setting and never its value', () => {
    for (const [env, text] of [
      [{ WAYMARK_MAP_SOURCE: 'google' }, 'WAYMARK_MAP_SOURCE'],
      [{ WAYMARK_MAP_SOURCE: 'pmtiles' }, 'WAYMARK_MAP_PMTILES_PATH'],
      [
        { WAYMARK_MAP_SOURCE: 'pmtiles', WAYMARK_MAP_PMTILES_PATH: 'relative/x.pmtiles' },
        'WAYMARK_MAP_PMTILES_PATH',
      ],
      [{ WAYMARK_MAP_UPSTREAM_URL: 'not an address' }, 'WAYMARK_MAP_UPSTREAM_URL'],
      [{ WAYMARK_MAP_UPSTREAM_URL: 'ftp://t.example.com' }, 'WAYMARK_MAP_UPSTREAM_URL'],
      [{ WAYMARK_MAP_UPSTREAM_URL: 'https://u:secret@t.example.com' }, 'WAYMARK_MAP_UPSTREAM_URL'],
      [
        { WAYMARK_MAP_UPSTREAM_URL: 'https://t.example.com/?key=secret' },
        'WAYMARK_MAP_UPSTREAM_URL',
      ],
      [{ WAYMARK_MAP_UPSTREAM_URL: 'http://tiles.openfreemap.org/planet' }, 'public tile service'],
      [{ WAYMARK_MAP_CACHE_MAX_MB: '0' }, 'WAYMARK_MAP_CACHE_MAX_MB'],
      [{ WAYMARK_MAP_CACHE_MAX_MB: 'lots' }, 'WAYMARK_MAP_CACHE_MAX_MB'],
    ] as const) {
      const { problems } = map(env);
      expect(problems.length, JSON.stringify(env)).toBeGreaterThan(0);
      expect(problems.join(' ')).toContain(text);
      expect(problems.join(' ')).not.toContain('secret');
    }
  });

  it('are in the server’s configuration, and a wrong one stops it', () => {
    const ok = loadConfig({ ...BASE, WAYMARK_MAP_SOURCE: 'off', WAYMARK_MAP_CACHE_MAX_MB: '10' });
    expect(ok.ok && ok.config.map).toMatchObject({
      source: 'off',
      cacheMaxBytes: 10 * 1024 * 1024,
    });
    expect(loadConfig({ ...BASE, WAYMARK_MAP_SOURCE: 'nope' }).ok).toBe(false);
    const dir = loadConfig({ ...BASE, WAYMARK_DATA_DIR: '/srv/w' });
    expect(dir.ok && dir.config.map.dir).toBe('/srv/w/map');
  });
});
