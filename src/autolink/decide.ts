import { dayNumber } from '../trips/dates';
import { distanceMetres } from '../places/match';
import { localDate } from '../places/tz';

/**
 * **Auto-link** (DESIGN.md §12): which trip, if any, a check-in falls into. **Pure, and the one implementation**: the device runs it when a check-in is made or changed (so it works offline, with trips on the device, 6.6), the server runs
 * it again when it applies the check-in and in the job that re-decides when a trip's stops change dates, and a test holds them to the same answer. Nothing here reads a database or a clock, and **it does not depend on the order it is
 * given the trips in**: a tie is broken by the trip's own facts and in the end by its id, so every device and the server choose alike.
 *
 * The rule, at the owner's request:
 *
 *  1. **Candidates:** the trips the person is a Traveler of (or a going Organizer) whose dates contain the check-in's **local** date, which is its moment in **its own zone** and not the UTC instant: 23:30 in Auckland on the 10th is the
 *     10th, whatever UTC says. A trip still being planned counts if it has dates.
 *  2. **The nearest stop wins:** among them, the trip whose stop **on that date** is nearest to the check-in's place; a travel day belongs to both stops, so both are looked at.
 *  3. **Then the shorter trip:** where distance does not decide (a point is missing, or the nearest stops are within a kilometre of each other), the trip with fewer days; then the one made first; then the lesser id.
 *  4. **No candidate, no link.**
 *
 * **A link set or removed by hand is `manual`, and nothing automatic ever changes it again** (`reconcile`).
 */
export interface Point {
  readonly lat: number;
  readonly lng: number;
}

/** A trip as auto-link needs it. `goes` is whether the person is a Traveler or a going Organizer of it. */
export interface Candidate {
  readonly id: string;
  /** When the trip was made, to decide between trips that are alike. */
  readonly createdAt: number;
  readonly goes: boolean;
  /** The trip's dates (the first stop's arrival, the last stop's departure): none, and it is no candidate. */
  readonly startDate: string | null;
  readonly endDate: string | null;
  /** Its stops with dates, each with its place's point where it has one. */
  readonly stops: readonly {
    readonly arrive: string;
    readonly depart: string;
    readonly point?: Point | undefined;
  }[];
}

export interface Facts {
  /** The moment, milliseconds since the epoch. */
  readonly at: number;
  /** The zone the check-in was made in. */
  readonly tz: string;
  /** Its place's point. */
  readonly point?: Point | undefined;
}

/** Two stops this near each other (in metres) do not decide between their trips by distance. */
export const NEAR_METRES = 1000;

/** The days of a trip, from its dates, counted on the calendar: a one-day trip is one. */
export function daysOf(trip: Pick<Candidate, 'startDate' | 'endDate'>): number {
  const from = dayNumber(trip.startDate);
  const to = dayNumber(trip.endDate);
  return from === undefined || to === undefined ? Number.MAX_SAFE_INTEGER : to - from + 1;
}

/** How far the trip's nearest stop **on `date`** is from the point, in metres: `undefined` when there is no point to measure from or to (then distance cannot decide). */
function distanceOf(
  trip: Candidate,
  date: string,
  point: Point | undefined,
): number | undefined | 'none' {
  const stops = trip.stops.filter((stop) => stop.arrive <= date && date <= stop.depart);
  // The trip's dates contain the date but no stop is on it: the trip is a candidate (its dates do contain the day) with nothing to measure.
  if (stops.length === 0) return 'none';
  if (point === undefined) return undefined;
  let nearest: number | undefined;
  for (const stop of stops) {
    if (stop.point === undefined) continue;
    const metres = distanceMetres(point, stop.point);
    if (nearest === undefined || metres < nearest) nearest = metres;
  }
  return nearest;
}

/** The trip a check-in falls into, or `undefined` for none. */
export function decide(facts: Facts, trips: readonly Candidate[]): string | undefined {
  let date: string;
  try {
    date = localDate(facts.at, facts.tz);
  } catch {
    // A zone nobody knows: there is no local date to match, and nothing is guessed.
    return undefined;
  }
  const candidates = trips
    .filter(
      (trip) =>
        trip.goes &&
        trip.startDate !== null &&
        trip.endDate !== null &&
        trip.startDate <= date &&
        date <= trip.endDate,
    )
    .map((trip) => ({ trip, metres: distanceOf(trip, date, facts.point) }));
  if (candidates.length === 0) return undefined;
  // Those whose nearest stop on the day is within a kilometre of the nearest of all are alike by distance; where nothing can be measured, all are.
  const measured = candidates.flatMap((c) => (typeof c.metres === 'number' ? [c.metres] : []));
  const best = measured.length > 0 ? Math.min(...measured) : undefined;
  const alike =
    best === undefined
      ? candidates
      : candidates.filter((c) => typeof c.metres !== 'number' || c.metres <= best + NEAR_METRES);
  // A candidate that could not be measured when others could is not pushed out by that: it stays among the alike, and the rest of the rule decides.
  alike.sort(
    (a, b) =>
      daysOf(a.trip) - daysOf(b.trip) ||
      a.trip.createdAt - b.trip.createdAt ||
      (a.trip.id < b.trip.id ? -1 : a.trip.id > b.trip.id ? 1 : 0),
  );
  return alike[0]?.trip.id;
}

export type LinkSource = 'auto' | 'manual' | null;

export interface Link {
  readonly tripId: string | null;
  readonly linkSource: LinkSource;
}

/**
 * What a check-in's link should be once auto-link has decided (`decided`, the trip or none): **a manual link is never changed** (a trip chosen by hand, or no trip chosen by hand: both stay), and otherwise the link is the
 * decision, `auto` with the trip or none at all. Returns `undefined` when nothing changes, so that nothing is written for a decision that is the same.
 */
export function reconcile(current: Link, decided: string | undefined): Link | undefined {
  if (current.linkSource === 'manual') return undefined;
  const next: Link =
    decided === undefined
      ? { tripId: null, linkSource: null }
      : { tripId: decided, linkSource: 'auto' };
  return next.tripId === current.tripId && next.linkSource === current.linkSource
    ? undefined
    : next;
}
