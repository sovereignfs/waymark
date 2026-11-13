import type { CheckinView, PlaceView } from '../actions/types';
import { distanceMetres } from '../places/match';
import type { TripCard } from './trips';

/**
 * Home (DESIGN.md §20.4), apart from how it looks: **where the person is, then what is next.** Pure, from what the device holds, so Home paints from the store with nothing to wait for and the same on every device.
 */

/** The trip that is on, if one is: Trip Mode's card is for it. With more than one, the one that began first. */
export function ongoingTrip(cards: readonly TripCard[]): TripCard | undefined {
  return [...cards]
    .filter((card) => card.status === 'ongoing')
    .sort(
      (a, b) => (a.startDate ?? '').localeCompare(b.startDate ?? '') || a.id.localeCompare(b.id),
    )[0];
}

/** The next trip: the soonest of those that are ready and have not begun. */
export function nextTrip(cards: readonly TripCard[]): TripCard | undefined {
  return [...cards]
    .filter((card) => card.status === 'upcoming' && card.startDate !== null)
    .sort(
      (a, b) => (a.startDate ?? '').localeCompare(b.startDate ?? '') || a.id.localeCompare(b.id),
    )[0];
}

const dayNumber = (date: string): number =>
  Math.floor(Date.parse(`${date}T00:00:00Z`) / 86_400_000);

/** How long until a date, from today's date: "today", "tomorrow", "in 23 days". */
export function untilText(startDate: string, today: string): string {
  const days = dayNumber(startDate) - dayNumber(today);
  if (days <= 0) return 'today';
  if (days === 1) return 'tomorrow';
  return `in ${days} days`;
}

/** The last `limit` check-ins, newest first (the store's order, which is by moment and then id). */
export function recently(checkins: readonly CheckinView[], limit = 10): CheckinView[] {
  return [...checkins].sort((a, b) => b.at - a.at || a.id.localeCompare(b.id)).slice(0, limit);
}

/** The person's own place nearest the position, if one is within `within` metres: what _Check in_ offers on Home. */
export function nearestPlace(
  places: readonly PlaceView[],
  position: { readonly lat: number; readonly lng: number } | undefined,
  within = 1500,
): { place: PlaceView; metres: number } | undefined {
  if (!position) return undefined;
  let best: { place: PlaceView; metres: number } | undefined;
  for (const place of places) {
    const metres = distanceMetres(position, place);
    if (metres <= within && (!best || metres < best.metres)) best = { place, metres };
  }
  return best;
}

/** A new person has nothing yet: no check-in and no trip. Home then shows the two empty states and nothing else. */
export const isNewPerson = (checkins: readonly unknown[], cards: readonly unknown[]): boolean =>
  checkins.length === 0 && cards.length === 0;
