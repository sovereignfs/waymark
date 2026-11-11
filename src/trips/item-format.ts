/**
 * What an item is allowed to be (DESIGN.md §10.5), pure: one function run by the server and, with 6.6, by the device before it queues a change. A problem is a sentence of its own that never repeats what was typed.
 *
 *  - **A place or a title, at least one** (`hasPlace` says whether it has the place).
 *  - A kind: Sight, Food, Stay, Transport, Activity or Other.
 *  - A start time and an end time, `HH:mm` in the stop's zone: **an end needs a start and is after it**.
 *  - **Fixed needs a start time**: a fixed item is a commitment (a 19:00 reservation) and keeps its time; a flexible one can still have a time, as a guide.
 *  - Notes up to 2,000 characters.
 */
export const ITEM_KINDS = ['sight', 'food', 'stay', 'transport', 'activity', 'other'] as const;
export type ItemKind = (typeof ITEM_KINDS)[number];
export const ITEM_TITLE_MAX = 200;
export const ITEM_NOTES_MAX = 2000;

const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;
export const isTime = (value: unknown): value is string =>
  typeof value === 'string' && TIME.test(value);

export interface ItemFields {
  readonly title: string | undefined;
  readonly notes: string | undefined;
  readonly kind: ItemKind;
  readonly start: string | null;
  readonly end: string | null;
  readonly fixed: boolean;
}

export type ItemCheck =
  | { readonly ok: true; readonly value: ItemFields }
  | { readonly ok: false; readonly sentence: string };

const bad = (sentence: string): ItemCheck => ({ ok: false, sentence });
const none = (value: unknown) => value === undefined || value === null || value === '';

/** Checks an item as a whole, from what was given for each field. `hasPlace` is whether it names a place of the trip's. */
export function checkItem(
  input: {
    readonly title?: unknown;
    readonly notes?: unknown;
    readonly kind?: unknown;
    readonly start?: unknown;
    readonly end?: unknown;
    readonly fixed?: unknown;
  },
  hasPlace: boolean,
): ItemCheck {
  let title: string | undefined;
  if (!none(input.title)) {
    if (typeof input.title !== 'string')
      return bad(`An item's title is text of at most ${ITEM_TITLE_MAX} characters on one line.`);
    const trimmed = input.title.trim();
    if (trimmed.length > ITEM_TITLE_MAX || /[\r\n]/.test(trimmed))
      return bad(`An item's title is text of at most ${ITEM_TITLE_MAX} characters on one line.`);
    title = trimmed === '' ? undefined : trimmed;
  }
  if (title === undefined && !hasPlace) return bad('An item needs a place or a title.');
  let notes: string | undefined;
  if (!none(input.notes)) {
    if (typeof input.notes !== 'string' || input.notes.trim().length > ITEM_NOTES_MAX)
      return bad(`An item's notes are text of at most ${ITEM_NOTES_MAX} characters.`);
    notes = input.notes.trim() === '' ? undefined : input.notes.trim();
  }
  const kind = input.kind === undefined || input.kind === null ? 'other' : input.kind;
  if (typeof kind !== 'string' || !(ITEM_KINDS as readonly string[]).includes(kind))
    return bad(`An item's kind is one of ${ITEM_KINDS.join(', ')}.`);
  const start = none(input.start) ? null : input.start;
  const end = none(input.end) ? null : input.end;
  if ((start !== null && !isTime(start)) || (end !== null && !isTime(end)))
    return bad('A time is written HH:mm, from 00:00 to 23:59.');
  if (end !== null && start === null) return bad('An item with an end time needs a start time.');
  if (start !== null && end !== null && end <= start) return bad('An item ends after it starts.');
  if (input.fixed !== undefined && input.fixed !== null && typeof input.fixed !== 'boolean')
    return bad('Fixed is yes or no.');
  const fixed = input.fixed === true;
  if (fixed && start === null) return bad('A fixed item needs a start time.');
  return {
    ok: true,
    value: {
      title,
      notes,
      kind: kind as ItemKind,
      start: start as string | null,
      end: end as string | null,
      fixed,
    },
  };
}
