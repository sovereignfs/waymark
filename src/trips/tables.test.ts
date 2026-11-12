import { is } from 'drizzle-orm';
import { SQLiteTable, getTableConfig } from 'drizzle-orm/sqlite-core';
import { describe, expect, it } from 'vitest';
import * as sqliteSchema from '../db/schema/sqlite';
import { TRIP_TABLES } from './tables';

/** Deleting a trip must leave no row of it (DESIGN.md §10.1): every table with a `trip_id` is decided in `tables.ts`, by the task that makes it. */
describe('the tables that hold a trip’s rows', () => {
  const withTripId = Object.values(sqliteSchema)
    .filter((value) => is(value, SQLiteTable))
    .map((value) => value as SQLiteTable)
    .map((table) => getTableConfig(table))
    .filter((config) => config.columns.some((column) => column.name === 'trip_id'))
    .map((config) => config.name)
    .sort();

  it('are each decided: a table with a trip_id that is not listed fails here until its task says what happens to its rows', () => {
    const listed = TRIP_TABLES.map((each) => each.table).sort();
    expect(withTripId.filter((name) => !listed.includes(name))).toEqual([]);
  });

  it('name only tables that have a trip_id', () => {
    expect(
      TRIP_TABLES.map((each) => each.table).filter((name) => !withTripId.includes(name)),
    ).toEqual([]);
  });

  it('put off only what has no writer yet, and say which task adds it', () => {
    for (const each of TRIP_TABLES.filter((entry) => entry.action === 'later'))
      expect(each.task).toMatch(/^\d+\.\d+$/);
  });
});
