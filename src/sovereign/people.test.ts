import { randomBytes } from 'node:crypto';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { is, sql } from 'drizzle-orm';
import { SQLiteTable, getTableConfig } from 'drizzle-orm/sqlite-core';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type TwoAccounts, twoAccounts } from '../access/two-accounts';
import { Sealer } from '../crypto/sealed';
import { ringOf } from '../crypto/keys';
import type { Database } from '../db/client';
import { dbAll } from '../db/exec';
import * as sqliteSchema from '../db/schema/sqlite';
import { openAppBesideAuth, testTarget } from '../db/test-support';
import { RateLimiter } from '../limits/rate';
import { type MediaDeps, putMedia, readMedia, usageOf } from '../media/service';
import { listPlaces, makePlace } from '../places/places';
import { applyMutation } from '../sync/apply';
import { createProfile, getProfile } from '../profile/profile';
import { deletePerson } from './people';

/**
 * Deleting an account (DESIGN.md §23), on two real accounts and every table. **The test that keeps the routine whole:** it asks the schema for its tables, and a table that is
 * in none of the lists below fails it, so a new table that holds something of a person cannot be added without deciding what becomes of it. Then it seeds a row of each table
 * for the person and for a second person, runs the routine (twice), and finds nothing of the first, files included, and everything of the second intact.
 */
const { leg } = testTarget();
const ring = ringOf(randomBytes(32));
if (!ring) throw new Error('no ring');
const sealer = new Sealer(ring);

/** Tables whose rows are the person's, and go with them. */
const GOES = [
  'profile',
  'place',
  'checkin',
  'account_stream',
  'applied_mutation',
  'tombstone',
  'media',
  'rate_bucket',
  // The sign-in store.
  'user',
  'two_factor',
  'passkey',
  'session',
  'account',
  'verification',
];
/** Tables of shared work: their rows stay when the person goes. (Trips, from phase 2.) */
const STAYS: string[] = [];
/** Tables that are about something else than a person. */
const NOT_A_PERSON = ['job_claim', 'rate_limit'];

let t: TwoAccounts;
let database: Database;
let close: () => Promise<void>;
let directory: string;
let media: MediaDeps;
beforeAll(async () => {
  t = await twoAccounts();
  ({ database, close } = await openAppBesideAuth());
  directory = mkdtempSync(path.join(tmpdir(), 'waymark-people-'));
  media = {
    database,
    ring,
    dir: path.join(directory, 'media'),
    maxAccountBytes: 100 * 1024 * 1024,
    now: () => NOW,
  };
});
afterAll(async () => {
  await t.close();
  await close();
  rmSync(directory, { recursive: true, force: true });
});

const NOW = 1_800_000_000_000;
const id = () => crypto.randomUUID();
const app = (table: string) => (database.dialect === 'postgres' ? `waymark.${table}` : table);
const count = async (table: string, where: string): Promise<number> =>
  Number(
    (
      await dbAll<{ n: number | string }>(
        database,
        sql.raw(`SELECT COUNT(*) AS n FROM ${app(table)} WHERE ${where}`),
      )
    )[0]?.n ?? 0,
  );
const authTable = (name: string): string =>
  t.auth.database.dialect === 'postgres' ? `"waymark_auth"."${name}"` : `"${name}"`;
const authCount = async (table: string, where: string): Promise<number> =>
  Number(
    (
      await dbAll<{ n: number | string }>(
        t.auth.database,
        sql.raw(`SELECT COUNT(*) AS n FROM ${authTable(table)} WHERE ${where}`),
      )
    )[0]?.n ?? 0,
  );
/** A time as the sign-in store holds it: a date on PostgreSQL, milliseconds in SQLite. */
const authTime = (ms: number): Date | number =>
  t.auth.database.dialect === 'postgres' ? new Date(ms) : ms;
const files = () => {
  try {
    return readdirSync(media.dir).length;
  } catch {
    return 0;
  }
};
const picture = () =>
  sharp({ create: { width: 30, height: 20, channels: 3, background: { r: 20, g: 90, b: 40 } } })
    .jpeg()
    .toBuffer();

describe(`the tables (${leg})`, () => {
  it('are each decided: they go with the person, they stay as shared work, or they are not about a person', () => {
    const names = Object.values(sqliteSchema)
      .filter((each) => is(each, SQLiteTable))
      .map((each) => getTableConfig(each as SQLiteTable).name);
    expect(names.length).toBeGreaterThan(8);
    const decided = new Set([...GOES, ...STAYS, ...NOT_A_PERSON]);
    expect(
      names.filter((name) => !decided.has(name)),
      'a table nobody decided about',
    ).toEqual([]);
    expect(
      [...decided].filter((name) => !names.includes(name)),
      'a table that is not there',
    ).toEqual([]);
  });
});

describe(`deleting a person (${leg})`, () => {
  it('leaves nothing of them where it goes, files included, runs again with nothing to do, and leaves the other person whole', async () => {
    const [ada, grace] = [t.ada.id, t.grace.id];
    for (const [who, name, email] of [
      [ada, 'Ada Lovelace', t.ada.email],
      [grace, 'Grace Hopper', t.grace.email],
    ] as const)
      await createProfile(database, sealer, { accountId: who, name, email }, NOW);
    const made: Record<string, string[]> = { [ada]: [], [grace]: [] };
    for (const who of [ada, grace]) {
      const result = await putMedia(media, {
        accountId: who,
        kind: 'photo',
        bytes: await picture(),
      });
      if (!result.ok) throw new Error('could not seed a photo');
      made[who]?.push(result.id);
      await new RateLimiter(database).take(`media:upload:${who}`, { limit: 10, windowMs: 60_000 });
      for (const name of ['Tokyo Tower', 'Lisbon Cathedral'])
        await makePlace({ database, sealer, now: () => NOW }, who, { name, lat: 38.7, lng: -9.1 });
      // A check-in, through the one path, which leaves a counter, a record of the mutation and a tombstone for a delete.
      const there = (await listPlaces({ database, sealer }, who))[0];
      const row = (placeId: string) => ({
        placeId,
        at: NOW - 1000,
        tz: 'Europe/Lisbon',
        offsetMin: 0,
        companions: ['Ada'],
        tripId: null,
        linkSource: null,
        share: 'trip',
        source: 'live',
        note: 'hello',
      });
      for (const changes of [
        [{ table: 'checkin', op: 'put', id: `kept-${who}`, row: row(there?.id ?? '') }],
        [{ table: 'checkin', op: 'put', id: `gone-${who}`, row: row(there?.id ?? '') }],
        [{ table: 'checkin', op: 'delete', id: `gone-${who}` }],
      ])
        expect(
          (
            await applyMutation({ database, sealer, now: () => NOW }, who, {
              mutationId: id(),
              stream: 'account',
              changes,
            })
          ).status,
        ).toBe('applied');
    }
    // The sign-in store: a pending verification named by the address, a second factor and a passkey.
    await dbAll(
      t.auth.database,
      sql`INSERT INTO ${sql.raw(authTable('verification'))} (id, identifier, value, expires_at, created_at, updated_at) VALUES (${id()}, ${t.ada.email}, 'x', ${authTime(NOW)}, ${authTime(NOW)}, ${authTime(NOW)}) RETURNING id`,
    );
    for (const [table, columns, values] of [
      ['two_factor', 'id, secret, backup_codes, user_id', `'tf1', 's', 'b', '${ada}'`],
      [
        'passkey',
        'id, public_key, user_id, credential_id, counter, device_type, backed_up',
        `'pk1', 'k', '${ada}', 'c', 0, 'singleDevice', ${t.auth.database.dialect === 'postgres' ? 'false' : '0'}`,
      ],
    ] as const)
      await dbAll(
        t.auth.database,
        sql.raw(`INSERT INTO ${authTable(table)} (${columns}) VALUES (${values}) RETURNING id`),
      );
    expect(files()).toBe(4);
    expect(await authCount('session', `user_id = '${ada}'`)).toBeGreaterThan(0);

    const deps = { database, authDatabase: t.auth.database, media, now: () => NOW };
    expect(await deletePerson(deps, ada)).toEqual({ files: 2 });

    // Nothing of Ada, anywhere.
    expect(await getProfile(database, sealer, ada)).toBeUndefined();
    expect(await count('profile', `account_id = '${ada}'`)).toBe(0);
    expect(await count('media', `account_id = '${ada}'`)).toBe(0);
    expect(await count('place', `account_id = '${ada}'`)).toBe(0);
    for (const table of ['checkin', 'account_stream', 'applied_mutation', 'tombstone'])
      expect(await count(table, `account_id = '${ada}'`), table).toBe(0);
    expect(await listPlaces({ database, sealer }, ada)).toEqual([]);
    expect(await count('rate_bucket', `"key" LIKE '%:${ada}'`)).toBe(0);
    expect(await usageOf(database, ada)).toBe(0);
    for (const fileId of made[ada] ?? [])
      expect(await readMedia(media, { accountId: ada, id: fileId })).toBeUndefined();
    expect(files()).toBe(2);
    for (const [table, column] of [
      ['user', 'id'],
      ['session', 'user_id'],
      ['account', 'user_id'],
      ['two_factor', 'user_id'],
      ['passkey', 'user_id'],
    ] as const)
      expect(await authCount(table, `${column} = '${ada}'`), table).toBe(0);
    expect(
      await authCount('verification', `LOWER(identifier) = '${t.ada.email.toLowerCase()}'`),
    ).toBe(0);

    // Grace, whole.
    expect(await getProfile(database, sealer, grace)).toMatchObject({ name: 'Grace Hopper' });
    expect(await count('media', `account_id = '${grace}'`)).toBe(2);
    expect(await count('place', `account_id = '${grace}'`)).toBe(2);
    expect(await count('checkin', `account_id = '${grace}'`)).toBe(1);
    expect(await count('account_stream', `account_id = '${grace}'`)).toBe(1);
    expect(await count('applied_mutation', `account_id = '${grace}'`)).toBe(3);
    expect(await count('tombstone', `account_id = '${grace}'`)).toBe(1);
    expect(await count('rate_bucket', `"key" LIKE '%:${grace}'`)).toBe(1);
    expect(await readMedia(media, { accountId: grace, id: made[grace]?.[0] ?? '' })).toBeDefined();
    expect(await authCount('user', `id = '${grace}'`)).toBe(1);
    expect(await authCount('session', `user_id = '${grace}'`)).toBeGreaterThan(0);
    expect(await authCount('account', `user_id = '${grace}'`)).toBe(1);

    // Again: safe to run twice, and there is nothing left to do.
    expect(await deletePerson(deps, ada)).toEqual({ files: 0 });
    expect(await count('media', `account_id = '${grace}'`)).toBe(2);
  });

  it('finishes what a run that stopped part way left: the files are removed first, so the rows that name them are found again', async () => {
    const grace = t.grace.id;
    // A run that died after removing one file and before deleting the rows.
    const rows = await dbAll<{ id: string }>(
      database,
      sql.raw(`SELECT id FROM ${app('media')} WHERE account_id = '${grace}' ORDER BY id`),
    );
    expect(rows).toHaveLength(2);
    const { rm } = await import('node:fs/promises');
    await rm(path.join(media.dir, rows[0]?.id ?? ''), { force: true });
    expect(files()).toBe(1);
    const deps = { database, authDatabase: t.auth.database, media, now: () => NOW };
    expect(await deletePerson(deps, grace)).toEqual({ files: 2 });
    expect(files()).toBe(0);
    expect(await count('media', `account_id = '${grace}'`)).toBe(0);
    expect(await authCount('user', `id = '${grace}'`)).toBe(0);
  });
});
