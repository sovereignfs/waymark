import type { IconName } from '@sovereignfs/ui';
import { displayOrder } from '../today';
import { orderStops } from '../trips/dates';
import type { ItemKind } from '../trips/item-format';
import type { DayRecord, ItemRecord, StopRecord } from '../sync/trip-format';

/**
 * The Plan view's rules (DESIGN.md §10.3 to §10.5, §20.10), apart from how it looks. **Pure**, from the rows the device holds, and the same in a test.
 *
 * The one hard part is **where an item goes when it is dropped.** What a person sees is `displayOrder`'s: the plan's order, with the timed items in time order in the slots the timed items had. What is stored is a position among
 * the day's items. So a drop is turned into the stored place that *shows* the item where it was dropped (`beforeFor`), found by trying each place and asking `displayOrder` (the same function Trip Mode uses), and not by
 * arithmetic that would drift from it. A timed item's place on a day is its time's, so for one that no place can show where it was dropped, it goes to the end.
 */
export const KIND_LABEL: Readonly<Record<ItemKind, string>> = {
  sight: 'Sight',
  food: 'Food',
  stay: 'Stay',
  transport: 'Transport',
  activity: 'Activity',
  other: 'Other',
};
export const KIND_ICON: Readonly<Record<ItemKind, IconName>> = {
  sight: 'eye',
  food: 'coffee',
  stay: 'house',
  transport: 'route',
  activity: 'activity',
  other: 'map-pin',
};

export interface PlanDay {
  readonly day: DayRecord;
  /** In the order they are shown (`displayOrder`). */
  readonly items: readonly ItemRecord[];
}

/** The trip's stops in the order it keeps them. */
export const stopsInOrder = (stops: readonly StopRecord[]): StopRecord[] => orderStops(stops);

/** The stop a page shows: the one asked for (`?stop=`) if the trip has it, else the first. `undefined` for a trip with no stop. */
export function selectedStop(
  stops: readonly StopRecord[],
  asked: string | null | undefined,
): StopRecord | undefined {
  const ordered = stopsInOrder(stops);
  return ordered.find((stop) => stop.id === asked) ?? ordered[0];
}

/** A stop's days by date, each with its items as they are shown. A day with nothing in it is a day with no items. */
export function daysOfStop(
  days: readonly DayRecord[],
  items: readonly ItemRecord[],
  stopId: string,
): PlanDay[] {
  return days
    .filter((day) => day.stopId === stopId)
    .sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id))
    .map((day) => ({ day, items: displayOrder(items.filter((item) => item.dayId === day.id)) }));
}

/**
 * The item to put a moved item **just before** (or `null` for the end of the day) so that it is shown at `targetIndex` of its day. `others` are the target day's items without the moved one, as they are stored.
 * Tries each place in turn and asks `displayOrder` what it would show, so it can never disagree with the screen.
 */
export function beforeFor(
  others: readonly ItemRecord[],
  moving: ItemRecord,
  targetIndex: number,
): string | null {
  const want = Math.max(0, Math.min(targetIndex, others.length));
  const ordered = [...others].sort((a, b) =>
    a.position < b.position ? -1 : a.position > b.position ? 1 : a.id.localeCompare(b.id),
  );
  for (let k = 0; k <= ordered.length; k++) {
    const candidate = [...ordered.slice(0, k), moving, ...ordered.slice(k)].map((item, index) => ({
      id: item.id,
      dayId: item.dayId,
      start: item.start,
      position: String(index).padStart(6, '0'),
    }));
    if (displayOrder(candidate).findIndex((item) => item.id === moving.id) === want)
      return ordered[k]?.id ?? null;
  }
  return null;
}

/** An id the day's drop area has: a day with no items is still somewhere to drop. */
export const dayDropId = (dayId: string): string => `day:${dayId}`;
export const dayOfDropId = (id: string): string | undefined =>
  id.startsWith('day:') ? id.slice(4) : undefined;

export interface Drop {
  readonly dayId: string;
  /** Put just before this item of that day; the end of the day with `null`. */
  readonly before: string | null;
}

/**
 * Where a drag ended: `overId` is an item of some day or a day's drop area. **On the same day** the item takes the place of the one it is dropped on (the list moves as an array does); **on another** it goes just before
 * the one it is dropped on, or to the end when it is dropped on the day. `undefined` when it did not move.
 */
export function dropOf(
  plan: readonly PlanDay[],
  activeId: string,
  overId: string,
): Drop | undefined {
  const from = plan.find((each) => each.items.some((item) => item.id === activeId));
  const moving = from?.items.find((item) => item.id === activeId);
  if (!from || !moving) return undefined;
  const overDay = dayOfDropId(overId);
  const to = overDay
    ? plan.find((each) => each.day.id === overDay)
    : plan.find((each) => each.items.some((item) => item.id === overId));
  if (!to) return undefined;
  const others = to.items.filter((item) => item.id !== activeId);
  const index = overDay ? others.length : to.items.findIndex((item) => item.id === overId);
  if (index < 0) return undefined;
  if (to.day.id === from.day.id) {
    const was = to.items.findIndex((item) => item.id === activeId);
    if (was === index) return undefined;
  }
  return { dayId: to.day.id, before: beforeFor(others, moving, index) };
}

/** Where "move up" and "move down" put an item: the drop that takes the place of its neighbour. `undefined` at the edge of the day. */
export function nudgeOf(
  plan: readonly PlanDay[],
  itemId: string,
  direction: 'up' | 'down',
): Drop | undefined {
  const day = plan.find((each) => each.items.some((item) => item.id === itemId));
  if (!day) return undefined;
  const at = day.items.findIndex((item) => item.id === itemId);
  const neighbour = day.items[direction === 'up' ? at - 1 : at + 1];
  return neighbour ? dropOf(plan, itemId, neighbour.id) : undefined;
}

/** What a day is called in a list: its date, its title if it has one, and the stop. */
export function dayChoices(
  stops: readonly StopRecord[],
  days: readonly DayRecord[],
): { id: string; label: string }[] {
  const names = new Map(stops.map((stop) => [stop.id, stop.place.name]));
  const order = new Map(stopsInOrder([...stops]).map((stop, index) => [stop.id, index]));
  const when = (date: string) =>
    new Intl.DateTimeFormat('en-GB', {
      timeZone: 'UTC',
      weekday: 'short',
      day: 'numeric',
      month: 'short',
    }).format(new Date(`${date}T12:00:00Z`));
  return [...days]
    .sort(
      (a, b) =>
        (order.get(a.stopId) ?? 0) - (order.get(b.stopId) ?? 0) ||
        a.date.localeCompare(b.date) ||
        a.id.localeCompare(b.id),
    )
    .map((day) => ({
      id: day.id,
      label: `${when(day.date)}${day.title ? ` · ${day.title}` : ''} · ${names.get(day.stopId) ?? ''}`,
    }));
}

/** The places the trip has, once each by id, for choosing an item's place: the stops' and the items'. */
export function tripPlaces(
  stops: readonly StopRecord[],
  items: readonly ItemRecord[],
): { id: string; name: string }[] {
  const seen = new Map<string, string>();
  for (const stop of stops) seen.set(stop.place.id, stop.place.name);
  for (const item of items) if (item.place) seen.set(item.place.id, item.place.name);
  return [...seen].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
}
