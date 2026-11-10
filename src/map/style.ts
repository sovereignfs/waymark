import type { MapSettings } from './config';

/**
 * Waymark's own map style (DESIGN.md §8.1): a light and a dark one for the OpenMapTiles schema, chosen by the theme so that the map follows dark mode. **Every colour is a design-system token**
 * (`--sv-*`), written here as its value because a map style cannot read a CSS variable; `style.test.ts` reads the design system's own CSS and fails if a value here is not what its token is, so the
 * map is re-coloured with the system and not on its own. **It points at Waymark's own addresses only** (tiles and glyphs under `/api/map`), and **names no sprite**: it draws with shapes and
 * text alone, so there are no icons to serve. Attribution is part of the source, so every map the style draws shows it.
 */
export type Theme = 'light' | 'dark';
export const THEMES: readonly Theme[] = ['light', 'dark'];

type Colour = { readonly token: string; readonly hex: string };
const c = (token: string, hex: string): Colour => ({ token, hex });

/** What each part of the map is coloured with, in each theme. */
export const PALETTE = {
  light: {
    land: c('--sv-color-surface-sunken', '#fafafa'),
    water: c('--sv-blue-200', '#dbeafe'),
    park: c('--sv-green-100', '#ecfdf3'),
    building: c('--sv-grey-200', '#e4e4e7'),
    road: c('--sv-color-surface', '#ffffff'),
    roadCasing: c('--sv-color-border-strong', '#d4d4d8'),
    path: c('--sv-grey-400', '#a1a1aa'),
    boundary: c('--sv-grey-400', '#a1a1aa'),
    text: c('--sv-color-text-primary', '#09090b'),
    textMuted: c('--sv-color-text-muted', '#71717a'),
    halo: c('--sv-color-surface', '#ffffff'),
  },
  dark: {
    land: c('--sv-color-surface-sunken', '#18181b'),
    water: c('--sv-blue-900', '#1e3a8a'),
    park: c('--sv-green-900', '#14532d'),
    building: c('--sv-grey-800', '#27272a'),
    road: c('--sv-grey-700', '#3f3f46'),
    roadCasing: c('--sv-color-border', '#27272a'),
    path: c('--sv-grey-600', '#52525b'),
    boundary: c('--sv-grey-600', '#52525b'),
    text: c('--sv-color-text-primary', '#fafafa'),
    textMuted: c('--sv-color-text-muted', '#a1a1aa'),
    halo: c('--sv-color-surface', '#09090b'),
  },
} as const satisfies Record<Theme, Record<string, Colour>>;

/** The attribution every map shows: OpenStreetMap's licence asks for it, OpenMapTiles' schema for its own, and the public tile service for its name. */
export function attribution(settings: Pick<MapSettings, 'source' | 'upstreamPublic'>): string {
  const osm =
    '<a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">© OpenStreetMap contributors</a>';
  const omt =
    '<a href="https://openmaptiles.org/" target="_blank" rel="noopener noreferrer">© OpenMapTiles</a>';
  const ofm =
    '<a href="https://openfreemap.org" target="_blank" rel="noopener noreferrer">OpenFreeMap</a>';
  return settings.source === 'proxy' && settings.upstreamPublic
    ? `${ofm} ${omt} ${osm}`
    : `${omt} ${osm}`;
}

const NAME = ['coalesce', ['get', 'name:latin'], ['get', 'name']];
const REGULAR = ['Noto Sans Regular'];
const BOLD = ['Noto Sans Bold'];

/** A line that is wider as the map is closer: the width at a few zooms, and the map fills in between. */
const widths = (...pairs: [number, number][]) => ({
  base: 1.4,
  stops: pairs,
});

/**
 * The style for a theme. `origin` is the address the browser uses for Waymark (`WAYMARK_URL`, or the request's own), so that the tile and glyph addresses are whole ones, which MapLibre
 * needs inside a style.
 */
export function styleFor(
  theme: Theme,
  origin: string,
  settings: Pick<MapSettings, 'source' | 'upstreamPublic'>,
) {
  const p = PALETTE[theme];
  const roads = [
    'all',
    ['in', 'class', 'motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'minor', 'service'],
  ];
  return {
    version: 8 as const,
    name: `Waymark ${theme}`,
    metadata: { waymark: { theme } },
    sources: {
      openmaptiles: {
        type: 'vector' as const,
        tiles: [`${origin}/api/map/tiles/{z}/{x}/{y}`],
        minzoom: 0,
        maxzoom: 14,
        attribution: attribution(settings),
      },
    },
    glyphs: `${origin}/api/map/glyphs/{fontstack}/{range}.pbf`,
    layers: [
      { id: 'background', type: 'background', paint: { 'background-color': p.land.hex } },
      {
        id: 'landcover',
        type: 'fill',
        source: 'openmaptiles',
        'source-layer': 'landcover',
        filter: ['in', 'class', 'wood', 'grass', 'farmland'],
        paint: { 'fill-color': p.park.hex, 'fill-opacity': 0.6 },
      },
      {
        id: 'park',
        type: 'fill',
        source: 'openmaptiles',
        'source-layer': 'park',
        paint: { 'fill-color': p.park.hex },
      },
      {
        id: 'water',
        type: 'fill',
        source: 'openmaptiles',
        'source-layer': 'water',
        paint: { 'fill-color': p.water.hex },
      },
      {
        id: 'waterway',
        type: 'line',
        source: 'openmaptiles',
        'source-layer': 'waterway',
        paint: { 'line-color': p.water.hex, 'line-width': widths([8, 0.5], [14, 2]) },
      },
      {
        id: 'building',
        type: 'fill',
        source: 'openmaptiles',
        'source-layer': 'building',
        minzoom: 13,
        paint: { 'fill-color': p.building.hex },
      },
      {
        id: 'road-casing',
        type: 'line',
        source: 'openmaptiles',
        'source-layer': 'transportation',
        minzoom: 6,
        filter: roads,
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': p.roadCasing.hex,
          'line-width': widths([6, 0.8], [12, 3], [16, 12]),
        },
      },
      {
        id: 'road',
        type: 'line',
        source: 'openmaptiles',
        'source-layer': 'transportation',
        minzoom: 6,
        filter: roads,
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': p.road.hex, 'line-width': widths([6, 0.4], [12, 2], [16, 10]) },
      },
      {
        id: 'path',
        type: 'line',
        source: 'openmaptiles',
        'source-layer': 'transportation',
        minzoom: 13,
        filter: ['in', 'class', 'path', 'pedestrian', 'track'],
        paint: {
          'line-color': p.path.hex,
          'line-width': widths([13, 0.5], [17, 2]),
          'line-dasharray': [2, 2],
        },
      },
      {
        id: 'boundary-country',
        type: 'line',
        source: 'openmaptiles',
        'source-layer': 'boundary',
        filter: ['all', ['==', 'admin_level', 2], ['!=', 'maritime', 1]],
        paint: { 'line-color': p.boundary.hex, 'line-width': widths([2, 0.6], [8, 1.6]) },
      },
      {
        id: 'boundary-state',
        type: 'line',
        source: 'openmaptiles',
        'source-layer': 'boundary',
        minzoom: 4,
        filter: ['all', ['==', 'admin_level', 4], ['!=', 'maritime', 1]],
        paint: { 'line-color': p.boundary.hex, 'line-width': 0.8, 'line-dasharray': [3, 2] },
      },
      {
        id: 'road-name',
        type: 'symbol',
        source: 'openmaptiles',
        'source-layer': 'transportation_name',
        minzoom: 14,
        layout: {
          'symbol-placement': 'line',
          'text-field': NAME,
          'text-font': REGULAR,
          'text-size': 11,
        },
        paint: {
          'text-color': p.textMuted.hex,
          'text-halo-color': p.halo.hex,
          'text-halo-width': 1.5,
        },
      },
      {
        id: 'water-name',
        type: 'symbol',
        source: 'openmaptiles',
        'source-layer': 'water_name',
        layout: { 'text-field': NAME, 'text-font': REGULAR, 'text-size': 12 },
        paint: {
          'text-color': p.textMuted.hex,
          'text-halo-color': p.halo.hex,
          'text-halo-width': 1.5,
        },
      },
      {
        id: 'place-village',
        type: 'symbol',
        source: 'openmaptiles',
        'source-layer': 'place',
        minzoom: 11,
        filter: ['in', 'class', 'village', 'suburb', 'hamlet', 'neighbourhood'],
        layout: { 'text-field': NAME, 'text-font': REGULAR, 'text-size': 11 },
        paint: {
          'text-color': p.textMuted.hex,
          'text-halo-color': p.halo.hex,
          'text-halo-width': 1.5,
        },
      },
      {
        id: 'place-town',
        type: 'symbol',
        source: 'openmaptiles',
        'source-layer': 'place',
        minzoom: 8,
        filter: ['in', 'class', 'town', 'city'],
        layout: {
          'text-field': NAME,
          'text-font': BOLD,
          'text-size': ['interpolate', ['linear'], ['zoom'], 8, 12, 14, 18],
        },
        paint: { 'text-color': p.text.hex, 'text-halo-color': p.halo.hex, 'text-halo-width': 1.5 },
      },
      {
        id: 'place-state',
        type: 'symbol',
        source: 'openmaptiles',
        'source-layer': 'place',
        minzoom: 4,
        maxzoom: 9,
        filter: ['==', 'class', 'state'],
        layout: {
          'text-field': NAME,
          'text-font': REGULAR,
          'text-size': 11,
          'text-transform': 'uppercase',
        },
        paint: {
          'text-color': p.textMuted.hex,
          'text-halo-color': p.halo.hex,
          'text-halo-width': 1.5,
        },
      },
      {
        id: 'place-country',
        type: 'symbol',
        source: 'openmaptiles',
        'source-layer': 'place',
        maxzoom: 8,
        filter: ['==', 'class', 'country'],
        layout: {
          'text-field': NAME,
          'text-font': BOLD,
          'text-size': ['interpolate', ['linear'], ['zoom'], 1, 11, 6, 18],
        },
        paint: { 'text-color': p.text.hex, 'text-halo-color': p.halo.hex, 'text-halo-width': 1.5 },
      },
    ],
  };
}

export type MapStyle = ReturnType<typeof styleFor>;
