import type { CheckinView, PlaceView } from '../actions/types';
import type { Mutation } from '../sync/format';

/**
 * What the screens read (DESIGN.md §15.1): **the rows the server last said, with the outbox laid over them**, in order, as the server would apply them. Pure, so that it is the same everywhere and a
 * test can say what it makes. A put replaces the row whole and keeps the version the device last saw (a new row is version 1), since what an edit says it was made from is the server's version and
 * not a count of the device's own tries; a delete takes the row away. A mutation the server refused is not in the outbox any more, so its rows are gone from this by themselves, and
 * nothing has to be undone.
 */
export interface Rows {
  readonly places: ReadonlyMap<string, PlaceView>;
  readonly checkins: ReadonlyMap<string, CheckinView>;
}

export function overlay(rows: Rows, outbox: readonly Mutation[]): Rows {
  if (outbox.length === 0) return rows;
  const places = new Map(rows.places);
  const checkins = new Map(rows.checkins);
  for (const mutation of outbox) {
    for (const change of mutation.changes) {
      if (change.table === 'place' && change.op === 'put')
        places.set(change.id, {
          ...change.row,
          id: change.id,
          version: places.get(change.id)?.version ?? 1,
        });
      else if (change.table === 'checkin' && change.op === 'put')
        checkins.set(change.id, {
          ...change.row,
          id: change.id,
          version: checkins.get(change.id)?.version ?? 1,
        });
      else if (change.table === 'place') places.delete(change.id);
      else checkins.delete(change.id);
    }
  }
  return { places, checkins };
}
