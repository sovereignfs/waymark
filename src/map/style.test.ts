import { readFileSync } from 'node:fs';
import path from 'node:path';
import { validateStyleMin } from '@maplibre/maplibre-gl-style-spec';
import { describe, expect, it } from 'vitest';
import { PALETTE, THEMES, attribution, styleFor } from './style';

const tokens = path.join(process.cwd(), 'node_modules/@sovereignfs/ui/dist/tokens');
const css = ['primitives.css', 'semantic.css'].map((file) =>
  readFileSync(path.join(tokens, file), 'utf8'),
);

/** The value of a token in a theme, following `var(--sv-…)` to a colour: the dark theme's own block first, then the default one. */
function resolve(token: string, theme: 'light' | 'dark'): string | undefined {
  const blocks =
    theme === 'dark'
      ? [/\[data-theme='dark'\]\s*\{([^}]*)\}/g, /:root\s*\{([^}]*)\}/g]
      : [/:root\s*\{([^}]*)\}/g];
  const text = css.join('\n');
  for (const pattern of blocks) {
    for (const block of text.matchAll(pattern)) {
      const found = new RegExp(`${token}:\\s*([^;]+);`).exec(block[1] ?? '');
      if (!found) continue;
      const value = (found[1] ?? '').trim();
      const reference = /^var\((--[\w-]+)\)$/.exec(value);
      return reference ? resolve(reference[1] ?? '', theme) : value;
    }
  }
  return undefined;
}

const SETTINGS = { source: 'proxy', upstreamPublic: true } as const;

describe('the map style', () => {
  it('is coloured with the design system’s tokens, and each value is what its token is in that theme', () => {
    for (const theme of THEMES)
      for (const [part, colour] of Object.entries(PALETTE[theme]))
        expect(resolve(colour.token, theme), `${theme} ${part} ${colour.token}`).toBe(colour.hex);
  });

  it('is a style MapLibre accepts, in each theme', () => {
    for (const theme of THEMES)
      expect(
        validateStyleMin(styleFor(theme, 'https://waymark.example.com', SETTINGS) as never),
        theme,
      ).toEqual([]);
  });

  it('names Waymark’s own addresses and no one else’s, for tiles and glyphs, and no sprite', () => {
    for (const theme of THEMES) {
      const style = styleFor(theme, 'https://waymark.example.com', SETTINGS);
      expect(style.sources.openmaptiles.tiles).toEqual([
        'https://waymark.example.com/api/map/tiles/{z}/{x}/{y}',
      ]);
      expect(style.glyphs).toBe(
        'https://waymark.example.com/api/map/glyphs/{fontstack}/{range}.pbf',
      );
      expect('sprite' in style).toBe(false);
      // Every address in it, attribution links aside, is Waymark's.
      const withoutAttribution = JSON.stringify({
        ...style,
        sources: { openmaptiles: { ...style.sources.openmaptiles, attribution: '' } },
      });
      const hosts = [...withoutAttribution.matchAll(/https?:\/\/([^/"]+)/g)].map(
        (match) => match[1],
      );
      expect(new Set(hosts)).toEqual(new Set(['waymark.example.com']));
      for (const layer of style.layers)
        if ('layout' in layer && layer.layout && 'text-font' in layer.layout)
          expect(['Noto Sans Regular', 'Noto Sans Bold']).toContain(
            (layer.layout['text-font'] as string[])[0],
          );
    }
  });

  it('is different in the dark: the land, the water and the text change with the theme', () => {
    const light = styleFor('light', 'https://w.example.com', SETTINGS);
    const dark = styleFor('dark', 'https://w.example.com', SETTINGS);
    expect(light.layers[0]).not.toEqual(dark.layers[0]);
    expect(JSON.stringify(light)).not.toBe(JSON.stringify(dark));
    expect(dark.metadata.waymark.theme).toBe('dark');
  });

  it('carries the attribution OpenStreetMap asks for on every map, and the tile service’s name for the public one', () => {
    expect(attribution(SETTINGS)).toContain('OpenStreetMap contributors');
    expect(attribution(SETTINGS)).toContain('OpenMapTiles');
    expect(attribution(SETTINGS)).toContain('OpenFreeMap');
    expect(attribution({ source: 'pmtiles', upstreamPublic: false })).not.toContain('OpenFreeMap');
    expect(attribution({ source: 'proxy', upstreamPublic: false })).toContain(
      'OpenStreetMap contributors',
    );
    expect(
      styleFor('light', 'https://w.example.com', SETTINGS).sources.openmaptiles.attribution,
    ).toContain('openstreetmap.org/copyright');
  });
});
