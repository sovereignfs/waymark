import type { CheckinView, PlaceView } from '../actions/types';
import type { DayRecord, ItemRecord } from '../sync/trip-format';
import type { TripMutation } from '../trips/sync-format';
import type { AnyMutation } from './db';

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

export function overlay(rows: Rows, outbox: readonly AnyMutation[]): Rows {
  if (outbox.length === 0) return rows;
  const places = new Map(rows.places);
  const checkins = new Map(rows.checkins);
  for (const mutation of outbox) {
    // A trip's mutations are laid over that trip's rows (`overlayTrip`), not these.
    if (mutation.stream !== 'account') continue;
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

/** What a trip's screens read: the items and the days, as the server last said them. */
export interface TripRows {
  readonly items: ReadonlyMap<string, ItemRecord>;
  readonly days: ReadonlyMap<string, DayRecord>;
  /** The items this account has marked done. */
  readonly done: ReadonlySet<string>;
}

/**
 * A trip's rows with the outbox laid over them (DESIGN.md §15.1, §15.4): the same as `overlay` for the trip's stream, so that an item made, moved or deleted offline shows at once and a refused one goes by itself. A put
 * replaces the item whole and keeps the version the device last saw; an item the device made is version 1; its place is the trip's place of that id as the device knows it (from the stops' and the other items' places). `me` is the account, which
 * made and last changed what it put. A put for an item the server deleted restores it, as the server would.
 */
export function overlayTrip(
  tripId: string,
  rows: TripRows,
  places: ReadonlyMap<string, ItemRecord['place'] & object>,
  outbox: readonly AnyMutation[],
  me: string,
): TripRows {
  const mine = outbox.filter(
    (mutation): mutation is TripMutation => mutation.stream === `trip:${tripId}`,
  );
  if (mine.length === 0) return rows;
  const items = new Map(rows.items);
  const days = new Map(rows.days);
  const done = new Set(rows.done);
  for (const mutation of mine) {
    for (const change of mutation.changes) {
      if (change.table === 'item' && change.op === 'put') {
        const before = items.get(change.id);
        const { placeId, ...row } = change.row;
        items.set(change.id, {
          ...row,
          id: change.id,
          title: row.title,
          notes: row.notes,
          place: placeId === null ? undefined : places.get(placeId),
          createdBy: before?.createdBy ?? me,
          updatedBy: me,
          version: before?.version ?? 1,
          seq: before?.seq ?? 0,
        });
      } else if (change.table === 'item_done') {
        if (change.op === 'put') done.add(change.id);
        else done.delete(change.id);
      } else if (change.table === 'item') {
        items.delete(change.id);
        done.delete(change.id);
      } else {
        const before = days.get(change.id);
        if (before)
          days.set(change.id, { ...before, title: change.row.title, notes: change.row.notes });
      }
    }
  }
  return { items, days, done };
}
