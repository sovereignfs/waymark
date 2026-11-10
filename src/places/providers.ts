import type { Address } from './places';

/**
 * The operator's place search, as Waymark reads it (DESIGN.md §7.2): Nominatim and Photon answer in their own shapes, and each adapter turns an answer into the one shape the rest of the
 * app knows, a **candidate**: a name, a point, the address in parts, a category, and the source and its id. Pure: a request is described and an answer is read here, and the
 * finder (`finder.ts`) is what sends it. Nothing here keeps a value or reads a clock.
 */
export interface Candidate {
  readonly name: string;
  readonly lat: number;
  readonly lng: number;
  readonly address: Address | undefined;
  readonly category: string | undefined;
  readonly source: 'osm';
  /** `node/123`, `way/456` or `relation/789`: OpenStreetMap's own, the same from either provider so that a place found twice is the same place. */
  readonly sourceId: string;
}

/** The most results asked for and kept. */
export const MAX_CANDIDATES = 8;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown, max = 200): string | undefined =>
  typeof value === 'string' && value.trim() !== '' ? value.trim().slice(0, max) : undefined;
const num = (value: unknown): number | undefined => {
  const n = typeof value === 'string' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined;
};

const OSM_TYPES: Record<string, string> = {
  node: 'node',
  way: 'way',
  relation: 'relation',
  n: 'node',
  w: 'way',
  r: 'relation',
};

function sourceIdOf(type: unknown, id: unknown): string | undefined {
  const kind = typeof type === 'string' ? OSM_TYPES[type.toLowerCase()] : undefined;
  const n = num(id);
  return kind && n !== undefined && Number.isInteger(n) && n > 0 ? `${kind}/${n}` : undefined;
}

/** "cafe" and "guest_house" as a person would write them: "Cafe", "Guest house". */
export function categoryWords(value: unknown): string | undefined {
  const raw = text(value, 60);
  if (!raw || raw === 'yes' || raw === 'road') return undefined;
  const words = raw.replace(/[_:]+/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function addressOf(parts: {
  street?: string | undefined;
  houseNumber?: string | undefined;
  city?: string | undefined;
  region?: string | undefined;
  country?: string | undefined;
  countryCode?: string | undefined;
  postalCode?: string | undefined;
}): Address | undefined {
  const street = [parts.street, parts.houseNumber].filter(Boolean).join(' ') || undefined;
  const countryCode = parts.countryCode?.toUpperCase();
  const out: Record<string, string> = {};
  if (street) out.street = street;
  if (parts.city) out.city = parts.city;
  if (parts.region) out.region = parts.region;
  if (parts.country) out.country = parts.country;
  if (countryCode && /^[A-Z]{2}$/.test(countryCode)) out.countryCode = countryCode;
  if (parts.postalCode) out.postalCode = parts.postalCode;
  return Object.keys(out).length > 0 ? out : undefined;
}

function nominatimCandidate(item: unknown): Candidate | undefined {
  if (!isObject(item)) return undefined;
  const lat = num(item.lat);
  const lng = num(item.lon);
  const sourceId = sourceIdOf(item.osm_type, item.osm_id);
  if (lat === undefined || lng === undefined || Math.abs(lat) > 90 || Math.abs(lng) > 180)
    return undefined;
  if (!sourceId) return undefined;
  const address = isObject(item.address) ? item.address : {};
  const street = text(address.road) ?? text(address.pedestrian) ?? text(address.footway);
  const houseNumber = text(address.house_number, 20);
  // A place with a name of its own is called that; an address, or a road, is called by what it is: "12 Rua Augusta".
  const name =
    text(item.name) ??
    ([street, houseNumber].filter(Boolean).join(' ') ||
      text(item.display_name)?.split(',')[0]?.trim());
  if (!name) return undefined;
  return {
    name,
    lat,
    lng,
    address: addressOf({
      street,
      houseNumber,
      city:
        text(address.city) ??
        text(address.town) ??
        text(address.village) ??
        text(address.municipality) ??
        text(address.hamlet),
      region: text(address.state) ?? text(address.region) ?? text(address.county),
      country: text(address.country),
      countryCode: text(address.country_code, 2),
      postalCode: text(address.postcode, 20),
    }),
    category: categoryWords(item.type) ?? categoryWords(item.category),
    source: 'osm',
    sourceId,
  };
}

function photonCandidate(feature: unknown): Candidate | undefined {
  if (!isObject(feature) || !isObject(feature.geometry) || !isObject(feature.properties))
    return undefined;
  const coordinates = feature.geometry.coordinates;
  if (!Array.isArray(coordinates)) return undefined;
  const lng = num(coordinates[0]);
  const lat = num(coordinates[1]);
  const p = feature.properties;
  const sourceId = sourceIdOf(p.osm_type, p.osm_id);
  if (lat === undefined || lng === undefined || Math.abs(lat) > 90 || Math.abs(lng) > 180)
    return undefined;
  if (!sourceId) return undefined;
  const street = text(p.street);
  const houseNumber = text(p.housenumber, 20);
  const name = text(p.name) ?? ([street, houseNumber].filter(Boolean).join(' ') || undefined);
  if (!name) return undefined;
  return {
    name,
    lat,
    lng,
    address: addressOf({
      street,
      houseNumber,
      city: text(p.city) ?? text(p.town) ?? text(p.village) ?? text(p.district),
      region: text(p.state) ?? text(p.county),
      country: text(p.country),
      countryCode: text(p.countrycode, 2),
      postalCode: text(p.postcode, 20),
    }),
    category: categoryWords(p.osm_value) ?? categoryWords(p.osm_key),
    source: 'osm',
    sourceId,
  };
}

export type Provider = 'nominatim' | 'photon';

function parse(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

function first<T>(items: T[]): T[] {
  return items.slice(0, MAX_CANDIDATES);
}

/** The candidates in a provider's answer to a search; none for an answer that is not one (the finder says "unavailable" for that, before it gets here). */
export function readSearch(provider: Provider, body: string): Candidate[] {
  const json = parse(body);
  if (provider === 'nominatim')
    return Array.isArray(json)
      ? first(json.map(nominatimCandidate).filter((c): c is Candidate => c !== undefined))
      : [];
  return isObject(json) && Array.isArray(json.features)
    ? first(json.features.map(photonCandidate).filter((c): c is Candidate => c !== undefined))
    : [];
}

/** The candidate at a point, from a provider's answer to a reverse lookup, if it knew of anything there. */
export function readReverse(provider: Provider, body: string): Candidate | undefined {
  const json = parse(body);
  if (provider === 'nominatim') return isObject(json) ? nominatimCandidate(json) : undefined;
  return isObject(json) && Array.isArray(json.features)
    ? json.features.map(photonCandidate).find((c): c is Candidate => c !== undefined)
    : undefined;
}

/** Whether an answer is the shape of one at all, so that a page of HTML from a proxy is "unavailable" and not "nothing found". */
export function isAnswer(provider: Provider, body: string): boolean {
  const json = parse(body);
  if (provider === 'nominatim') return Array.isArray(json) || isObject(json);
  return isObject(json) && Array.isArray(json.features);
}

/** The address to ask for a search: `base` is the provider's address with no trailing slash. */
export function searchUrl(provider: Provider, base: string, query: string): string {
  const q = encodeURIComponent(query);
  return provider === 'nominatim'
    ? `${base}/search?q=${q}&format=jsonv2&addressdetails=1&limit=${MAX_CANDIDATES}`
    : `${base}/api/?q=${q}&limit=${MAX_CANDIDATES}`;
}

/** The address to ask for what is at a point. */
export function reverseUrl(provider: Provider, base: string, lat: number, lng: number): string {
  return provider === 'nominatim'
    ? `${base}/reverse?lat=${lat}&lon=${lng}&format=jsonv2&addressdetails=1&zoom=18`
    : `${base}/reverse?lat=${lat}&lon=${lng}&limit=1`;
}
