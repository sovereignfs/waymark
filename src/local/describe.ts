import type { PlaceView } from '../actions/types';
import { localDate, localTime } from '../places/tz';
import type { Change, Mutation } from '../sync/format';
import type { AnyMutation } from './db';

/**
 * What a mutation was, in a few words a person recognises (DESIGN.md §15.5), for Couldn't sync: "Check-in at Café de Flore, 4 July 2026 12:30", "Place Café de Flore", "Delete of a check-in". Pure. The place
 * of a check-in is named from the mutation itself when it made the place, and from what the device holds otherwise; a place it knows nothing of is "a place".
 */
const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

function when(at: number, tz: string): string {
  try {
    const [year, month, day] = localDate(at, tz).split('-').map(Number);
    return `${day} ${MONTHS[(month ?? 1) - 1]} ${year} ${localTime(at, tz)}`;
  } catch {
    return new Date(at).toISOString().slice(0, 16).replace('T', ' ');
  }
}

/** A change to a trip's items or a day, in a few words: the item's own title when it has one. */
function describeTrip(mutation: Extract<AnyMutation, { stream: `trip:${string}` }>): string {
  const parts: string[] = [];
  for (const change of mutation.changes) {
    if (change.table === 'day') parts.push('A day’s notes');
    else if (change.table === 'item_done')
      parts.push(change.op === 'put' ? 'Marked an item done' : 'Marked an item not done');
    else if (change.op === 'delete') parts.push('Delete of an item');
    else parts.push(`Item ${change.row.title ?? 'at a place'}`);
  }
  return parts.join('; ') || 'A change';
}

export function describeMutation(
  anyMutation: AnyMutation | undefined,
  places: readonly Pick<PlaceView, 'id' | 'name'>[] = [],
): string {
  // A photo that could not be uploaded has no mutation of its own: it belongs to a check-in that names it.
  if (!anyMutation) return 'A photo of a check-in';
  if (anyMutation.stream !== 'account') return describeTrip(anyMutation);
  const mutation: Mutation = anyMutation;
  const parts: string[] = [];
  const nameOf = (id: string): string =>
    mutation.changes.flatMap((c: Change) =>
      c.table === 'place' && c.op === 'put' && c.id === id ? [c.row.name] : [],
    )[0] ??
    places.find((p) => p.id === id)?.name ??
    'a place';
  for (const change of mutation.changes) {
    if (change.table === 'checkin' && change.op === 'put')
      parts.push(
        `Check-in at ${nameOf(change.row.placeId)}, ${when(change.row.at, change.row.tz)}`,
      );
    else if (change.table === 'checkin') parts.push('Delete of a check-in');
    else if (change.op === 'put') {
      // A place made together with a check-in at it is part of that check-in's story.
      if (
        !mutation.changes.some(
          (c) => c.table === 'checkin' && c.op === 'put' && c.row.placeId === change.id,
        )
      )
        parts.push(`Place ${change.row.name}`);
    } else parts.push('Delete of a place');
  }
  return parts.join('; ') || 'A change';
}
