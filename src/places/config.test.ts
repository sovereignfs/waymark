import { describe, expect, it } from 'vitest';
import { loadConfig } from '../config';
import { PUBLIC_URLS, resolvePlaces } from './config';

const BASE = {
  WAYMARK_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
  WAYMARK_SQLITE_URL: 'file:/tmp/x.db',
  WAYMARK_DB_DIALECT: 'sqlite',
};
const places = (env: Record<string, string>) => {
  const problems: string[] = [];
  const settings = resolvePlaces((name) => env[name], problems);
  return { settings, problems };
};

describe('the place search settings', () => {
  it('are the public Nominatim when nothing is said, with its policy', () => {
    const { settings, problems } = places({});
    expect(problems).toEqual([]);
    expect(settings).toMatchObject({
      provider: 'nominatim',
      url: PUBLIC_URLS.nominatim,
      public: true,
    });
    expect(settings.allow).toEqual([
      { host: 'nominatim.openstreetmap.org', allowPrivate: false, allowHttp: false },
    ]);
  });

  it('take Photon, whose public instance has the policy too, and `off`, which reaches nothing', () => {
    expect(places({ WAYMARK_PLACES_PROVIDER: 'photon' }).settings).toMatchObject({
      provider: 'photon',
      url: PUBLIC_URLS.photon,
      public: true,
    });
    expect(places({ WAYMARK_PLACES_PROVIDER: ' Photon ' }).settings.provider).toBe('photon');
    const off = places({ WAYMARK_PLACES_PROVIDER: 'off', WAYMARK_PLACES_URL: 'nonsense' });
    expect(off.settings).toEqual({ provider: 'off', url: undefined, public: false, allow: [] });
    expect(off.problems).toEqual([]);
  });

  it('lift the policy for an address of the operator’s own, which may be http on a network of its own', () => {
    const own = places({ WAYMARK_PLACES_URL: 'http://nominatim.internal:8080/' }).settings;
    expect(own).toMatchObject({ url: 'http://nominatim.internal:8080', public: false });
    expect(own.allow).toEqual([
      { host: 'nominatim.internal', allowPrivate: true, allowHttp: true },
    ]);
    expect(places({ WAYMARK_PLACES_URL: 'https://geo.example.com/nominatim' }).settings.url).toBe(
      'https://geo.example.com/nominatim',
    );
  });

  it('refuse what is not a provider or an address, naming the setting and never its value', () => {
    for (const [env, text] of [
      [{ WAYMARK_PLACES_PROVIDER: 'google' }, 'WAYMARK_PLACES_PROVIDER'],
      [{ WAYMARK_PLACES_URL: 'not an address' }, 'WAYMARK_PLACES_URL'],
      [{ WAYMARK_PLACES_URL: 'ftp://x.example.com' }, 'WAYMARK_PLACES_URL'],
      [{ WAYMARK_PLACES_URL: 'https://u:secret@x.example.com' }, 'WAYMARK_PLACES_URL'],
      [{ WAYMARK_PLACES_URL: 'https://x.example.com/?key=secret' }, 'WAYMARK_PLACES_URL'],
      [{ WAYMARK_PLACES_URL: 'http://nominatim.openstreetmap.org' }, 'public place search'],
    ] as const) {
      const { problems } = places(env);
      expect(problems.length, JSON.stringify(env)).toBeGreaterThan(0);
      expect(problems.join(' ')).toContain(text);
      expect(problems.join(' ')).not.toContain('secret');
    }
  });

  it('are in the server’s configuration, and a wrong one stops it', () => {
    const ok = loadConfig({ ...BASE, WAYMARK_PLACES_PROVIDER: 'photon' });
    expect(ok.ok && ok.config.places.provider).toBe('photon');
    const wrong = loadConfig({ ...BASE, WAYMARK_PLACES_PROVIDER: 'nope' });
    expect(wrong.ok).toBe(false);
  });
});
