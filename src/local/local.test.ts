import { randomBytes } from 'node:crypto';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkInAtNewPlace, checkInAtPlace, deleteCheckin, editCheckin } from '../actions/checkins';
import type { Context } from '../actions/types';
import { ringOf } from '../crypto/keys';
import { Sealer } from '../crypto/sealed';
import type { Database } from '../db/client';
import { makeStore, testTarget } from '../db/test-support';
import type { ApplyDeps } from '../sync/apply';
import { handleSync } from '../sync/endpoint';
import type { Mutation } from '../sync/format';
import { PROTOCOL_VERSION } from '../sync/format';
import { dbName, deleteLocal, openLocal } from './db';
import { LocalStore } from './store';
import { type Transport, syncOnce } from './sync';

/**
 * The device's store and its sync (DESIGN.md §15.1, §15.3), against the real server code and database of the leg: two devices of one account, each its own IndexedDB (an in-memory one), one of
 * them offline for a while, both ending with the same check-ins, and nothing lost on the way.
 */
const { leg } = testTarget();
const ring = ringOf(randomBytes(32));
if (!ring) throw new Error('no ring');
const sealer = new Sealer(ring);
const NOW = 1_800_000_000_000;

let database: Database;
let close: () => Promise<void>;
let deps: ApplyDeps;
beforeAll(async () => {
  ({ database, close } = await makeStore());
  deps = { database, sealer, now: () => NOW };
});
afterAll(async () => close());

let n = 0;
const account = () => `acct${++n}`;
const ctx = (): Context => ({
  ids: { newId: () => crypto.randomUUID() },
  now: NOW - 1000,
  deviceZone: 'Europe/Lisbon',
});

/** A device: its own IndexedDB, and a store open on it. The global the browser has is the factory `idb` opens, so it is set for the opening of each. */
async function device(accountId: string) {
  const factory = new IDBFactory();
  (globalThis as { indexedDB?: IDBFactory }).indexedDB = factory;
  const store = new LocalStore(await openLocal(accountId), () => NOW);
  return { store, factory };
}
type Device = Awaited<ReturnType<typeof device>>;

/** The server, as a transport: the real endpoint, in this process. `drop` throws after the server has done its work, which is a lost answer. */
const toServer =
  (
    accountId: string,
    behaviour: { offline?: boolean; dropAnswer?: boolean; status?: number } = {},
  ): Transport =>
  async (body) => {
    if (behaviour.offline) throw new Error('no network');
    if (behaviour.status) return { status: behaviour.status, json: null };
    const answer = await handleSync(deps, accountId, body);
    if (behaviour.dropAnswer) throw new Error('connection lost');
    return { status: answer.status, json: answer.body };
  };
const must = <T extends { ok: boolean }>(result: T) => {
  if (!result.ok) throw new Error(JSON.stringify(result));
  return result as Extract<T, { ok: true }>;
};
const names = async (d: Device) => (await d.store.view()).checkins.map((c) => c.note);

describe(`the device's store (${leg})`, () => {
  it('shows what was recorded at once, with no network, and keeps it in the order it was made', async () => {
    const a = await device(account());
    const first = must(
      checkInAtNewPlace({ name: 'Café', lat: 38.7, lng: -9.1 }, { note: 'one' }, ctx()),
    );
    await a.store.record(first.mutation);
    const place = (await a.store.view()).places[0];
    must(checkInAtPlace(place, { note: 'two' }, ctx()));
    await a.store.record(must(checkInAtPlace(place, { note: 'two' }, ctx())).mutation);
    expect((await a.store.view()).checkins.map((c) => c.note).sort()).toEqual(['one', 'two']);
    expect((await a.store.pending()).map((e) => e.mutationId)).toHaveLength(2);
    expect(await a.store.cursor()).toBe(0);
    // The rows themselves are the server's alone: nothing was written to them.
    expect((await a.store.rows()).checkins.size).toBe(0);
  });

  it('reads the rows and the outbox in one transaction, so that a sync settling cannot leave a check-in out of what is shown', async () => {
    const a = await device(account());
    await a.store.record(
      must(checkInAtNewPlace({ name: 'Café', lat: 38.7, lng: -9.1 }, { note: 'one' }, ctx()))
        .mutation,
    );
    const db = a.store.db as unknown as { transaction: (...args: unknown[]) => unknown };
    const original = db.transaction.bind(db);
    let opened = 0;
    db.transaction = (...args: unknown[]) => {
      opened++;
      return original(...args);
    };
    expect((await a.store.view()).checkins).toHaveLength(1);
    expect(opened).toBe(1);
  });

  it('is deleted, with its outbox laid over it, so a delete shows at once', async () => {
    const id = account();
    const a = await device(id);
    const made = must(
      checkInAtNewPlace({ name: 'Café', lat: 38.7, lng: -9.1 }, { note: 'x' }, ctx()),
    );
    await a.store.record(made.mutation);
    expect(await syncOnce(a.store, toServer(id))).toBe('ok');
    const row = (await a.store.view()).checkins[0];
    await a.store.record(must(deleteCheckin(row, ctx())).mutation);
    expect((await a.store.view()).checkins).toEqual([]);
    expect((await a.store.rows()).checkins.size).toBe(1); // the server's copy, until it says otherwise
    await syncOnce(a.store, toServer(id));
    expect((await a.store.rows()).checkins.size).toBe(0);
  });
});

describe(`two devices of one account (${leg})`, () => {
  it('end with the same check-ins, one having been offline, and nothing lost', async () => {
    const id = account();
    const [a, b] = [await device(id), await device(id)];
    // Both start from the same place.
    (globalThis as { indexedDB?: IDBFactory }).indexedDB = a.factory;
    await a.store.record(
      must(checkInAtNewPlace({ name: 'Home', lat: 38.7, lng: -9.1 }, { note: 'a: first' }, ctx()))
        .mutation,
    );
    expect(await syncOnce(a.store, toServer(id))).toBe('ok');
    expect(await syncOnce(b.store, toServer(id))).toBe('ok');
    expect(await names(b)).toEqual(['a: first']);

    // B is offline: it records, cannot send, and still shows what it did.
    const home = (await b.store.view()).places[0];
    await b.store.record(must(checkInAtPlace(home, { note: 'b: offline 1' }, ctx())).mutation);
    await b.store.record(must(checkInAtPlace(home, { note: 'b: offline 2' }, ctx())).mutation);
    expect(await syncOnce(b.store, toServer(id, { offline: true }))).toBe('offline');
    expect(await b.store.pendingCount()).toBe(2);
    expect((await names(b)).sort()).toEqual(['a: first', 'b: offline 1', 'b: offline 2']);

    // A, meanwhile, records and sends.
    await a.store.record(
      must(checkInAtPlace((await a.store.view()).places[0], { note: 'a: second' }, ctx())).mutation,
    );
    await syncOnce(a.store, toServer(id));

    // B comes back; then A catches up. Both end the same.
    expect(await syncOnce(b.store, toServer(id))).toBe('ok');
    expect(await syncOnce(a.store, toServer(id))).toBe('ok');
    const final = ['a: first', 'a: second', 'b: offline 1', 'b: offline 2'];
    expect((await names(a)).sort()).toEqual(final);
    expect((await names(b)).sort()).toEqual(final);
    expect((await a.store.view()).checkins.map((c) => c.id)).toEqual(
      (await b.store.view()).checkins.map((c) => c.id),
    );
    expect(await a.store.pendingCount()).toBe(0);
    expect(await b.store.pendingCount()).toBe(0);
  });

  it('end with the later edit of one check-in, whole, on both', async () => {
    const id = account();
    const [a, b] = [await device(id), await device(id)];
    await a.store.record(
      must(checkInAtNewPlace({ name: 'Home', lat: 38.7, lng: -9.1 }, { note: 'original' }, ctx()))
        .mutation,
    );
    await syncOnce(a.store, toServer(id));
    await syncOnce(b.store, toServer(id));
    await a.store.record(
      must(editCheckin((await a.store.view()).checkins[0], { note: 'from a' }, ctx())).mutation,
    );
    await b.store.record(
      must(editCheckin((await b.store.view()).checkins[0], { note: 'from b' }, ctx())).mutation,
    );
    await syncOnce(a.store, toServer(id));
    await syncOnce(b.store, toServer(id)); // b's edit reaches the server later: it stands
    await syncOnce(a.store, toServer(id));
    expect(await names(a)).toEqual(['from b']);
    expect(await names(b)).toEqual(['from b']);
  });

  it('delete on one reaches the other as a tombstone', async () => {
    const id = account();
    const [a, b] = [await device(id), await device(id)];
    await a.store.record(
      must(checkInAtNewPlace({ name: 'Home', lat: 38.7, lng: -9.1 }, { note: 'gone soon' }, ctx()))
        .mutation,
    );
    await syncOnce(a.store, toServer(id));
    await syncOnce(b.store, toServer(id));
    await a.store.record(must(deleteCheckin((await a.store.view()).checkins[0], ctx())).mutation);
    await syncOnce(a.store, toServer(id));
    await syncOnce(b.store, toServer(id));
    expect(await names(b)).toEqual([]);
  });
});

describe(`what goes wrong on the way (${leg})`, () => {
  it('loses nothing when the answer is lost: the outbox is sent again and the server says it has it', async () => {
    const id = account();
    const a = await device(id);
    await a.store.record(
      must(checkInAtNewPlace({ name: 'Home', lat: 38.7, lng: -9.1 }, { note: 'once' }, ctx()))
        .mutation,
    );
    expect(await syncOnce(a.store, toServer(id, { dropAnswer: true }))).toBe('offline');
    expect(await a.store.pendingCount()).toBe(1);
    expect(await syncOnce(a.store, toServer(id))).toBe('ok');
    expect(await a.store.pendingCount()).toBe(0);
    expect((await a.store.view()).checkins).toHaveLength(1);
    expect((await a.store.rows()).checkins.size).toBe(1);
  });

  it('keeps a refused mutation with its sentence, takes its rows out of what is shown, and sends the rest', async () => {
    const id = account();
    const a = await device(id);
    const good = must(
      checkInAtNewPlace({ name: 'Home', lat: 38.7, lng: -9.1 }, { note: 'fine' }, ctx()),
    ).mutation;
    // A check-in at a place that is not there.
    const home = must(checkInAtNewPlace({ name: 'Elsewhere', lat: 1, lng: 1 }, {}, ctx()));
    const place = {
      ...(home.mutation.changes[0] as { row: object }).row,
      id: 'no-such-place',
      version: 1,
    } as never;
    const bad = must(checkInAtPlace(place, { note: 'doomed' }, ctx())).mutation;
    await a.store.record(bad);
    await a.store.record(good);
    expect((await names(a)).sort()).toEqual(['doomed', 'fine']);
    expect(await syncOnce(a.store, toServer(id))).toBe('ok');
    expect(await names(a)).toEqual(['fine']);
    const refused = await a.store.refused();
    expect(refused).toHaveLength(1);
    expect(refused[0]).toMatchObject({
      mutationId: bad.mutationId,
      reason: 'place_missing',
      sentence: 'A check-in needs a place.',
    });
    expect((refused[0]?.mutation as Mutation).changes).toEqual(bad.changes);
    expect(await a.store.pendingCount()).toBe(0);
  });

  it('keeps the outbox when the session has ended, when the app is too old, when the server is busy or broken', async () => {
    const id = account();
    const a = await device(id);
    await a.store.record(
      must(checkInAtNewPlace({ name: 'Home', lat: 38.7, lng: -9.1 }, { note: 'kept' }, ctx()))
        .mutation,
    );
    for (const [status, state] of [
      [401, 'signed_out'],
      [426, 'update_required'],
      [429, 'busy'],
      [503, 'offline'],
      [500, 'offline'],
      [403, 'error'],
    ] as const) {
      expect(await syncOnce(a.store, toServer(id, { status })), String(status)).toBe(state);
      expect(await a.store.pendingCount()).toBe(1);
    }
    // An answer that is not the protocol's is not trusted, and the outbox stays.
    expect(
      await syncOnce(a.store, async () => ({
        status: 200,
        json: { protocol: PROTOCOL_VERSION + 1 },
      })),
    ).toBe('error');
    expect(await syncOnce(a.store, async () => ({ status: 200, json: 'html' }))).toBe('error');
    expect(await a.store.pendingCount()).toBe(1);
    expect(await syncOnce(a.store, toServer(id))).toBe('ok');
    expect(await a.store.pendingCount()).toBe(0);
  });

  it('sends more than a request carries in turns, and pulls a long stream in pages, until both are done', async () => {
    const id = account();
    const a = await device(id);
    const home = must(
      checkInAtNewPlace({ name: 'Home', lat: 38.7, lng: -9.1 }, { note: 'c0' }, ctx()),
    );
    await a.store.record(home.mutation);
    await syncOnce(a.store, toServer(id));
    const place = (await a.store.view()).places[0];
    for (let i = 1; i <= 60; i++)
      await a.store.record(must(checkInAtPlace(place, { note: `c${i}` }, ctx())).mutation);
    expect(await a.store.pendingCount()).toBe(60);
    expect(await syncOnce(a.store, toServer(id), { limit: 7 })).toBe('ok');
    expect(await a.store.pendingCount()).toBe(0);
    const fresh = await device(id);
    expect(await syncOnce(fresh.store, toServer(id), { limit: 7 })).toBe('ok');
    expect((await fresh.store.view()).checkins).toHaveLength(61);
    expect((await fresh.store.view()).checkins.map((c) => c.id)).toEqual(
      (await a.store.view()).checkins.map((c) => c.id),
    );
  });

  it('shows what is still waiting on top of what the server says, after a pull', async () => {
    const id = account();
    const [a, b] = [await device(id), await device(id)];
    await a.store.record(
      must(
        checkInAtNewPlace(
          { name: 'Home', lat: 38.7, lng: -9.1 },
          { note: 'server has this' },
          ctx(),
        ),
      ).mutation,
    );
    await syncOnce(a.store, toServer(id));
    await syncOnce(b.store, toServer(id));
    await b.store.record(
      must(editCheckin((await b.store.view()).checkins[0], { note: 'b’s edit, not sent' }, ctx()))
        .mutation,
    );
    await a.store.record(
      must(editCheckin((await a.store.view()).checkins[0], { note: 'a’s edit' }, ctx())).mutation,
    );
    await syncOnce(a.store, toServer(id));
    // b pulls while offline-for-sending: its edit is still waiting, and still what it shows.
    await syncOnce(b.store, toServer(id, { status: 503 }));
    expect(await names(b)).toEqual(['b’s edit, not sent']);
    expect(await b.store.pendingCount()).toBe(1);
  });
});

describe(`Couldn't sync (${leg})`, () => {
  /** A check-in at a place the server does not have, refused with a sentence, kept on the device. */
  async function refusedOne(id: string) {
    const a = await device(id);
    const home = must(checkInAtNewPlace({ name: 'Elsewhere', lat: 1, lng: 1 }, {}, ctx()));
    const place = {
      ...(home.mutation.changes[0] as { row: object }).row,
      id: 'no-such-place',
      version: 1,
    } as never;
    const bad = must(checkInAtPlace(place, { note: 'doomed' }, ctx())).mutation;
    await a.store.record(bad);
    await syncOnce(a.store, toServer(id));
    return { a, bad };
  }

  it('is sent again when it is mended, and then is no longer refused, and the check-in reaches the server', async () => {
    const id = account();
    const { a, bad } = await refusedOne(id);
    expect((await a.store.refused()).map((r) => r.mutationId)).toEqual([bad.mutationId]);
    // Mended: the place it was at is made. Sending the same mutation again is applied, with the id it had.
    await a.store.record(
      must(
        checkInAtNewPlace(
          { name: 'Mended', lat: 1, lng: 1 },
          {},
          {
            ...ctx(),
            ids: {
              newId: (
                (ids) => () =>
                  ids.shift() ?? crypto.randomUUID()
              )(['no-such-place']),
            },
          },
        ),
      ).mutation,
    );
    expect(await syncOnce(a.store, toServer(id))).toBe('ok');
    expect(await a.store.retryRefused(bad.mutationId)).toBe(true);
    expect(await a.store.refused()).toEqual([]);
    expect(await a.store.pendingCount()).toBe(1);
    expect(await syncOnce(a.store, toServer(id))).toBe('ok');
    expect(await a.store.refused()).toEqual([]);
    expect(await names(a)).toContain('doomed');
    expect(await a.store.retryRefused(bad.mutationId)).toBe(false);
  });

  it('goes to the end of the outbox, still refused if nothing was mended, back in Couldn’t sync with its sentence', async () => {
    const id = account();
    const { a, bad } = await refusedOne(id);
    await a.store.retryRefused(bad.mutationId);
    expect(await names(a)).toEqual(['doomed']); // shown again while it waits
    await syncOnce(a.store, toServer(id));
    const again = await a.store.refused();
    expect(again).toHaveLength(1);
    expect(again[0]).toMatchObject({
      mutationId: bad.mutationId,
      sentence: 'A check-in needs a place.',
    });
    expect(await names(a)).toEqual([]);
  });

  it('is thrown away only when the person says so, and then it is gone for good', async () => {
    const id = account();
    const { a, bad } = await refusedOne(id);
    expect(await syncOnce(a.store, toServer(id))).toBe('ok'); // another sync does not touch it
    expect(await a.store.refused()).toHaveLength(1);
    expect(await a.store.discardRefused(bad.mutationId)).toBe(true);
    expect(await a.store.refused()).toEqual([]);
    expect(await a.store.pendingCount()).toBe(0);
    expect(await a.store.discardRefused(bad.mutationId)).toBe(false);
  });
});

describe(`signing out (${leg})`, () => {
  it('deletes the account’s database from the browser, and leaves another account’s', async () => {
    const [mine, other] = [account(), account()];
    const a = await device(mine);
    const factory = a.factory;
    (globalThis as { indexedDB?: IDBFactory }).indexedDB = factory;
    const otherStore = new LocalStore(await openLocal(other));
    await a.store.record(
      must(checkInAtNewPlace({ name: 'Home', lat: 38.7, lng: -9.1 }, { note: 'mine' }, ctx()))
        .mutation,
    );
    expect((await factory.databases()).map((d) => d.name).sort()).toEqual(
      [dbName(mine), dbName(other)].sort(),
    );
    a.store.close();
    await deleteLocal(mine);
    expect((await factory.databases()).map((d) => d.name)).toEqual([dbName(other)]);
    otherStore.close();
    // A new one for the same account starts empty.
    const again = new LocalStore(await openLocal(mine));
    expect((await again.view()).checkins).toEqual([]);
    expect(await again.pendingCount()).toBe(0);
  });

  it('is not an account id that can be made to name another database', async () => {
    for (const bad of ['', '../x', 'a b', 'a/b', 'x'.repeat(129)])
      await expect(openLocal(bad)).rejects.toThrow();
    await deleteLocal('../x'); // nothing to delete, and nothing thrown
  });
});
