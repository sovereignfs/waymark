import { blob, integer, text } from 'drizzle-orm/sqlite-core';

/**
 * The column vocabulary every table is written in, so that a kind of value has one representation on both dialects (DESIGN.md §24.2).
 * `schema/postgres/columns.ts` exports the same names; the schema parity test keeps the two in step. A table names these and never a
 * dialect's own type.
 *
 * - `id`        a row's key: text, a UUID made by the client (§8.2).
 * - `ref`       a reference to another table's `id`: the same text, not a key itself.
 * - `epochMs`   a point in time as milliseconds since the epoch, a JS number: no time zones, no Date parsing, the same on both dialects.
 * - `counter`   a 64-bit whole number that is a JS number: a sequence, a count.
 * - `bool`      a boolean. SQLite stores 0 and 1, and reads it back as a JS boolean through the driver's mode; PostgreSQL has a boolean.
 * - `isoDate`   a calendar date as text, `YYYY-MM-DD`, in no time zone (§12). Text compares in date order.
 * - `hhmm`      a time of day as text, `HH:MM`, in no time zone. Text compares in time order.
 * - `fields`    JSON as text: a map of field name to `{ v }` or `{ c }` (§22.2). The server mostly does not read it.
 * - `position`  text compared byte by byte. SQLite's default comparison is by bytes; PostgreSQL's needs `COLLATE "C"`.
 * - `sealed`    the one envelope a table's sensitive fields are written in (DESIGN.md §18.1): binary, a `Buffer`, `blob` on SQLite and `bytea` on PostgreSQL.
 *               Only `src/crypto/sealed.ts` makes or opens one, and it is never in a `WHERE`, an `ORDER BY` or an index.
 */
export const id = (name: string) => text(name).primaryKey();

export const ref = (name: string) => text(name);

export const epochMs = (name: string) => integer(name, { mode: 'number' });

export const counter = (name: string) => integer(name, { mode: 'number' });

export const bool = (name: string) => integer(name, { mode: 'boolean' });

export const isoDate = (name: string) => text(name);

export const hhmm = (name: string) => text(name);

export const fields = (name: string) => text(name);

export const position = (name: string) => text(name);

export const sealed = (name: string) => blob(name, { mode: 'buffer' });
