/**
 * Every table that carries a `trip_id`, and what happens to its rows when a trip is deleted (DESIGN.md §5.2, §10.1; `deleteTrip` in `trips.ts`). **A table that holds a trip's rows is decided here by the task that makes it**, and
 * `tables.test.ts` reads the schema and fails for one that is not, so that deleting a trip can never leave a row of it behind unnoticed.
 *
 *  - `delete`: the rows go with the trip, in its transaction.
 *  - `unlink`: the rows belong to someone else and only stop pointing at the trip (a person's check-ins, which stay theirs, and say so in their own stream so that their devices find out).
 *  - `keep`: the rows are a person's own and say what happened (a person's notices): they are not shown for a trip the person is not in, and the job that prunes notices takes them after 90 days.
 *  - `later`: the table has no writer yet, so it cannot hold a row; the task named adds its deletion (and a file's removal) when it adds the writer.
 */
export const TRIP_TABLES: readonly {
  readonly table: string;
  readonly action: 'delete' | 'unlink' | 'keep' | 'later';
  readonly task?: string;
}[] = [
  { table: 'trip_member', action: 'delete' },
  // The plan (9.2): a trip's stops, and the days of each.
  { table: 'stop', action: 'delete' },
  { table: 'day', action: 'delete' },
  // Things planned on a day (9.3).
  { table: 'item', action: 'delete' },
  // Files of the trip (9.5): the attachment rows and their `media` rows go with it, and **their files on disk after the transaction** (`removeTripRows` returns their ids).
  { table: 'attachment', action: 'delete' },
  // A trip's links (9.6): addresses it never fetches.
  { table: 'trip_link', action: 'delete' },
  // Waiting to link its people's check-ins again (9.7): nothing of a person, and no use once the trip is gone.
  { table: 'relink', action: 'delete' },
  // A trip's own places (9.2): the owner is the trip, so they go with it.
  { table: 'place', action: 'delete' },
  // Copies of check-ins shared with it (10.3): the originals are their authors' (`checkin`, unlinked below), and a copy has no use once the trip is gone.
  { table: 'shared_checkin', action: 'delete' },
  // A trip's deletions, told to its members' devices (6.6): no use once the trip is gone.
  { table: 'trip_tombstone', action: 'delete' },
  { table: 'checkin', action: 'unlink' },
  { table: 'notice', action: 'keep' },
  { table: 'media', action: 'delete' },
];

/** A table that names a **day**: its rows are removed with the day (a stop removed, or a day's date taken away), and **a day that has any is never removed silently**: shrinking a stop over it is refused, naming the day (DESIGN.md §10.4). Items are the first (9.3). */
export interface DayReference {
  readonly table: string;
  readonly column: string;
}
export const DAY_REFERENCES: readonly DayReference[] = [{ table: 'item', column: 'day_id' }];

/** A table of a trip's that names one of the trip's places: a place is removed with its stop **unless one of these still names it** (and items, 9.3, name a place too). */
export const PLACE_USERS: readonly DayReference[] = [
  { table: 'stop', column: 'place_id' },
  { table: 'item', column: 'place_id' },
];
