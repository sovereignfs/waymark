/**
 * What a place is allowed to be (DESIGN.md §7.1): its name, point, address, category, source, source id and time zone, each checked by one function that **the browser and the server both use**
 * (the actions of `src/actions` before a change is queued, and `places.ts` before it is stored). Pure: no database, no clock, nothing of the server, so it can be imported anywhere. A
 * `PlaceError` names the part that is wrong and never what it was given.
 */
export type PlaceSource = 'manual' | 'osm' | 'import';
export const PLACE_SOURCES: readonly PlaceSource[] = ['manual', 'osm', 'import'];

/** The parts of an address (§7.1): the shape a Swarm export has. */
export interface Address {
  readonly street?: string;
  readonly city?: string;
  readonly region?: string;
  readonly country?: string;
  /** Two letters, upper case. */
  readonly countryCode?: string;
  readonly postalCode?: string;
}
export const ADDRESS_PARTS = [
  'street',
  'city',
  'region',
  'country',
  'countryCode',
  'postalCode',
] as const;

/** A value that is not a place: the message says which part, and never what it was given. */
export class PlaceError extends Error {
  override name = 'PlaceError';
}

export const NAME_MAX = 200;
export const CATEGORY_MAX = 60;
export const PART_MAX = 200;
export const PLACE_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** A name as it is kept: trimmed, one to 200 characters, one line. */
export function cleanPlaceName(name: unknown): string {
  const trimmed = typeof name === 'string' ? name.trim() : '';
  if (trimmed === '' || trimmed.length > NAME_MAX || /[\r\n]/.test(trimmed))
    throw new PlaceError(`a place's name is 1 to ${NAME_MAX} characters on one line`);
  return trimmed;
}

/** A point on the globe: finite, latitude within ±90 and longitude within ±180. */
export function cleanPoint(lat: unknown, lng: unknown): { lat: number; lng: number } {
  if (
    typeof lat !== 'number' ||
    typeof lng !== 'number' ||
    !Number.isFinite(lat) ||
    !Number.isFinite(lng) ||
    Math.abs(lat) > 90 ||
    Math.abs(lng) > 180
  )
    throw new PlaceError('a point is a latitude from -90 to 90 and a longitude from -180 to 180');
  return { lat, lng };
}

export function cleanCategory(category: unknown): string | undefined {
  if (category === undefined || category === null) return undefined;
  const trimmed = typeof category === 'string' ? category.trim() : '';
  if (trimmed === '') return undefined;
  if (trimmed.length > CATEGORY_MAX || /[\r\n]/.test(trimmed))
    throw new PlaceError(`a category is at most ${CATEGORY_MAX} characters on one line`);
  return trimmed;
}

export function cleanAddress(address: unknown): Address | undefined {
  if (address === undefined || address === null) return undefined;
  if (typeof address !== 'object' || Array.isArray(address))
    throw new PlaceError('an address is made of parts');
  const out: Record<string, string> = {};
  for (const [part, value] of Object.entries(address)) {
    if (!(ADDRESS_PARTS as readonly string[]).includes(part))
      throw new PlaceError(
        'an address has a street, city, region, country, country code and postal code',
      );
    if (value === undefined || value === null) continue;
    const text = typeof value === 'string' ? value.trim() : '';
    if (text.length > PART_MAX)
      throw new PlaceError(`a part of an address is at most ${PART_MAX} characters`);
    if (typeof value !== 'string') throw new PlaceError('a part of an address is text');
    if (text === '') continue;
    out[part] = part === 'countryCode' ? text.toUpperCase() : text;
  }
  if (out.countryCode !== undefined && !/^[A-Z]{2}$/.test(out.countryCode))
    throw new PlaceError('a country code is two letters');
  return Object.keys(out).length === 0 ? undefined : out;
}

export function cleanSource(source: unknown): PlaceSource {
  if (source === undefined) return 'manual';
  if (!(PLACE_SOURCES as readonly unknown[]).includes(source))
    throw new PlaceError('a place came from manual, osm or import');
  return source as PlaceSource;
}

export function cleanSourceId(sourceId: unknown): string | undefined {
  if (sourceId === undefined || sourceId === null || sourceId === '') return undefined;
  if (typeof sourceId !== 'string' || sourceId.length > 200)
    throw new PlaceError('a source id is at most 200 characters');
  return sourceId;
}

export function cleanZone(tz: unknown): string | undefined {
  if (tz === undefined || tz === null || tz === '') return undefined;
  if (typeof tz !== 'string' || tz.length > 64)
    throw new PlaceError('a time zone is a name such as Europe/Lisbon');
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
  } catch {
    throw new PlaceError('a time zone is a name such as Europe/Lisbon');
  }
  return tz;
}
