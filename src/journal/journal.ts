import { isSamePlace } from '../places/match';
import { localDate } from '../places/tz';
import { orderStops } from '../trips/dates';
import { displayOrder } from '../today';

/**
 * **Planned versus actual** (DESIGN.md §13), pure and the one implementation: a trip's plan beside the check-ins the reader may see, day by day. The device runs it for the Journal and the Overview from the rows it holds, the
 * rules for Trip Mode's _done_ are the same, and a test holds it to a trip worked by hand. Nothing here reads a clock, a database or a device: `now` and `deviceZone` are given.
 *
 * What the reader may see is **what they are given**: their own check-ins that are linked to the trip, and the copies others chose to share with it. A check-in that was not shared is never an input, so it can never be an
 * output. Only **the Travelers and the Organizers who are going** count (§11.1): a check-in by anyone else, or by someone no longer in the trip, is left out.
 *
 *  - **Done:** an item whose place is the same place (§7.1: the same name within 50 metres) as a check-in on that day by someone who counts.
 *  - **Skipped:** an item with a place that nothing matched, once its day has passed (in the zone of its stop).
 *  - **Planned:** everything else: an item still to come, and an item with **no place**, which nothing can match and so is never judged.
 *  - **Found on the way:** a check-in on that day that matches no item.
 *
 * A check-in is on the day it was **by its own clock** (its moment and its offset then), as the figures read it. A date two stops share (a travel day) is one day of the journal, with the items of both.
 * `judgeUntimed` says whether an item with no start time is judged: it is, by default, since the plan's time plays no part in a match and most of what is planned has none.
 */
export interface JournalMember {
  readonly accountId: string;
  readonly name: string;
  readonly role: string;
  readonly going: boolean;
}
export interface JournalStop {
  readonly id: string;
  readonly arrive: string | null;
  readonly depart: string | null;
  readonly position: string;
  readonly place: {
    readonly name: string;
    readonly lat: number;
    readonly lng: number;
    readonly tz: string | null;
  };
}
export interface JournalDayRow {
  readonly id: string;
  readonly stopId: string;
  readonly date: string;
  readonly title: string | undefined;
  readonly notes: string | undefined;
}
export interface JournalItem {
  readonly id: string;
  readonly dayId: string;
  readonly title: string | undefined;
  /** What kind of thing it is, for a screen's icon; the rules do not read it. */
  readonly kind?: string | undefined;
  readonly start: string | null;
  readonly position: string;
  readonly place: { readonly name: string; readonly lat: number; readonly lng: number } | undefined;
}
/** A check-in as the journal reads it: the author's own, or a copy shared with the trip. */
export interface JournalCheckin {
  readonly id: string;
  readonly authorId: string;
  readonly place: {
    readonly name: string;
    readonly lat: number;
    readonly lng: number;
    readonly source?: string | null | undefined;
    readonly sourceId?: string | null | undefined;
  };
  readonly at: number;
  readonly tz: string;
  readonly offsetMin: number;
  readonly note?: string | undefined;
  readonly photos: readonly string[];
}

export interface JournalInput {
  readonly stops: readonly JournalStop[];
  readonly days: readonly JournalDayRow[];
  readonly items: readonly JournalItem[];
  readonly members: readonly JournalMember[];
  /** The reader's own check-ins linked to this trip. */
  readonly own: readonly JournalCheckin[];
  /** The copies others shared with this trip. */
  readonly shared: readonly JournalCheckin[];
  readonly now: number;
  readonly deviceZone: string;
  readonly judgeUntimed?: boolean;
}

export type ItemStatus = 'done' | 'skipped' | 'planned';

export interface Who {
  readonly accountId: string;
  readonly name: string;
}

export type JournalEntry =
  | {
      readonly kind: 'item';
      readonly item: JournalItem;
      readonly status: ItemStatus;
      /** Who checked in there, once each, in the order they did. */
      readonly by: readonly Who[];
      /** The check-ins that made it done. */
      readonly checkins: readonly JournalCheckin[];
    }
  | { readonly kind: 'found'; readonly checkin: JournalCheckin; readonly by: Who };

export interface Counts {
  readonly planned: number;
  readonly done: number;
  readonly skipped: number;
  readonly found: number;
}

export interface JournalDay {
  readonly date: string;
  readonly dayIds: readonly string[];
  readonly title: string | undefined;
  readonly stops: readonly string[];
  /** In time order: the plan's order with the timed items by time, and each check-in found on the way at its own time. */
  readonly entries: readonly JournalEntry[];
  readonly counts: Counts;
  /** Whether the day has passed in the zone of its stop. */
  readonly over: boolean;
}

export interface Journal {
  /** From the first day to today, or to the last day if the trip is over. Nothing for a trip that has not begun. */
  readonly days: readonly JournalDay[];
  readonly figures: {
    /** Distinct places on the plan. */
    readonly planned: number;
    /** Of those, the ones that were done on some day. */
    readonly visited: number;
    /** The check-ins that count, whatever the day. */
    readonly checkins: number;
  };
  /** The items that are done: Trip Mode's _done_ before the person's own marks (§14.1). */
  readonly doneItems: ReadonlySet<string>;
}

const localDay = (checkin: JournalCheckin): string =>
  new Date(checkin.at + checkin.offsetMin * 60_000).toISOString().slice(0, 10);
const localTime = (checkin: JournalCheckin): string =>
  new Date(checkin.at + checkin.offsetMin * 60_000).toISOString().slice(11, 16);

/** How a day reads: "5 planned, 3 done, 1 skipped, 2 found on the way". */
export function sentenceOf(counts: Counts): string {
  const parts: string[] = [];
  if (counts.planned > 0) parts.push(`${counts.planned} planned`);
  if (counts.done > 0) parts.push(`${counts.done} done`);
  if (counts.skipped > 0) parts.push(`${counts.skipped} skipped`);
  if (counts.found > 0) parts.push(`${counts.found} found on the way`);
  return parts.length > 0 ? parts.join(', ') : 'Nothing planned';
}

export function journalOf(input: JournalInput): Journal {
  const judgeUntimed = input.judgeUntimed ?? true;
  const counting = new Map(
    input.members
      .filter(
        (member) => (member.role === 'organizer' || member.role === 'traveler') && member.going,
      )
      .map((member) => [member.accountId, member]),
  );
  const checkins = [...input.own, ...input.shared]
    .filter((checkin) => counting.has(checkin.authorId))
    .sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
  const who = (checkin: JournalCheckin): Who => ({
    accountId: checkin.authorId,
    name: counting.get(checkin.authorId)?.name ?? 'Someone',
  });

  const stopOf = new Map(input.stops.map((stop) => [stop.id, stop]));
  const stopOrder = new Map(orderStops([...input.stops]).map((stop, index) => [stop.id, index]));
  const dates = [...new Set(input.days.map((day) => day.date))].sort();

  const doneItems = new Set<string>();
  const plannedPlaces: { name: string; lat: number; lng: number }[] = [];
  const visitedPlaces: { name: string; lat: number; lng: number }[] = [];
  const addDistinct = (list: typeof plannedPlaces, place: (typeof plannedPlaces)[number]) => {
    if (!list.some((each) => isSamePlace(each, place))) list.push(place);
  };
  for (const stop of input.stops) addDistinct(plannedPlaces, stop.place);
  for (const item of input.items) if (item.place) addDistinct(plannedPlaces, item.place);

  const days: JournalDay[] = [];
  for (const date of dates) {
    const rows = input.days
      .filter((day) => day.date === date)
      .sort(
        (a, b) =>
          (stopOrder.get(a.stopId) ?? 0) - (stopOrder.get(b.stopId) ?? 0) ||
          a.id.localeCompare(b.id),
      );
    const zone = stopOf.get(rows[rows.length - 1]?.stopId ?? '')?.place.tz ?? input.deviceZone;
    const today = localDate(input.now, zone);
    // The journal runs to today, or to the last day if the trip is over: a day to come is not in it.
    if (date > today) continue;
    const over = date < today;

    const items = rows.flatMap((row) =>
      displayOrder(input.items.filter((item) => item.dayId === row.id)),
    );
    const here = checkins.filter((checkin) => localDay(checkin) === date);
    const used = new Set<string>();
    const entries: JournalEntry[] = items.map((item): JournalEntry => {
      const judged = item.place !== undefined && (judgeUntimed || item.start !== null);
      const place = item.place;
      const matched =
        judged && place ? here.filter((checkin) => isSamePlace(place, checkin.place)) : [];
      for (const checkin of matched) used.add(checkin.id);
      const by: Who[] = [];
      for (const checkin of matched)
        if (!by.some((each) => each.accountId === checkin.authorId)) by.push(who(checkin));
      const status: ItemStatus =
        matched.length > 0 ? 'done' : judged && over ? 'skipped' : 'planned';
      if (status === 'done') {
        doneItems.add(item.id);
        if (item.place) addDistinct(visitedPlaces, item.place);
      }
      return { kind: 'item', item, status, by, checkins: matched };
    });

    // Each check-in found on the way goes at its own time: before the first timed item that starts after it, else at the end.
    for (const checkin of here.filter((each) => !used.has(each.id))) {
      const time = localTime(checkin);
      const at = entries.findIndex(
        (entry) => entry.kind === 'item' && entry.item.start !== null && entry.item.start > time,
      );
      const entry: JournalEntry = { kind: 'found', checkin, by: who(checkin) };
      if (at < 0) entries.push(entry);
      else entries.splice(at, 0, entry);
    }

    const counts: Counts = {
      planned: items.length,
      done: entries.filter((entry) => entry.kind === 'item' && entry.status === 'done').length,
      skipped: entries.filter((entry) => entry.kind === 'item' && entry.status === 'skipped')
        .length,
      found: entries.filter((entry) => entry.kind === 'found').length,
    };
    days.push({
      date,
      dayIds: rows.map((row) => row.id),
      title: rows.find((row) => row.title)?.title,
      stops: [...new Set(rows.map((row) => stopOf.get(row.stopId)?.place.name ?? ''))].filter(
        Boolean,
      ),
      entries,
      counts,
      over,
    });
  }

  return {
    days,
    figures: {
      planned: plannedPlaces.length,
      visited: visitedPlaces.length,
      checkins: checkins.length,
    },
    doneItems,
  };
}
