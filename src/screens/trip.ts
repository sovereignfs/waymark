import { isSamePlace } from '../places/match';
import { type Next, todayOfTrip } from '../today';
import { dayNumber, orderStops } from '../trips/dates';
import type { Role } from '../trips/format';
import type { LinkView } from '../trips/links';
import type { TripStatus } from '../trips/status';
import type { DayRecord, ItemRecord, StopRecord, TripSets } from '../sync/trip-format';
import type { ShareChoice } from '../sharing/rules';

/**
 * A trip's page, apart from how it looks (DESIGN.md §20.10): which views a role has, what the header offers, and what the Overview says. **Pure, and decided from the rows the device holds**, so the page paints with no
 * network and a test holds it to each role. What a role may do is the server's to decide whatever this says (`OPERATIONS` in `trips/ops.ts`); this only keeps a screen from offering what would be refused.
 */
export const VIEWS = ['overview', 'plan', 'map', 'journal', 'files', 'people'] as const;
export type View = (typeof VIEWS)[number];
export const VIEW_LABEL: Readonly<Record<View, string>> = {
  overview: 'Overview',
  plan: 'Plan',
  map: 'Map',
  journal: 'Journal',
  files: 'Files',
  people: 'People',
};
export const isView = (value: unknown): value is View =>
  typeof value === 'string' && (VIEWS as readonly string[]).includes(value);

/** The views a role has: Files are hidden from a Follower, who is never given an attachment (§10.6). */
export const viewsFor = (role: string): readonly View[] =>
  role === 'follower' ? VIEWS.filter((view) => view !== 'files') : VIEWS;

/** The view an address asks for (`?view=`), or the Overview for none, for one that is not a view and for one the role does not have. */
export function viewOf(search: string | URLSearchParams, role: string): View {
  const params = typeof search === 'string' ? new URLSearchParams(search) : search;
  const asked = params.get('view');
  return isView(asked) && viewsFor(role).includes(asked) ? asked : 'overview';
}

export const isEditor = (role: string): boolean => role === 'organizer' || role === 'traveler';

export interface HeaderActions {
  /** Whether the Mark ready button is shown, and whether it can be pressed: a trip needs a stop with dates first. */
  readonly markReady: 'hidden' | 'disabled' | 'enabled';
  readonly backToPlanning: boolean;
  /** Open Trip Mode: an ongoing trip, for an Organizer or Traveler who is going. */
  readonly tripMode: boolean;
  /** The menu (rename, colour, delete) is an Organizer's. */
  readonly menu: boolean;
}

/** What the header offers this reader of a trip. **An Organizer's** are Mark ready and Back to planning and the menu; a Traveler or Follower is given none of them. */
export function headerActions(input: {
  role: string;
  status: TripStatus;
  going: boolean;
  readyAt: number | null;
  hasDatedStop: boolean;
}): HeaderActions {
  const organizer = input.role === 'organizer';
  return {
    markReady:
      !organizer || input.readyAt !== null ? 'hidden' : input.hasDatedStop ? 'enabled' : 'disabled',
    backToPlanning: organizer && input.readyAt !== null,
    tripMode: input.status === 'ongoing' && isEditor(input.role) && input.going,
    menu: organizer,
  };
}

export const ROLE_LABEL: Readonly<Record<Role, string>> = {
  organizer: 'Organizer',
  traveler: 'Traveler',
  follower: 'Follower',
};

export interface StopLine {
  readonly id: string;
  readonly name: string;
  readonly arrive: string | null;
  readonly depart: string | null;
  /** How many days the stop covers, inclusive; none while it has no dates. */
  readonly days: number | null;
}

export interface Figures {
  /** From the first day to the last, inclusive. */
  readonly days: number | null;
  readonly stops: number;
  /** Distinct places on the plan: the stops' and the items' (the same place by §7.1's rule counts once). */
  readonly places: number;
  /** The check-ins of other people that were shared with the trip, copies on the device. */
  readonly shared: number;
}

export interface Overview {
  readonly stops: readonly StopLine[];
  readonly figures: Figures;
  /** Tally's link first, then the rest in their own order. */
  readonly links: readonly LinkView[];
  /** The next thing for the reader, or why there is none. */
  readonly next: NextThing;
}

export type NextThing =
  | {
      readonly kind: 'item';
      readonly title: string;
      readonly dayDate: string;
      readonly inMinutes: number | null;
      readonly timed: boolean;
    }
  | { readonly kind: 'starts'; readonly date: string }
  | { readonly kind: 'ended'; readonly date: string }
  | { readonly kind: 'nothing' }
  | { readonly kind: 'undated' };

const stopLine = (stop: StopRecord): StopLine => {
  const from = dayNumber(stop.arrive);
  const to = dayNumber(stop.depart);
  return {
    id: stop.id,
    name: stop.place.name,
    arrive: stop.arrive,
    depart: stop.depart,
    days: from !== undefined && to !== undefined && to >= from ? to - from + 1 : null,
  };
};

/** The links of a trip as the Overview lists them: Tally's first (§10.7), the rest as they were put. */
export const linksOf = (links: readonly LinkView[]): LinkView[] =>
  [...links].sort(
    (a, b) =>
      Number(b.kind === 'tally') - Number(a.kind === 'tally') ||
      a.position.localeCompare(b.position) ||
      a.id.localeCompare(b.id),
  );

/** The title an item is listed by: its own, else its place's name. */
export const itemTitle = (item: Pick<ItemRecord, 'title' | 'place'>): string =>
  item.title?.trim() || item.place?.name || 'Something planned';

function nextThing(
  next: Next<ItemRecord> | undefined,
  state: ReturnType<typeof todayOfTrip>,
  days: readonly { id: string; date: string }[],
): NextThing {
  if (state.state === 'planning') return { kind: 'undated' };
  if (state.state === 'before' && state.edge) return { kind: 'starts', date: state.edge };
  if (state.state === 'after' && state.edge) return { kind: 'ended', date: state.edge };
  if (next) {
    return {
      kind: 'item',
      title: itemTitle(next.item),
      dayDate: days.find((day) => day.id === next.dayId)?.date ?? state.date ?? '',
      inMinutes: next.inMinutes,
      timed: next.at !== null,
    };
  }
  return { kind: 'nothing' };
}

/**
 * The Overview of a trip from the rows the device holds (`LocalStore.tripView`): the stops in order, the figures, the links and the next thing. **The next thing is Today's** (§14.1, `src/today/`), so the Overview and Trip
 * Mode never disagree: while the trip is on, the first item not done; before it, the date it starts; after it, that it has ended.
 */
export function overviewOf(
  view: {
    readonly sets: TripSets;
    readonly items: readonly ItemRecord[];
    readonly days: readonly DayRecord[];
    readonly done: ReadonlySet<string>;
    readonly sharedCount: number;
  },
  now: number,
  deviceZone: string,
): Overview {
  const { sets } = view;
  const ordered = orderStops(sets.stops);
  const start = dayNumber(sets.trip.startDate);
  const end = dayNumber(sets.trip.endDate);

  const places: { name: string; lat: number; lng: number }[] = [];
  const add = (place: { name: string; lat: number; lng: number } | undefined) => {
    if (place && !places.some((each) => isSamePlace(each, place))) places.push(place);
  };
  for (const stop of sets.stops) add(stop.place);
  for (const item of view.items) add(item.place);

  const today = todayOfTrip(
    { stops: sets.stops, days: view.days, items: view.items, done: view.done },
    now,
    deviceZone,
  );
  return {
    stops: ordered.map(stopLine),
    figures: {
      days: start !== undefined && end !== undefined && end >= start ? end - start + 1 : null,
      stops: sets.stops.length,
      places: places.length,
      shared: view.sharedCount,
    },
    links: linksOf(sets.links),
    next: nextThing(today.next, today, view.days),
  };
}

export const SHARE_LABEL: Readonly<Record<ShareChoice, string>> = {
  ask: 'Ask me each time',
  on: 'Share with the trip',
  off: 'Keep private',
};

/** The sharing choice is a Traveler's (and a going Organizer's): a Follower has no check-ins in the trip, so no choice. */
export const sharesChoice = (role: string): boolean => isEditor(role);
