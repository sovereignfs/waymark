/**
 * **"The same place"** (DESIGN.md §7.1): the one rule, pure, shared by the device, the server and the tests. A place is the same as another when they came from the same source with
 * the same id, or when they carry the same name within 50 metres. Copying a trip's place into a person's (13.2), the journal's count of visits (11.5), planned versus actual (13) and the
 * import (8.2) all ask this and nothing else, so "I finally went there, twice" is one record, found the same way everywhere.
 *
 * It reads opened places (names and points are sealed at rest, §18.1) and never touches the database.
 */
export interface Point {
  readonly lat: number;
  readonly lng: number;
}

/** What the rule reads of a place. A stored place has all of it; a candidate from place search has the same shape. */
export interface Matchable extends Point {
  readonly name: string;
  readonly source?: string | null | undefined;
  readonly sourceId?: string | null | undefined;
}

/** How near two places with one name must be to be one place, in metres. */
export const SAME_PLACE_METRES = 50;

const EARTH_RADIUS_M = 6_371_008.8;
const rad = (degrees: number) => (degrees * Math.PI) / 180;

/** The distance between two points along the surface of the globe, in metres (the haversine formula: exact to a fraction of a percent, which is far inside the 50 m the rule needs). */
export function distanceMetres(a: Point, b: Point): number {
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * A name as it is compared: without accents, in lower case, with every run of anything that is not a letter or digit as one space. "Café de l'Ouest", "CAFE DE L OUEST" and "cafe de l’ouest"
 * are one name; "Cafe Nord" and "Cafe Sud" are not.
 */
export function normalizeName(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** Whether two places are the same place. */
export function isSamePlace(a: Matchable, b: Matchable): boolean {
  if (
    a.sourceId &&
    b.sourceId &&
    a.sourceId === b.sourceId &&
    (a.source ?? '') === (b.source ?? '')
  )
    return true;
  const name = normalizeName(a.name);
  return name !== '' && name === normalizeName(b.name) && distanceMetres(a, b) <= SAME_PLACE_METRES;
}

/**
 * The place among `places` that is the same as `candidate`, if there is one: one with the same source and id first, and otherwise the nearest of those with the same name within 50 metres.
 * `places` are those the caller may see (a person's own), so the answer is only ever one of them.
 */
export function findSamePlace<T extends Matchable>(
  candidate: Matchable,
  places: readonly T[],
): T | undefined {
  if (candidate.sourceId) {
    const bySource = places.find(
      (each) =>
        each.sourceId === candidate.sourceId && (each.source ?? '') === (candidate.source ?? ''),
    );
    if (bySource) return bySource;
  }
  const name = normalizeName(candidate.name);
  if (name === '') return undefined;
  let best: T | undefined;
  let bestDistance = Infinity;
  for (const each of places) {
    if (normalizeName(each.name) !== name) continue;
    const distance = distanceMetres(candidate, each);
    if (distance <= SAME_PLACE_METRES && distance < bestDistance) {
      best = each;
      bestDistance = distance;
    }
  }
  return best;
}
