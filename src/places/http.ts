import type { Sealer } from '../crypto/sealed';
import type { Database } from '../db/client';
import type { PlaceFinder } from './finder';
import { findSamePlace } from './match';
import type { Candidate } from './providers';
import { type Place, listPlaces } from './places';
import { searchPlaces } from './search';

/**
 * What `/api/places` answers (DESIGN.md §7.2), apart from the request: **the person's own places first, then the provider's.** The account is the session's, so `mine` is only ever its
 * own places, opened in memory and searched there (a name is sealed at rest, §18.1); `found` is the provider's, with what the person already has taken out, since it is listed above.
 * With the provider `off`, or unreachable, `status` says so and `mine` is still answered, so the manual way (a name and a point) is never waiting on a third party.
 *
 *   GET /api/places?q=cafe&lat=48.85&lng=2.33     search; the point only orders the person's own places, and is **not sent to the provider**
 *   GET /api/places?lat=48.85&lng=2.33            reverse lookup: what is at this point, and the person's place that is the same, if they have one
 *
 * Nothing here logs a query, a name or a point.
 */
export interface FindDeps {
  readonly database: Database;
  readonly sealer: Sealer;
  readonly finder: PlaceFinder;
}

export interface Mine {
  readonly id: string;
  readonly name: string;
  readonly lat: number;
  readonly lng: number;
  readonly category: string | undefined;
  readonly address: Place['address'];
  readonly tz: string | null;
  /** Metres from the point given, when one was. */
  readonly distance: number | undefined;
}

export type Answer = { status: number; body: unknown };

const bad: Answer = { status: 400, body: { code: 'BAD_REQUEST' } };
const MINE_LIMIT = 8;

const coordinate = (value: string | null, limit: number): number | undefined => {
  if (value === null || value.trim() === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) && Math.abs(n) <= limit ? n : undefined;
};

const mine = (place: Place, distance: number | undefined): Mine => ({
  id: place.id,
  name: place.name,
  lat: place.lat,
  lng: place.lng,
  category: place.category,
  address: place.address,
  tz: place.tz,
  distance,
});

export async function findPlaces(
  deps: FindDeps,
  accountId: string,
  params: URLSearchParams,
): Promise<Answer> {
  const q = params.get('q');
  const lat = coordinate(params.get('lat'), 90);
  const lng = coordinate(params.get('lng'), 180);
  if ((params.has('lat') && lat === undefined) || (params.has('lng') && lng === undefined))
    return bad;
  if ((lat === undefined) !== (lng === undefined)) return bad;
  const point = lat !== undefined && lng !== undefined ? { lat, lng } : undefined;
  const own = await listPlaces(deps, accountId);
  const provider = deps.finder.on ? 'on' : 'off';

  if (q !== null) {
    if (q.trim() === '') return bad;
    const places = searchPlaces(own, q, { near: point, limit: MINE_LIMIT }).map((found) =>
      mine(found.place, found.distance),
    );
    const result = await deps.finder.search(q);
    const candidates =
      result.status === 'ok'
        ? result.candidates.filter((candidate) => !findSamePlace(candidate, own))
        : [];
    return {
      status: 200,
      body: {
        provider,
        status: result.status,
        mine: places,
        found: candidates satisfies Candidate[],
      },
    };
  }

  if (!point) return bad;
  const result = await deps.finder.reverse(point.lat, point.lng);
  const candidate = result.status === 'ok' ? result.candidate : undefined;
  const existing = candidate ? findSamePlace(candidate, own) : undefined;
  return {
    status: 200,
    body: {
      provider,
      status: result.status,
      found: candidate ?? null,
      existing: existing ? mine(existing, undefined) : null,
    },
  };
}
