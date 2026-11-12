import { after, between, first } from '../position';
import type { ItemRecord, DayRecord } from '../sync/trip-format';
import {
  type ItemWrite,
  type TripMutation,
  type TripReason,
  checkDayWrite,
  checkItemWrite,
} from '../trips/sync-format';
import type { Context } from './types';

/**
 * What a Traveler does to a trip's items and a day's words, offline (DESIGN.md §15.2): make an item, change it, move it within a day or to another, delete it, and edit a day's title and notes. Pure (see `types.ts`): each is a function from
 * what is on the screen and what was asked to a **mutation of the trip's stream** (`trip:<id>`), or the reason there is none, in a sentence. The rules are the ones the server applies again (`src/trips/sync-format.ts`).
 *
 * **The position is the device's:** an item goes between its neighbours in the day as the device shows them (`src/position.ts`), so two devices that put items in the same gap end with a stable order. An edit names the **version it was made
 * from**, which says what was seen and does not stop the edit: the later edit stands, and the earlier author is told (§15.4).
 */
export type TripActionResult =
  | {
      readonly ok: true;
      readonly mutation: TripMutation;
      readonly created?: { readonly itemId: string };
    }
  | { readonly ok: false; readonly reason: TripReason | 'missing'; readonly sentence: string };

export interface ItemInput {
  readonly title?: string | undefined;
  readonly notes?: string | undefined;
  readonly kind?: ItemWrite['kind'] | undefined;
  readonly start?: string | null | undefined;
  readonly end?: string | null | undefined;
  readonly fixed?: boolean | undefined;
  /** One of the trip's places (an item's new place is an online operation). */
  readonly placeId?: string | null | undefined;
}

const mutation = (
  ctx: Context,
  tripId: string,
  changes: TripMutation['changes'],
): TripMutation => ({
  mutationId: ctx.ids.newId(),
  stream: `trip:${tripId}`,
  changes,
});

type Neighbour = { readonly id: string; readonly position: string };

/** A position for an item put just before `beforeId` among `list` (in the day's order, without the item being moved), or at the end with none; undefined when `beforeId` is not in the list. */
export function positionAmong(
  list: readonly Neighbour[],
  beforeId: string | null | undefined,
): string | undefined {
  if (beforeId === null || beforeId === undefined)
    return list.length === 0 ? first() : after(list.at(-1)?.position ?? '');
  const index = list.findIndex((row) => row.id === beforeId);
  if (index < 0) return undefined;
  return between(
    index === 0 ? null : (list[index - 1]?.position ?? null),
    list[index]?.position ?? null,
  );
}

const missing = (): TripActionResult => ({
  ok: false,
  reason: 'missing',
  sentence: 'That item is not in this day any more.',
});

/** An item at the end of a day, or before another. */
export function createItem(
  tripId: string,
  dayId: string,
  input: ItemInput,
  among: readonly Neighbour[],
  before: string | null,
  ctx: Context,
): TripActionResult {
  const position = positionAmong(among, before);
  if (position === undefined) return missing();
  const row = checkItemWrite({
    dayId,
    title: input.title,
    notes: input.notes,
    kind: input.kind,
    start: input.start,
    end: input.end,
    fixed: input.fixed,
    placeId: input.placeId,
    position,
  });
  if (!row.ok) return row;
  const id = ctx.ids.newId();
  return {
    ok: true,
    mutation: mutation(ctx, tripId, [{ table: 'item', op: 'put', id, row: row.value }]),
    created: { itemId: id },
  };
}

/** Changes an item: each field given is changed and the rest kept, and **the whole is checked as it will be** (an item still has a place or a title, a fixed one a start). */
export function editItem(
  tripId: string,
  item: ItemRecord,
  patch: ItemInput,
  ctx: Context,
): TripActionResult {
  const has = (key: keyof ItemInput) => key in patch;
  const row = checkItemWrite({
    dayId: item.dayId,
    title: has('title') ? patch.title : item.title,
    notes: has('notes') ? patch.notes : item.notes,
    kind: has('kind') ? patch.kind : item.kind,
    start: has('start') ? patch.start : item.start,
    end: has('end') ? patch.end : item.end,
    fixed: has('fixed') ? patch.fixed : item.fixed,
    placeId: has('placeId') ? patch.placeId : (item.place?.id ?? null),
    position: item.position,
  });
  if (!row.ok) return row;
  return {
    ok: true,
    mutation: mutation(ctx, tripId, [
      { table: 'item', op: 'put', id: item.id, baseVersion: item.version, row: row.value },
    ]),
  };
}

/** Moves an item, with all its fields, to a day: just before another item of that day, or at the end. `among` is the target day's items without this one. */
export function moveItem(
  tripId: string,
  item: ItemRecord,
  dayId: string,
  among: readonly Neighbour[],
  before: string | null,
  ctx: Context,
): TripActionResult {
  const position = positionAmong(among, before);
  if (position === undefined) return missing();
  const row = checkItemWrite({
    dayId,
    title: item.title,
    notes: item.notes,
    kind: item.kind,
    start: item.start,
    end: item.end,
    fixed: item.fixed,
    placeId: item.place?.id ?? null,
    position,
  });
  if (!row.ok) return row;
  return {
    ok: true,
    mutation: mutation(ctx, tripId, [
      { table: 'item', op: 'put', id: item.id, baseVersion: item.version, row: row.value },
    ]),
  };
}

export function deleteItem(tripId: string, itemId: string, ctx: Context): TripActionResult {
  return {
    ok: true,
    mutation: mutation(ctx, tripId, [{ table: 'item', op: 'delete', id: itemId }]),
  };
}

/** A day's title and notes (both replaced; an empty one clears it). */
export function editDay(
  tripId: string,
  day: DayRecord,
  words: { readonly title?: string | undefined; readonly notes?: string | undefined },
  ctx: Context,
): TripActionResult {
  const row = checkDayWrite(words);
  if (!row.ok) return row;
  return {
    ok: true,
    mutation: mutation(ctx, tripId, [
      { table: 'day', op: 'put', id: day.id, baseVersion: day.version, row: row.value },
    ]),
  };
}

/** Marks an item done for today without checking in (DESIGN.md §14.1), or takes the mark away: the person's own, in the trip's stream. */
export function markDone(
  tripId: string,
  itemId: string,
  done: boolean,
  ctx: Context,
): TripActionResult {
  return {
    ok: true,
    mutation: mutation(ctx, tripId, [
      { table: 'item_done', op: done ? 'put' : 'delete', id: itemId },
    ]),
  };
}
