import type { TodayState } from '../today';
import type { TripStatus } from '../trips/status';

/**
 * Trip Mode's screen (DESIGN.md §14.2), apart from how it looks: **what to show** for this person, this trip and this moment, and the words for a countdown and a day. Pure; the rules for what today is are `src/today/`'s.
 *
 * Trip Mode is **for Travelers and Organizers who are going, on a trip that is on.** For anyone else it says why, and for a trip that is not on it says when it starts or that it ended, with a way to the plan.
 */
export type Screen =
  /** A Follower, or an Organizer who is not going: Trip Mode is for the people going. */
  | { readonly kind: 'not-going' }
  /** The trip is not ready (still planning), or has no dates: there is no today. */
  | { readonly kind: 'not-ready' }
  | { readonly kind: 'before'; readonly date: string }
  | { readonly kind: 'after'; readonly date: string }
  /** The trip is on, and today is between two of its stops. */
  | { readonly kind: 'between' }
  | { readonly kind: 'during' };

export function screenOf(input: {
  readonly role: string;
  readonly going: boolean;
  readonly status: TripStatus;
  readonly state: TodayState;
  /** For `before` the first date and for `after` the last (Today's `edge`). */
  readonly edge: string | undefined;
}): Screen {
  const goes = input.role === 'traveler' || (input.role === 'organizer' && input.going);
  if (!goes) return { kind: 'not-going' };
  if (input.status === 'planning' || input.state === 'planning') return { kind: 'not-ready' };
  if (input.state === 'before' && input.edge) return { kind: 'before', date: input.edge };
  if (input.state === 'after' && input.edge) return { kind: 'after', date: input.edge };
  if (input.state === 'between') return { kind: 'between' };
  return input.state === 'during' ? { kind: 'during' } : { kind: 'not-ready' };
}

/** A countdown to a timed item, in whole minutes rounded up (Today's): "now", "in 40 min", "in 2 h", "in 2 h 5 min", "in 3 days". */
export function countdownText(minutes: number): string {
  if (minutes <= 0) return 'now';
  if (minutes < 60) return `in ${minutes} min`;
  if (minutes < 24 * 60) {
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    return `in ${h} h${m ? ` ${m} min` : ''}`;
  }
  const days = Math.round(minutes / (24 * 60));
  return `in ${days} ${days === 1 ? 'day' : 'days'}`;
}

/** Which day of the trip a date is: the first date is day 1, counting the dates the trip has (a date two stops share is one). `undefined` for a date it has not. */
export function tripDayNumber(
  days: readonly { readonly date: string }[],
  date: string | null,
): number | undefined {
  if (date === null) return undefined;
  const dates = [...new Set(days.map((day) => day.date))].sort();
  const at = dates.indexOf(date);
  return at < 0 ? undefined : at + 1;
}

/** The line under the trip's name: "Kyoto · day 2", or "Lisbon → Sintra · day 3" on a travel day. */
export function dayLine(stops: readonly string[], day: number | undefined): string {
  const where = stops.join(' → ');
  return day === undefined ? where : `${where} · day ${day}`;
}
