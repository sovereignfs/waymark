import { randomBytes } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { getTableConfig as pgTableConfig, PgTable } from 'drizzle-orm/pg-core';
import { getTableConfig as sqliteTableConfig, SQLiteTable } from 'drizzle-orm/sqlite-core';
import { is, sql } from 'drizzle-orm';
import { sqliteTable } from 'drizzle-orm/sqlite-core';
import { describe, expect, it } from 'vitest';
import { CryptoError, sealBytes } from './envelope';
import { ringOf } from './keys';
import { SEALED, SealedFieldError, Sealer, type FieldSpec, type SealedTable } from './sealed';
import * as pgSchema from '../db/schema/postgres';
import * as sqliteSchema from '../db/schema/sqlite';
import * as sqliteColumns from '../db/schema/sqlite/columns';
import * as pgColumns from '../db/schema/postgres/columns';
import { dbAll, dbRun } from '../db/exec';
import { freshDatabase, testTarget } from '../db/test-support';

const ROOT = path.resolve(__dirname, '../..');
const ring = ringOf(randomBytes(32));
if (!ring) throw new Error('no ring');
const sealer = new Sealer(ring);
const tables = Object.keys(SEALED) as SealedTable[];

/** A value of each kind, with a word in it that must never be found in plain text. */
const SAMPLE = {
  string: 'PLANTED-WORD-Café-日本',
  number: 35.6586,
  strings: ['PLANTED-WORD-a', 'PLANTED-WORD-b'],
  json: { street: 'PLANTED-WORD street', nested: [1, 2, { ok: true }] },
};
const sampleOf = (table: SealedTable, only: 'all' | 'required' = 'all'): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(SEALED[table].fields as Record<string, FieldSpec>)
      .filter(([, spec]) => only === 'all' || !spec.optional)
      .map(([name, spec]) => [name, SAMPLE[spec.kind]]),
  );

describe('what each table seals', () => {
  it('is what DESIGN.md §24.3 says, word for word: the design and the declaration cannot drift apart', () => {
    const design = readFileSync(path.join(ROOT, 'DESIGN.md'), 'utf8');
    for (const table of tables) {
      const row = design.split('\n').find(
        (line) =>
          line.startsWith('|') &&
          (line.split('|')[1] ?? '')
            .split(',')
            .map((cell) => cell.trim())
            .includes(`\`${table}\``),
      );
      // `notice`, `notice_pref` and `mail_outbox` share a row ("addresses and content in (s)").
      expect(row, table).toBeDefined();
      expect(row, table).toContain(
        `(s) ${SEALED[table].design}`.replace(
          '(s) addresses and content',
          'addresses and content in (s)',
        ),
      );
    }
  });

  it('seals nothing a database must sort, join or count by: no declared field is an id, an owner, a moment, a zone, a kind, an order, a role or a size', () => {
    const plain = [
      'id',
      'accountId',
      'account_id',
      'tripId',
      'trip_id',
      'at',
      'tz',
      'offset',
      'kind',
      'position',
      'role',
      'seq',
      'version',
      'bytes',
      'createdAt',
      'updatedAt',
      'startDate',
      'endDate',
      'date',
      'start',
      'end',
    ];
    for (const table of tables)
      for (const name of Object.keys(SEALED[table].fields))
        expect(plain, `${table}.${name}`).not.toContain(name);
  });

  it('has every table of a later phase declared before it exists, and nothing for a table that is not sealed', () => {
    expect(tables.filter((t) => SEALED[t].phase === 1)).toEqual([
      'profile',
      'place',
      'checkin',
      'import_job',
      'notice',
      'mail_outbox',
      'core_outbox',
    ]);
    for (const table of [
      'account_stream',
      'media',
      'checkin_photo',
      'trip_member',
      'job_claim',
      'rate_bucket',
    ])
      expect(tables as string[], table).not.toContain(table);
  });
});

describe('sealing a row', () => {
  it.each(tables)('%s round-trips every field, and a row with only what is required', (table) => {
    for (const only of ['all', 'required'] as const) {
      const fields = sampleOf(table, only);
      const envelope = sealer.seal(table, 'row-1', fields as never);
      expect(sealer.unseal(table, 'row-1', envelope)).toEqual(fields);
      expect(envelope.toString('latin1')).not.toContain('PLANTED');
    }
  });

  it('keeps Unicode and a number exactly, and leaves out what is absent rather than making it up', () => {
    const place = sealer.unseal(
      'place',
      'p',
      sealer.seal('place', 'p', { name: 'Café 日本', lat: -33.8688, lng: 151.2093 }),
    );
    expect(place).toEqual({ name: 'Café 日本', lat: -33.8688, lng: 151.2093 });
    expect('address' in place).toBe(false);
  });

  it.each(tables)('%s does not open as another row, or as another table', (table) => {
    const envelope = sealer.seal(table, 'row-1', sampleOf(table) as never);
    expect(() => sealer.unseal(table, 'row-2', envelope)).toThrow(CryptoError);
    const other = tables.find((each) => each !== table) ?? table;
    expect(() => sealer.unseal(other, 'row-1', envelope)).toThrow(CryptoError);
  });

  it('refuses a field the table does not seal, a missing required field, and a value of the wrong kind, naming the field and never the value', () => {
    const secret = 'PLANTED-VALUE-NOT-IN-A-MESSAGE';
    const problems: string[] = [];
    for (const fields of [
      { name: 'x', lat: 1, lng: 2, country: secret },
      { lat: 1, lng: 2 },
      { name: secret, lat: 'north', lng: 2 },
      { name: 'x', lat: Number.NaN, lng: 2 },
      { name: 'x', lat: 1, lng: 2, address: null },
    ]) {
      try {
        sealer.seal('place', 'p', fields as never);
        problems.push('accepted');
      } catch (error) {
        expect(error).toBeInstanceOf(SealedFieldError);
        problems.push((error as Error).message);
      }
    }
    expect(problems.join('\n')).not.toContain('accepted');
    expect(problems.join('\n')).not.toContain(secret);
    expect(problems[0]).toContain('country');
    expect(problems[1]).toContain('name');
  });

  it('refuses to open an envelope whose plaintext is not the table’s fields, which is what a row written by something else would be', () => {
    // Sealed under the right key and binding, but by a caller that did not go through the declaration.
    const bytes = Buffer.from(JSON.stringify({ name: 'x', lat: 1, lng: 2, surprise: true }));
    const envelope = sealBytes(bytes, { id: 'p', purpose: 'place' }, ring.current);
    expect(() => sealer.unseal('place', 'p', envelope)).toThrow(SealedFieldError);
  });
});

describe('where sealed fields may and may not be', () => {
  /** Every table of both dialects' schemas, by name, with its columns and indexes. */
  const all = [
    ...Object.values(sqliteSchema)
      .filter((value) => is(value, SQLiteTable))
      .map((table) => ({ dialect: 'sqlite', config: sqliteTableConfig(table as SQLiteTable) })),
    ...Object.values(pgSchema)
      .filter((value) => is(value, PgTable))
      .map((table) => ({ dialect: 'postgres', config: pgTableConfig(table as PgTable) })),
  ];

  it('is a table with a `sealed` column only if it is declared, and a declared table that exists has one', () => {
    for (const { config, dialect } of all) {
      const has = config.columns.some((column) => column.name === 'sealed');
      expect(has, `${dialect} ${config.name}`).toBe(config.name in SEALED);
    }
  });

  it('never has a sealed field as a column, in either dialect', () => {
    for (const { config, dialect } of all) {
      const declared = (SEALED as Record<string, { fields: Record<string, unknown> }>)[config.name];
      if (!declared) continue;
      const columns = new Set(config.columns.map((column) => column.name));
      for (const name of Object.keys(declared.fields)) {
        const snake = name.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
        expect(columns.has(name) || columns.has(snake), `${dialect} ${config.name}.${name}`).toBe(
          false,
        );
      }
    }
  });

  it('never has the sealed column in an index or a key', () => {
    for (const { config, dialect } of all) {
      for (const index of config.indexes)
        expect(
          index.config.columns.map((column) => ('name' in column ? column.name : '')),
          `${dialect} ${config.name} ${index.config.name}`,
        ).not.toContain('sealed');
      for (const key of config.primaryKeys)
        expect(key.columns.map((column) => column.name)).not.toContain('sealed');
    }
  });

  /** The files whose SQL is read: everything under `src` and `app` but the tests. */
  const sources = (folder: string): string[] =>
    readdirSync(path.join(ROOT, folder)).flatMap((name) => {
      const relative = path.join(folder, name);
      if (statSync(path.join(ROOT, relative)).isDirectory()) return sources(relative);
      return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [relative] : [];
    });

  /** The SQL in `sql` templates that puts `sealed` where a statement decides what it finds, orders by or groups by. */
  function conditionsOnSealed(text: string): string[] {
    const offenders: string[] = [];
    for (const match of text.matchAll(/sql`([^`]*)`/g)) {
      const statement = match[1] ?? '';
      const after =
        /\b(WHERE|ORDER\s+BY|GROUP\s+BY|HAVING|JOIN|ON|CREATE\s+INDEX)\b([\s\S]*)/i.exec(
          statement,
        )?.[2] ?? '';
      if (/\bsealed\b/i.test(after)) offenders.push(statement.replace(/\s+/g, ' ').trim());
    }
    return offenders;
  }

  it('is in no statement’s WHERE, ORDER BY, GROUP BY, join or index: the source is read for it', () => {
    const offenders = [...sources('src'), ...sources('app')].flatMap((file) =>
      conditionsOnSealed(readFileSync(path.join(ROOT, file), 'utf8')).map((s) => `${file}: ${s}`),
    );
    expect(offenders).toEqual([]);
  });

  it('can fail: the reading finds a condition on the sealed column, and leaves a statement that only selects it', () => {
    expect(
      conditionsOnSealed('sql`SELECT id FROM place WHERE account_id = ${a} AND sealed = ${b}`'),
    ).toHaveLength(1);
    expect(conditionsOnSealed('sql`SELECT id FROM place ORDER BY sealed`')).toHaveLength(1);
    expect(
      conditionsOnSealed('sql`SELECT sealed FROM place WHERE id = ${id} AND account_id = ${a}`'),
    ).toEqual([]);
    expect(conditionsOnSealed('sql`INSERT INTO place (id, sealed) VALUES (${id}, ${s})`')).toEqual(
      [],
    );
  });
});

describe(`the raw database (${testTarget().leg})`, () => {
  it('holds no sealed field in plain text: a row written through the sealer, read straight from the database, and the file itself', async () => {
    const { database, config, leg } = await freshDatabase();
    try {
      const table = database.dialect === 'postgres' ? 'waymark_probe.sealed_probe' : 'sealed_probe';
      if (database.dialect === 'postgres') {
        await dbRun(database, sql`DROP SCHEMA IF EXISTS waymark_probe CASCADE`);
        await dbRun(database, sql`CREATE SCHEMA waymark_probe`);
      }
      const kind = database.dialect === 'postgres' ? 'bytea' : 'blob';
      await dbRun(
        database,
        sql.raw(
          `CREATE TABLE ${table} (id text PRIMARY KEY, account_id text NOT NULL, at bigint NOT NULL, sealed ${kind})`,
        ),
      );
      const fields = {
        name: 'PLANTED-WORD Tokyo Tower',
        lat: 35.6586,
        lng: 139.7454,
        category: 'PLANTED-WORD landmark',
      };
      const envelope = sealer.seal('place', 'p-1', fields);
      await dbRun(
        database,
        sql`INSERT INTO ${sql.raw(table)} (id, account_id, at, sealed) VALUES ('p-1', 'a-1', 1700000000000, ${envelope})`,
      );
      const rows = await dbAll<Record<string, unknown>>(
        database,
        sql`SELECT * FROM ${sql.raw(table)}`,
      );
      // The whole row, as the database gives it, with the envelope as bytes: nothing of the place is in any of it.
      const dump = JSON.stringify(rows, (_k, v) =>
        v instanceof ArrayBuffer
          ? Buffer.from(v).toString('latin1')
          : v?.type === 'Buffer'
            ? Buffer.from(v.data).toString('latin1')
            : v,
      );
      expect(dump).not.toContain('PLANTED');
      expect(dump).not.toContain('Tokyo');
      expect(dump).not.toContain('35.65');
      // And it opens, from what the database returned.
      const stored = rows[0]?.sealed;
      const back = Buffer.from(
        stored instanceof ArrayBuffer ? new Uint8Array(stored) : (stored as Buffer),
      );
      expect(sealer.unseal('place', 'p-1', back)).toEqual(fields);
      // A file database: the bytes on disk, the write-ahead log included, hold none of it either.
      if (leg === 'file' && config.dialect === 'sqlite' && config.form === 'file') {
        for (const suffix of ['', '-wal']) {
          let bytes = Buffer.alloc(0);
          try {
            bytes = readFileSync(`${config.path}${suffix}`);
          } catch {
            // No log: nothing to read.
          }
          expect(bytes.toString('latin1'), suffix || 'the file').not.toContain('PLANTED');
          expect(bytes.toString('latin1'), suffix || 'the file').not.toContain('Tokyo');
        }
      }
      if (database.dialect === 'postgres')
        await dbRun(database, sql`DROP SCHEMA IF EXISTS waymark_probe CASCADE`);
    } finally {
      await database.close();
    }
  });
});

// Kept so that the probe's table builder is not tree-shaken into an unused import in a leg that skips the raw test.
void sqliteTable;
void sqliteColumns;
void pgColumns;
