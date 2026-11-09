import { bigint, boolean, customType, text } from 'drizzle-orm/pg-core';

/**
 * The same column vocabulary as `schema/sqlite/columns.ts`; see there. PostgreSQL returns `bigint` as a string unless it is told a mode, so
 * every 64-bit column declares `mode: 'number'` (and the client parses `int8` the same way for raw SQL).
 */
export const id = (name: string) => text(name).primaryKey();

export const ref = (name: string) => text(name);

export const epochMs = (name: string) => bigint(name, { mode: 'number' });

export const counter = (name: string) => bigint(name, { mode: 'number' });

export const bool = (name: string) => boolean(name);

export const isoDate = (name: string) => text(name);

export const hhmm = (name: string) => text(name);

export const fields = (name: string) => text(name);

/**
 * PostgreSQL's default collation follows the database's locale, which orders "aA" and "aa" and "a1" by language rules. A position is only
 * meaningful compared byte by byte, as SQLite does, so the column says so.
 */
const collatedText = customType<{ data: string }>({
  dataType: () => 'text COLLATE "C"',
});
export const position = (name: string) => collatedText(name);

/** `bytea`: what a `Buffer` is stored as, and read back as, by `pg`. */
const bytes = customType<{ data: Buffer }>({ dataType: () => 'bytea' });
export const sealed = (name: string) => bytes(name);
