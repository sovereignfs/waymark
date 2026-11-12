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
  // A trip's own places (9.2): the owner is the trip, so they go with it.
  { table: 'place', action: 'delete' },
  { table: 'checkin', action: 'unlink' },
  { table: 'notice', action: 'keep' },
  // A trip's files (attachments, 9.5): their files on disk go with them, which needs the media store's removal, added with the first writer.
  { table: 'media', action: 'later', task: '9.5' },
];
