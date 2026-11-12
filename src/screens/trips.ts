import { normalizeName } from '../places/match';
import type { TripEntry } from '../local/db';
import { dayNumber, orderStops } from '../trips/dates';
import type { TripColor } from '../trips/format';
import { type TripStatus, statusOf } from '../trips/status';

/**
 * The trips list and the sidebar's Trips section (DESIGN.md §20.2, §20.9), apart from how they look: **drawn from what the device holds** (`LocalStore.trips`), so a trip already seen shows with no network. A trip's status is
 * worked out here, from the device's clock, by the same pure function the server uses (`trips/status.ts`) and **in the first stop's zone**, so a trip that begins in Auckland begins on Auckland's midnight; the status the server last
 * said could be a day old on a device that has not synced. Pure and the same in a test.
 *
 * Groups, in the order of §20.9: **ongoing** first, then **upcoming** by date, **planning**, and **completed** newest first. Each card has one action by status: Continue planning, View plan, Open Trip Mode, Open journal.
 */
export interface TripCard {
  readonly id: string;
  readonly name: string;
  readonly color: TripColor;
  readonly role: string;
  readonly going: boolean;
  readonly status: TripStatus;
  readonly datesPassed: boolean;
  readonly startDate: string | null;
  readonly endDate: string | null;
  /** How many days from the first to the last, inclusive; none while the trip has no dates. */
  readonly days: number | null;
  /** The stops' places in order: "Tokyo → Kyoto → Osaka". */
  readonly stops: readonly string[];
  /** The members, for their initials. */
  readonly people: readonly { readonly name: string }[];
  readonly action: { readonly label: string; readonly href: string };
  /** When it was last changed, for ordering what has no dates. */
  readonly updatedAt: number;
}

export const STATUSES: readonly TripStatus[] = ['ongoing', 'upcoming', 'planning', 'completed'];
export type Chip = 'all' | TripStatus;
export const CHIPS: readonly Chip[] = ['all', 'planning', 'upcoming', 'ongoing', 'completed'];
export const isChip = (value: unknown): value is Chip =>
  typeof value === 'string' && (CHIPS as readonly string[]).includes(value);

/** The text on a chip and over a group. */
export const STATUS_LABEL: Readonly<Record<Chip, string>> = {
  all: 'All',
  planning: 'Planning',
  upcoming: 'Upcoming',
  ongoing: 'Ongoing',
  completed: 'Completed',
};

/** The address a trip is opened at: its plan, its journal or Trip Mode (`/t/<id>/today`, 13.2). */
export const tripHref = (id: string, view?: 'plan' | 'journal' | 'overview'): string =>
  view ? `/t/${id}?view=${view}` : `/t/${id}`;

/** What the single action on a card is, by status and by what the reader may do: Followers read the plan and have no Trip Mode, and a member who is not going has none either. */
export function actionFor(
  id: string,
  status: TripStatus,
  role: string,
  going: boolean,
): { label: string; href: string } {
  const edits = role === 'organizer' || role === 'traveler';
  if (status === 'completed') return { label: 'Open journal', href: tripHref(id, 'journal') };
  if (status === 'ongoing' && edits && going)
    return { label: 'Open Trip Mode', href: `/t/${id}/today` };
  if (status === 'planning' && edits)
    return { label: 'Continue planning', href: tripHref(id, 'plan') };
  return { label: 'View plan', href: tripHref(id, 'plan') };
}

/** The card for a trip the device holds, or `undefined` for one it has not been given the rows of yet. */
export function cardOf(entry: TripEntry, now: number): TripCard | undefined {
  const sets = entry.sets;
  if (!sets) return undefined;
  const { trip } = sets;
  const ordered = orderStops(
    sets.stops.map((stop) => ({
      id: stop.id,
      arrive: stop.arrive,
      depart: stop.depart,
      position: stop.position,
      name: stop.place.name,
      tz: stop.place.tz,
    })),
  );
  const decided = statusOf(
    { readyAt: trip.readyAt, startDate: trip.startDate, endDate: trip.endDate },
    now,
    ordered[0]?.tz,
  );
  const start = dayNumber(trip.startDate);
  const end = dayNumber(trip.endDate);
  return {
    id: trip.id,
    name: trip.name,
    color: trip.color,
    role: entry.role,
    going: trip.going,
    status: decided.status,
    datesPassed: decided.datesPassed,
    startDate: trip.startDate,
    endDate: trip.endDate,
    days: start !== undefined && end !== undefined && end >= start ? end - start + 1 : null,
    stops: ordered.map((stop) => stop.name),
    people: sets.members.map((member) => ({ name: member.name })),
    action: actionFor(trip.id, decided.status, entry.role, trip.going),
    updatedAt: trip.updatedAt,
  };
}

export function cardsOf(entries: readonly TripEntry[], now: number): TripCard[] {
  return entries.flatMap((entry) => {
    const card = cardOf(entry, now);
    return card ? [card] : [];
  });
}

const byStart = (a: TripCard, b: TripCard) =>
  (a.startDate ?? '9999-12-31').localeCompare(b.startDate ?? '9999-12-31') ||
  a.name.localeCompare(b.name) ||
  a.id.localeCompare(b.id);

/** Each status's own order: ongoing and upcoming by their first day, planning by what was changed last, completed newest first. */
const ORDER: Readonly<Record<TripStatus, (a: TripCard, b: TripCard) => number>> = {
  ongoing: byStart,
  upcoming: byStart,
  planning: (a, b) =>
    b.updatedAt - a.updatedAt || a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
  completed: (a, b) =>
    (b.endDate ?? '').localeCompare(a.endDate ?? '') ||
    a.name.localeCompare(b.name) ||
    a.id.localeCompare(b.id),
};

/** The trips that meet a chip and a search (every word in the name or a stop's name, without case or accents), in the groups' order. */
export function groupTrips(
  cards: readonly TripCard[],
  chip: Chip,
  query: string,
): { status: TripStatus; trips: TripCard[] }[] {
  const words = normalizeName(query).split(' ').filter(Boolean);
  const meets = (card: TripCard) => {
    if (chip !== 'all' && card.status !== chip) return false;
    if (words.length === 0) return true;
    const text = ` ${normalizeName(`${card.name} ${card.stops.join(' ')}`)} `;
    return words.every((word) => text.includes(word));
  };
  return STATUSES.flatMap((status) => {
    const trips = cards.filter((card) => card.status === status && meets(card)).sort(ORDER[status]);
    return trips.length > 0 ? [{ status, trips }] : [];
  });
}

/** How many trips each chip would show, for the chips themselves. */
export function chipCounts(cards: readonly TripCard[]): Record<Chip, number> {
  return {
    all: cards.length,
    planning: cards.filter((c) => c.status === 'planning').length,
    upcoming: cards.filter((c) => c.status === 'upcoming').length,
    ongoing: cards.filter((c) => c.status === 'ongoing').length,
    completed: cards.filter((c) => c.status === 'completed').length,
  };
}

/** The sidebar's Trips section (DESIGN.md §20.2): ongoing first, then upcoming, planning, and the latest three completed. */
export function sidebarTrips(cards: readonly TripCard[]): TripCard[] {
  const groups = groupTrips(cards, 'all', '');
  return groups.flatMap((group) =>
    group.status === 'completed' ? group.trips.slice(0, 3) : group.trips,
  );
}

/** Two letters for a person in a trip's stack of initials. */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const first = parts[0]?.[0] ?? '';
  const last = parts.length > 1 ? (parts.at(-1)?.[0] ?? '') : '';
  return (first + last).toUpperCase();
}

const format = new Intl.DateTimeFormat(undefined, {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  timeZone: 'UTC',
});
const short = new Intl.DateTimeFormat(undefined, {
  day: 'numeric',
  month: 'short',
  timeZone: 'UTC',
});
const at = (date: string) => new Date(`${date}T00:00:00Z`);

/** "10 May – 14 May 2026", or a single day, or nothing to say while it has no dates. The year is said once when both ends are in it. */
export function datesText(start: string | null, end: string | null): string {
  if (start === null || end === null) return 'No dates yet';
  if (start === end) return format.format(at(start));
  return start.slice(0, 4) === end.slice(0, 4)
    ? `${short.format(at(start))} – ${format.format(at(end))}`
    : `${format.format(at(start))} – ${format.format(at(end))}`;
}

export const daysText = (days: number | null): string =>
  days === null ? '' : days === 1 ? '1 day' : `${days} days`;

/** A trip colour as the token that paints its dot: the design system's, and nothing else (DESIGN.md §20.1). */
export const DOT: Readonly<Record<TripColor, string>> = {
  accent: 'var(--sv-color-accent)',
  info: 'var(--sv-color-info-text)',
  success: 'var(--sv-color-success-solid)',
  warning: 'var(--sv-color-warning-text)',
  error: 'var(--sv-color-error-solid)',
  neutral: 'var(--sv-color-text-muted)',
};
