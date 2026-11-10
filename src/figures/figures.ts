import { normalizeName } from '../places/match';

/**
 * **Figures** (DESIGN.md §9.5): the counts a person reads about where they have been, **read back from their check-ins and never stored**, so that an imported decade gives exactly the figures a lived one
 * would. Pure and the one implementation, so the device (offline) and the server (a test, an export) give the same numbers for the same rows; it reads no clock (`now` and the viewer's zone are given) and
 * nothing in it depends on the order the rows come in.
 *
 * **A year is the check-in's own**: the year of its local date in the zone it was made in (`at` and the offset then), so a check-in at 23:59 on New Year's Eve is in the old year wherever the reader is.
 * A place is **counted once however many times it was visited** (the places of a person are already one record each, §7.1); a country is its place's country code, a region is a region of a country
 * (a region name alone is not unique), and a city is a city of a country, compared without case, accents or punctuation, so "Zürich" and "Zurich" are one.
 *
 * **There is nothing here that rewards**: no streak, no badge, no points, no rank. A figure says what happened and asks nothing of the person (`AGENTS.md`).
 */
export interface FigureCheckin {
  readonly id: string;
  readonly placeId: string;
  /** The moment, in milliseconds since the epoch. */
  readonly at: number;
  /** The offset from UTC when it was made, in minutes east. */
  readonly offsetMin: number;
  readonly tripId?: string | null | undefined;
}

export interface FigurePlace {
  readonly id: string;
  readonly address?:
    | {
        readonly city?: string | undefined;
        readonly region?: string | undefined;
        readonly countryCode?: string | undefined;
      }
    | undefined;
  readonly countryCode?: string | null | undefined;
}

export interface Counted {
  /** A country code, or `FR/Île-de-France` for a region, or `FR/Paris` for a city: what the count is of. */
  readonly key: string;
  /** What to call it: the code, or the region's or the city's name as the first check-in spelled it. */
  readonly name: string;
  /** The country it is in, or `undefined` for a country itself. */
  readonly country: string | undefined;
  /** How many check-ins are in it. */
  readonly checkins: number;
}

export interface Figures {
  /** Check-ins in total. */
  readonly total: number;
  /** Check-ins in the year of `now`, in the viewer's zone. */
  readonly thisYear: number;
  /** Check-ins in each year they were made in, newest year first. */
  readonly perYear: readonly { readonly year: number; readonly checkins: number }[];
  /** Different places checked in at. */
  readonly places: number;
  readonly countries: readonly Counted[];
  readonly regions: readonly Counted[];
  readonly cities: readonly Counted[];
}

/** The year of a moment on a clock `offsetMin` minutes east of UTC: shifting the moment by the offset makes UTC's reading the local one. */
export function yearOf(at: number, offsetMin: number): number {
  return new Date(at + offsetMin * 60_000).getUTCFullYear();
}

/** The year of `now` in the viewer's own zone: given as the viewer's offset now, which the caller works out (the screen reads its clock, a test names it). */
export function figures(
  checkins: readonly FigureCheckin[],
  places: readonly FigurePlace[],
  options: { now: number; offsetMin: number },
): Figures {
  const placeById = new Map(places.map((place) => [place.id, place]));
  const years = new Map<number, number>();
  const visited = new Set<string>();
  const countries = new Map<string, Counted>();
  const regions = new Map<string, Counted>();
  const cities = new Map<string, Counted>();
  const thisYear = yearOf(options.now, options.offsetMin);
  let inThisYear = 0;

  // The order the rows arrive in must not matter, not even for the name a place is called by: the first check-in in time order (then by id) spells it.
  const ordered = [...checkins].sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
  for (const checkin of ordered) {
    const year = yearOf(checkin.at, checkin.offsetMin);
    years.set(year, (years.get(year) ?? 0) + 1);
    if (year === thisYear) inThisYear++;
    visited.add(checkin.placeId);
    const place = placeById.get(checkin.placeId);
    if (!place) continue;
    const code = (place.countryCode ?? place.address?.countryCode ?? '').toUpperCase();
    if (code === '') continue;
    const bump = (
      map: Map<string, Counted>,
      key: string,
      name: string,
      country: string | undefined,
    ) => {
      const had = map.get(key);
      map.set(
        key,
        had ? { ...had, checkins: had.checkins + 1 } : { key, name, country, checkins: 1 },
      );
    };
    bump(countries, code, code, undefined);
    const region = place.address?.region?.trim();
    if (region) bump(regions, `${code}/${normalizeName(region)}`, region, code);
    const city = place.address?.city?.trim();
    if (city && normalizeName(city) !== '')
      bump(cities, `${code}/${normalizeName(city)}`, city, code);
  }

  const byCount = (a: Counted, b: Counted) => b.checkins - a.checkins || a.key.localeCompare(b.key);
  return {
    total: checkins.length,
    thisYear: inThisYear,
    perYear: [...years]
      .map(([year, count]) => ({ year, checkins: count }))
      .sort((a, b) => b.year - a.year),
    places: visited.size,
    countries: [...countries.values()].sort(byCount),
    regions: [...regions.values()].sort(byCount),
    cities: [...cities.values()].sort(byCount),
  };
}

export interface PlaceFigures {
  /** How many times the person has been there. */
  readonly times: number;
  /** The first and the last moment, or `undefined` for a place with no check-in. */
  readonly first: number | undefined;
  readonly last: number | undefined;
  /** The trips those check-ins were part of, each once, in the order of the first check-in of each (§20.8). The trip's own name is read from the trip (9.1). */
  readonly trips: readonly string[];
}

/** What is read about one place: how many times, the first and the last, and the trips (§9.5). */
export function placeFigures(placeId: string, checkins: readonly FigureCheckin[]): PlaceFigures {
  const here = checkins
    .filter((checkin) => checkin.placeId === placeId)
    .sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
  const trips: string[] = [];
  for (const checkin of here)
    if (checkin.tripId && !trips.includes(checkin.tripId)) trips.push(checkin.tripId);
  return { times: here.length, first: here[0]?.at, last: here.at(-1)?.at, trips };
}
