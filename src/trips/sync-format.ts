import { isPosition } from '../position';
import { type ItemKind, checkItem } from './item-format';
import { TRIP_ID } from './format';

/**
 * What a device may send into a **trip's stream** (DESIGN.md §15.2), and the one set of rules for it, **run by the device before it queues a change and by the server before it applies one**: pure, no database, no clock. What syncs offline in a
 * trip is small and exact: for Organizers and Travelers, **creating, editing, moving and deleting items, editing a day's title and notes, and marking an item done** (a person's own _Done_, 13.1). Everything else in a trip (stops, ready, members, roles, invitations, attachments, links, a trip's
 * own places) is an online operation (§15.7).
 *
 * A mutation belongs to one trip (`stream: "trip:<id>"`) and holds changes to its items and days, each a whole-row put (the edit that reaches the server later stands, §15.4; one for a row that was deleted restores it) or a delete. An item
 * names its day, its place if it has one (**one the trip already has**: a new place is an online operation), and **its position in the day, which the device chose** between its neighbours (`src/position.ts`).
 *
 * ```json
 * { "mutationId": "…", "stream": "trip:3f2a…", "changes": [
 *   { "table": "item", "op": "put", "id": "…", "baseVersion": 3, "row": { "dayId": "…", "title": "Dinner", "kind": "food", "start": "20:00", "end": null, "fixed": true, "placeId": null, "position": "a0" } },
 *   { "table": "day", "op": "put", "id": "…", "row": { "title": "Travel day" } } ] }
 * ```
 */
export const DAY_TITLE_MAX = 200;
export const DAY_NOTES_MAX = 2000;
/** The most changes one trip mutation holds. */
export const TRIP_CHANGES_MAX = 50;

export interface ItemWrite {
  readonly dayId: string;
  readonly title?: string;
  readonly notes?: string;
  readonly kind: ItemKind;
  readonly start: string | null;
  readonly end: string | null;
  readonly fixed: boolean;
  readonly placeId: string | null;
  readonly position: string;
}
export interface DayWrite {
  readonly title?: string;
  readonly notes?: string;
}

/** A person's _Done_ mark on an item (13.1): theirs alone; made by a put and taken away by a delete, both naming the item. */
export type DoneChange =
  | { readonly table: 'item_done'; readonly op: 'put'; readonly id: string }
  | { readonly table: 'item_done'; readonly op: 'delete'; readonly id: string };

export type TripChange =
  | DoneChange
  | {
      readonly table: 'item';
      readonly op: 'put';
      readonly id: string;
      readonly baseVersion?: number;
      readonly row: ItemWrite;
    }
  | { readonly table: 'item'; readonly op: 'delete'; readonly id: string }
  | {
      readonly table: 'day';
      readonly op: 'put';
      readonly id: string;
      readonly baseVersion?: number;
      readonly row: DayWrite;
    };

export interface TripMutation {
  readonly mutationId: string;
  readonly stream: `trip:${string}`;
  readonly changes: readonly TripChange[];
}

export type TripReason =
  | 'bad_mutation'
  | 'bad_id'
  | 'too_many_changes'
  | 'duplicate_change'
  | 'item'
  | 'position'
  | 'day_text';

export type TripCheck<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: TripReason; readonly sentence: string };

const SENTENCES: Readonly<Record<Exclude<TripReason, 'item' | 'day_text'>, string>> = {
  bad_mutation:
    'That change is not one this version of Waymark understands. Update the app and try again.',
  bad_id: 'That is not a valid id.',
  too_many_changes: 'That is too many changes at once.',
  duplicate_change: 'That change names the same thing twice.',
  position: 'That is not a place in the day.',
};
const refuse = (reason: Exclude<TripReason, 'item' | 'day_text'>): TripCheck<never> => ({
  ok: false,
  reason,
  sentence: SENTENCES[reason],
});

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const onlyKeys = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).every((key) => keys.includes(key));
const isId = (value: unknown): value is string => typeof value === 'string' && TRIP_ID.test(value);

/** The trip a stream names, or undefined. */
export function tripOfStream(stream: unknown): string | undefined {
  if (typeof stream !== 'string' || !stream.startsWith('trip:')) return undefined;
  const id = stream.slice(5);
  return isId(id) ? id : undefined;
}

export function checkItemWrite(input: unknown): TripCheck<ItemWrite> {
  if (
    !isObject(input) ||
    !onlyKeys(input, [
      'dayId',
      'title',
      'notes',
      'kind',
      'start',
      'end',
      'fixed',
      'placeId',
      'position',
    ])
  )
    return refuse('bad_mutation');
  if (!isId(input.dayId)) return refuse('bad_id');
  const placeId = input.placeId === undefined || input.placeId === null ? null : input.placeId;
  if (placeId !== null && !isId(placeId)) return refuse('bad_id');
  if (typeof input.position !== 'string' || !isPosition(input.position)) return refuse('position');
  const checked = checkItem(input, placeId !== null);
  if (!checked.ok) return { ok: false, reason: 'item', sentence: checked.sentence };
  const { title, notes, kind, start, end, fixed } = checked.value;
  return {
    ok: true,
    value: {
      dayId: input.dayId,
      ...(title ? { title } : {}),
      ...(notes ? { notes } : {}),
      kind,
      start,
      end,
      fixed,
      placeId,
      position: input.position,
    },
  };
}

export function checkDayWrite(input: unknown): TripCheck<DayWrite> {
  if (!isObject(input) || !onlyKeys(input, ['title', 'notes'])) return refuse('bad_mutation');
  const none = (value: unknown) => value === undefined || value === null || value === '';
  let title: string | undefined;
  if (!none(input.title)) {
    if (typeof input.title !== 'string') return dayText();
    const trimmed = input.title.trim();
    if (trimmed.length > DAY_TITLE_MAX || /[\r\n]/.test(trimmed)) return dayText();
    title = trimmed === '' ? undefined : trimmed;
  }
  let notes: string | undefined;
  if (!none(input.notes)) {
    if (typeof input.notes !== 'string' || input.notes.trim().length > DAY_NOTES_MAX)
      return dayText();
    notes = input.notes.trim() === '' ? undefined : input.notes.trim();
  }
  return { ok: true, value: { ...(title ? { title } : {}), ...(notes ? { notes } : {}) } };
}
const dayText = (): TripCheck<never> => ({
  ok: false,
  reason: 'day_text',
  sentence: `A day's title is at most ${DAY_TITLE_MAX} characters on one line, and its notes at most ${DAY_NOTES_MAX}.`,
});

/** A trip mutation as the device wrote it, or why not: the same function runs on both sides. */
export function parseTripMutation(
  input: unknown,
): TripCheck<{ readonly tripId: string; readonly mutation: TripMutation }> {
  if (!isObject(input) || !onlyKeys(input, ['mutationId', 'stream', 'changes']))
    return refuse('bad_mutation');
  if (!isId(input.mutationId)) return refuse('bad_id');
  const tripId = tripOfStream(input.stream);
  if (tripId === undefined) return refuse('bad_mutation');
  if (!Array.isArray(input.changes) || input.changes.length === 0) return refuse('bad_mutation');
  if (input.changes.length > TRIP_CHANGES_MAX) return refuse('too_many_changes');
  const changes: TripChange[] = [];
  const seen = new Set<string>();
  for (const each of input.changes as unknown[]) {
    if (
      !isObject(each) ||
      (each.table !== 'item' && each.table !== 'day' && each.table !== 'item_done')
    )
      return refuse('bad_mutation');
    if (!isId(each.id)) return refuse('bad_id');
    const key = `${each.table}/${each.id}`;
    if (seen.has(key)) return refuse('duplicate_change');
    seen.add(key);
    if (each.table === 'item_done') {
      if ((each.op !== 'put' && each.op !== 'delete') || !onlyKeys(each, ['table', 'op', 'id']))
        return refuse('bad_mutation');
      changes.push({ table: 'item_done', op: each.op, id: each.id });
      continue;
    }
    if (each.op === 'delete') {
      if (each.table !== 'item' || !onlyKeys(each, ['table', 'op', 'id']))
        return refuse('bad_mutation');
      changes.push({ table: 'item', op: 'delete', id: each.id });
      continue;
    }
    if (each.op !== 'put' || !onlyKeys(each, ['table', 'op', 'id', 'baseVersion', 'row']))
      return refuse('bad_mutation');
    const base = each.baseVersion;
    if (base !== undefined && (typeof base !== 'number' || !Number.isInteger(base) || base < 1))
      return refuse('bad_mutation');
    const baseVersion = base === undefined ? {} : { baseVersion: base };
    if (each.table === 'item') {
      const row = checkItemWrite(each.row);
      if (!row.ok) return row;
      changes.push({ table: 'item', op: 'put', id: each.id, ...baseVersion, row: row.value });
    } else {
      const row = checkDayWrite(each.row);
      if (!row.ok) return row;
      changes.push({ table: 'day', op: 'put', id: each.id, ...baseVersion, row: row.value });
    }
  }
  return {
    ok: true,
    value: {
      tripId,
      mutation: {
        mutationId: input.mutationId,
        stream: input.stream as `trip:${string}`,
        changes,
      },
    },
  };
}
