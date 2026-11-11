import 'fake-indexeddb/auto';
import { randomBytes, randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { IDBFactory } from 'fake-indexeddb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkInAtNewPlace, checkInAtPlace, deleteCheckin } from '../actions/checkins';
import type { Context } from '../actions/types';
import { ringOf } from '../crypto/keys';
import { Sealer } from '../crypto/sealed';
import type { Database } from '../db/client';
import { dbGet, dbRun } from '../db/exec';
import { makeStore, testTarget } from '../db/test-support';
import { openLocal } from '../local/db';
import { LocalStore } from '../local/store';
import { type Transport, syncOnce } from '../local/sync';
import { type ApplyDeps, applyMutation } from './apply';
import { handleSync } from './endpoint';
import { PROTOCOL_VERSION } from './format';
import { KEEP_MS, pruneHistory } from './history';

/**
 * Keeping the history small (DESIGN.md §15.8), on whichever database the leg runs on: tombstones and applied-mutation records go after ninety days, the floor rises with them, and a device behind
 * the floor sends its outbox and then is given a fresh snapshot, ending with the right rows and nothing lost.
 */
const { leg } = testTarget();
const ring = ringOf(randomBytes(32));
if (!ring) throw new Error('no ring');
const sealer = new Sealer(ring);
const DAY = 24 * 60 * 60 * 1000;
let NOW = 1_800_000_000_000;

let database: Database;
let close: () => Promise<void>;
let deps: ApplyDeps;
beforeAll(async () => {
  ({ database, close } = await makeStore());
  deps = { database, sealer, now: () => NOW };
});
afterAll(async () => close());
const tbl = (name: string) => sql.raw(database.dialect === 'postgres' ? `waymark.${name}` : name);
let n = 0;
const account = () => `history${++n}`;
const ctx = (): Context => ({
  ids: { newId: () => randomUUID() },
  now: NOW - 1000,
  deviceZone: 'Europe/Lisbon',
});
const must = <T extends { ok: boolean }>(result: T) => {
  if (!result.ok) throw new Error(JSON.stringify(result));
  return result as Extract<T, { ok: true }>;
};
const count = async (table: string, who: string) =>
  Number(
    (
      await dbGet<{ n: number | string }>(
        database,
        sql`SELECT COUNT(*) AS n FROM ${tbl(table)} WHERE account_id = ${who}`,
      )
    )?.n,
  );
const floorOf = async (who: string) =>
  Number(
    (
      await dbGet<{ floor: number | string }>(
        database,
        sql`SELECT floor FROM ${tbl('account_stream')} WHERE account_id = ${who}`,
      )
    )?.floor ?? 0,
  );

/** A person who made a check-in and deleted it, `ago` before NOW: a tombstone, and the records of two mutations. */
async function deletedCheckin(who: string, ago: number) {
  const before = NOW;
  NOW -= ago;
  const made = must(
    checkInAtNewPlace({ name: 'Home', lat: 38.7, lng: -9.1 }, { note: 'forget me' }, ctx()),
  );
  await applyMutation(deps, who, made.mutation);
  const checkinId = made.created.checkinId as string;
  const gone = await applyMutation(deps, who, {
    mutationId: randomUUID(),
    stream: 'account',
    changes: [{ table: 'checkin', op: 'delete', id: checkinId }],
  });
  NOW = before;
  return { checkinId, seq: gone.status === 'applied' ? gone.seq : -1 };
}

describe(`pruning (${leg})`, () => {
  it('removes tombstones and mutation records older than ninety days, keeps the newer, and raises the floor to the highest number it removed', async () => {
    const who = account();
    const old = await deletedCheckin(who, 120 * DAY);
    const recent = await deletedCheckin(who, 10 * DAY);
    expect(await count('tombstone', who)).toBe(2);
    expect(await count('applied_mutation', who)).toBe(4);
    const pruned = await pruneHistory(database, NOW);
    expect(pruned.tombstones).toBeGreaterThanOrEqual(1);
    expect(await count('tombstone', who)).toBe(1);
    expect(await count('applied_mutation', who)).toBe(2);
    expect(await floorOf(who)).toBe(old.seq);
    expect(old.seq).toBeLessThan(recent.seq);
    // The recent tombstone is still there for a device that was only away a few days.
    const left = await dbGet<{ rowId: string }>(
      database,
      sql`SELECT row_id AS "rowId" FROM ${tbl('tombstone')} WHERE account_id = ${who}`,
    );
    expect(left?.rowId).toBe(recent.checkinId);
  });

  it('never lowers a floor, leaves another account’s alone, and does nothing the second time', async () => {
    const [who, other] = [account(), account()];
    const first = await deletedCheckin(who, 200 * DAY);
    await applyMutation(
      deps,
      other,
      must(checkInAtNewPlace({ name: 'Else', lat: 1, lng: 1 }, {}, ctx())).mutation,
    );
    await pruneHistory(database, NOW);
    expect(await floorOf(who)).toBe(first.seq);
    expect(await floorOf(other)).toBe(0);
    expect(await count('applied_mutation', other)).toBe(1);
    expect(await pruneHistory(database, NOW)).toMatchObject({ tombstones: 0, raised: 0 });
    expect(await floorOf(who)).toBe(first.seq);
  });

  it('is by the clock it is given: nothing is old enough now, and everything is in a hundred days', async () => {
    const who = account();
    await deletedCheckin(who, 1 * DAY);
    expect(await pruneHistory(database, NOW, KEEP_MS)).toMatchObject({ raised: 0 });
    expect(await count('tombstone', who)).toBe(1);
    await pruneHistory(database, NOW + 100 * DAY);
    expect(await count('tombstone', who)).toBe(0);
    expect(await floorOf(who)).toBeGreaterThan(0);
  });
});

describe(`a device behind the floor (${leg})`, () => {
  const toServer =
    (who: string, seen: { resets: number }): Transport =>
    async (body) => {
      const answer = await handleSync(deps, who, body);
      if (answer.status === 200 && answer.body.account.reset) seen.resets++;
      return { status: answer.status, json: answer.body };
    };
  async function device(who: string) {
    (globalThis as { indexedDB?: IDBFactory }).indexedDB = new IDBFactory();
    return new LocalStore(await openLocal(who), () => NOW);
  }
  const notes = async (d: LocalStore) => (await d.view()).checkins.map((c) => c.note).sort();

  it('sends its outbox and then is given a fresh snapshot, and ends with the right rows and nothing lost from the outbox', async () => {
    const who = account();
    const seen = { resets: 0 };
    const [a, b] = [await device(who), await device(who)];
    // A makes two check-ins and both devices have them.
    const home = must(
      checkInAtNewPlace({ name: 'Home', lat: 38.7, lng: -9.1 }, { note: 'keep' }, ctx()),
    );
    await a.record(home.mutation);
    await syncOnce(a, toServer(who, seen));
    const place = (await a.view()).places[0];
    await a.record(must(checkInAtPlace(place, { note: 'delete me' }, ctx())).mutation);
    await syncOnce(a, toServer(who, seen));
    await syncOnce(b, toServer(who, seen));
    expect(await notes(a)).toEqual(['delete me', 'keep']);
    const staleCursor = await a.cursor();

    // A goes away. B deletes one and adds one, and the deletion is ninety days old by the time A comes back.
    const doomed = (await b.view()).checkins.find((c) => c.note === 'delete me');
    await b.record(must(deleteCheckin(doomed, ctx())).mutation);
    await b.record(
      must(checkInAtPlace((await b.view()).places[0], { note: 'while a was away' }, ctx()))
        .mutation,
    );
    await syncOnce(b, toServer(who, seen));
    NOW += 100 * DAY;
    await pruneHistory(database, NOW);
    expect(await floorOf(who)).toBeGreaterThan(0);

    // A records while away; it still holds the deleted check-in and an old cursor.
    await a.record(
      must(checkInAtPlace(place, { note: 'recorded offline' }, { ...ctx(), now: NOW - 1000 }))
        .mutation,
    );
    expect(await notes(a)).toEqual(['delete me', 'keep', 'recorded offline']);
    expect(await a.floor()).toBe(0);

    // It comes back: its outbox is applied first, then the snapshot replaces its rows.
    expect(await syncOnce(a, toServer(who, seen))).toBe('ok');
    expect(seen.resets).toBe(1);
    expect(await a.pendingCount()).toBe(0);
    expect(await notes(a)).toEqual(['keep', 'recorded offline', 'while a was away']);
    expect(await a.cursor()).toBeGreaterThan(staleCursor);
    expect(await a.floor()).toBe(await floorOf(who));
    // B catches up, and both end the same.
    await syncOnce(b, toServer(who, seen));
    expect(await notes(b)).toEqual(await notes(a));
    expect((await a.view()).checkins.map((c) => c.id)).toEqual(
      (await b.view()).checkins.map((c) => c.id),
    );
  });

  it('is given the snapshot once, however many pages it takes, and not again', async () => {
    const who = account();
    const seen = { resets: 0 };
    const a = await device(who);
    await deletedCheckin(who, 200 * DAY);
    const place = randomUUID();
    const made = must(
      checkInAtNewPlace(
        { name: 'Home', lat: 38.7, lng: -9.1 },
        { note: 'c0' },
        {
          ...ctx(),
          ids: {
            newId: (
              (ids) => () =>
                ids.shift() ?? randomUUID()
            )([place]),
          },
        },
      ),
    );
    await applyMutation(deps, who, made.mutation);
    for (let i = 1; i <= 8; i++)
      await applyMutation(
        deps,
        who,
        must(
          checkInAtPlace(
            {
              ...(made.mutation.changes[0] as { row: object }).row,
              id: place,
              version: 1,
            } as never,
            { note: `c${i}` },
            ctx(),
          ),
        ).mutation,
      );
    await pruneHistory(database, NOW);
    expect(await syncOnce(a, toServer(who, seen), { limit: 3 })).toBe('ok');
    expect(seen.resets).toBe(1); // the first page began it; the rest went on from the cursor
    expect((await a.view()).checkins).toHaveLength(9);
    expect(await syncOnce(a, toServer(who, seen), { limit: 3 })).toBe('ok');
    expect(seen.resets).toBe(1);
  });

  it('is not given a snapshot when the floor is what it has seen, or when nothing was ever pruned', async () => {
    const who = account();
    const seen = { resets: 0 };
    const a = await device(who);
    await a.record(
      must(checkInAtNewPlace({ name: 'Home', lat: 38.7, lng: -9.1 }, {}, ctx())).mutation,
    );
    await syncOnce(a, toServer(who, seen));
    await syncOnce(a, toServer(who, seen));
    expect(seen.resets).toBe(0);
  });

  it('refuses a floor that is not one', async () => {
    const who = account();
    for (const floor of [-1, 1.5, '2'])
      expect(
        await handleSync(deps, who, { protocol: PROTOCOL_VERSION, outbox: [], cursor: 0, floor }),
      ).toEqual({
        status: 400,
        body: { code: 'BAD_REQUEST' },
      });
  });
});

describe('what a person deleted with their account', () => {
  it('leaves nothing behind in the floor: the stream row goes with the account', async () => {
    const who = account();
    await deletedCheckin(who, 200 * DAY);
    await pruneHistory(database, NOW);
    expect(await floorOf(who)).toBeGreaterThan(0);
    await dbRun(database, sql`DELETE FROM ${tbl('account_stream')} WHERE account_id = ${who}`);
    expect(await floorOf(who)).toBe(0);
  });
});
