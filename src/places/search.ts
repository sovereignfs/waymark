import { type Point, distanceMetres, normalizeName } from './match';

/**
 * A person's places, found by name and by distance (DESIGN.md §7.2, step 1): **in memory, after unsealing**, since a name is sealed at rest and never a column to search by (§18.1). Pure:
 * the caller passes the places it may see.
 */
export interface Searchable extends Point {
  readonly name: string;
  readonly category?: string | undefined;
  readonly address?:
    | {
        readonly street?: string | undefined;
        readonly city?: string | undefined;
        readonly region?: string | undefined;
        readonly country?: string | undefined;
      }
    | undefined;
}

export interface Found<T> {
  readonly place: T;
  /** Metres from `near`, when a point was given. */
  readonly distance: number | undefined;
}

/** The words of an address a person might search by: the parts that name somewhere, never the street number alone. */
function addressText(address: Searchable['address']): string {
  if (!address) return '';
  return [address.street, address.city, address.region, address.country].join(' ');
}

/**
 * The places whose name, category or address holds every word of `query` (in any order, ignoring case and accents), nearest first when `near` is known, otherwise by name. An empty
 * query matches every place. At most `limit` are returned.
 */
export function searchPlaces<T extends Searchable>(
  places: readonly T[],
  query: string,
  options: { near?: Point | undefined; limit?: number } = {},
): Found<T>[] {
  const words = normalizeName(query).split(' ').filter(Boolean);
  const found: Found<T>[] = [];
  for (const place of places) {
    const text = ` ${normalizeName(`${place.name} ${place.category ?? ''} ${addressText(place.address)}`)} `;
    if (!words.every((word) => text.includes(word))) continue;
    found.push({
      place,
      distance: options.near ? distanceMetres(options.near, place) : undefined,
    });
  }
  found.sort((a, b) => {
    if (a.distance !== undefined && b.distance !== undefined && a.distance !== b.distance)
      return a.distance - b.distance;
    return normalizeName(a.place.name).localeCompare(normalizeName(b.place.name));
  });
  return found.slice(0, options.limit ?? 20);
}
