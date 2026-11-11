import { randomBytes, randomUUID } from 'node:crypto';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { tableOf } from '../access/trip';
import { createItem, deleteItem, editDay, editItem, moveItem } from '../actions/items';
import type { Context } from '../actions/types';
import { DEFAULT_LIMITS } from '../config';
import { ringOf } from '../crypto/keys';
import { Sealer } from '../crypto/sealed';
import type { Database } from '../db/client';
import { dbAll } from '../db/exec';
import { makeStore, testTarget } from '../db/test-support';
import { setShareChoice } from '../sharing/choice';
import { applyMutation, type ApplyDeps } from '../sync/apply';
import { handleSync } from '../sync/endpoint';
import { KEEP_MS, pruneHistory } from '../sync/history';
import { setRole } from '../trips/members';
import { addStop, deleteItem as deleteItemOnline } from '../trips/plan';
import { createTrip, deleteTrip } from '../trips/trips';
import { openDB } from 'idb';
import { dbName, deleteLocal, openLocal } from './db';
import { describeMutation } from './describe';
import { LocalStore } from './store';
import { type Transport, syncOnce } from './sync';

/**
 * A trip on the device (DESIGN.md §15.1–§15.4), against the real server code and database of the leg: each member's device holds the trips they are in, as their role may see them; items and days' words are made offline and shown at once;
 * two Travelers editing one item end with the later edit; a Traveler made a Follower between syncs has the change kept in Couldn't sync; a Follower's device never holds an attachment.
 */
const { leg } = testTarget();
const ring = ringOf(randomBytes(32));
if (!ring) throw new Error('no ring');
const sealer = new Sealer(ring);
let clock = Date.parse('2026-09-01T12:00:00Z');
const [ADA, SAM, GRACE, NOOR, STRANGER] = ['ada', 'sam', 'grace', 'noor', 'stranger'];
let database: Database;
let close: () => Promise<void>;
let deps: ApplyDeps;
let tripDeps: {
  database: Database;
  sealer: Sealer;
  now: () => number;
  limits: typeof DEFAULT_LIMITS;
};
const t = (name: string) => tableOf(database, name);
const LISBON = { name: 'Lisbon', lat: 38.7223, lng: -9.1393 };
const ctx = (): Context => ({
  ids: { newId: () => randomUUID() },
  now: clock,
  deviceZone: 'Europe/Lisbon',
});
const must = <T extends { ok: boolean }>(result: T) => {
  if (!result.ok) throw new Error(JSON.stringify(result));
  return result as Extract<T, { ok: true }>;
};

async function device(accountId: string) {
  const factory = new IDBFactory();
  (globalThis as { indexedDB?: IDBFactory }).indexedDB = factory;
  return { store: new LocalStore(await openLocal(accountId), () => clock), accountId };
}
type Device = Awaited<ReturnType<typeof device>>;
const toServer =
  (accountId: string, offline = false): Transport =>
  async (body) => {
    if (offline) throw new Error('no network');
    const answer = await handleSync(deps, accountId, body);
    return { status: answer.status, json: answer.body };
  };
const sync = (d: Device, limit?: number) =>
  syncOnce(d.store, toServer(d.accountId), limit ? { limit } : {});

async function trip() {
  const made = await createTrip(tripDeps, ADA, { name: 'Iberia' });
  for (const [who, role] of [
    [SAM, 'traveler'],
    [GRACE, 'traveler'],
    [NOOR, 'follower'],
  ] as const)
    await dbAll(
      database,
      sql`INSERT INTO ${t('trip_member')} (trip_id, account_id, role, going, share_checkins, joined_at, seq) VALUES (${made.id}, ${who}, ${role}, ${role === 'traveler'}, 'ask', ${clock}, 2) RETURNING trip_id`,
    );
  await addStop(tripDeps, ADA, made.id, {
    place: LISBON,
    arrive: '2026-05-10',
    depart: '2026-05-12',
  });
  const days = (
    await dbAll<{ id: string }>(
      database,
      sql`SELECT id FROM ${t('day')} WHERE trip_id = ${made.id} ORDER BY date`,
    )
  ).map((row) => row.id) as [string, string, string];
  return { tripId: made.id, days };
}
const titles = async (d: Device, tripId: string) =>
  ((await d.store.tripView(tripId, d.accountId))?.items ?? []).map((item) => item.title);

beforeAll(async () => {
  ({ database, close } = await makeStore());
  deps = { database, sealer, now: () => clock };
  tripDeps = { database, sealer, now: () => ++clock, limits: DEFAULT_LIMITS };
});
afterAll(async () => close());
beforeEach(async () => {
  for (const table of [
    'trip_tombstone',
    'shared_checkin',
    'notice',
    'notice_pref',
    'relink',
    'checkin',
    'account_stream',
    'applied_mutation',
    'tombstone',
    'attachment',
    'media',
    'trip_link',
    'item',
    'day',
    'stop',
    'place',
    'trip_member',
    'trip',
    'profile',
  ])
    await dbAll(database, sql`DELETE FROM ${t(table)} RETURNING 1 AS gone`);
});

describe(`a trip on the device (${leg})`, () => {
  it('holds the trips its account is in, whole: the trip, members, stops, days and items; and nothing of a trip it is not in', async () => {
    const { tripId, days } = await trip();
    const sam = await device(SAM);
    const ada = await device(ADA);
    await ada.store.record(
      must(createItem(tripId, days[0], { title: 'Dinner', kind: 'food' }, [], null, ctx()))
        .mutation,
    );
    await sync(ada);
    expect(await sync(sam)).toBe('ok');
    const view = await sam.store.tripView(tripId, SAM);
    expect(view?.role).toBe('traveler');
    expect(view?.sets?.trip.name).toBe('Iberia');
    expect(view?.sets?.members).toHaveLength(4);
    expect(view?.sets?.stops).toHaveLength(1);
    expect(view?.days.map((d) => d.id)).toEqual(days);
    expect(view?.items.map((i) => i.title)).toEqual(['Dinner']);
    const stranger = await device(STRANGER);
    await sync(stranger);
    expect(await stranger.store.trips()).toEqual([]);
    expect(await stranger.store.tripView(tripId, STRANGER)).toBeUndefined();
  });

  it('shows an item made with no network at once, sends it when there is one, and the other members have it', async () => {
    const { tripId, days } = await trip();
    const sam = await device(SAM);
    const grace = await device(GRACE);
    await sync(sam);
    await sync(grace);
    const offline = syncOnce(sam.store, toServer(SAM, true));
    expect(await offline).toBe('offline');
    await sam.store.record(
      must(createItem(tripId, days[1], { title: 'Walk', kind: 'activity' }, [], null, ctx()))
        .mutation,
    );
    expect(await titles(sam, tripId)).toEqual(['Walk']);
    expect(await titles(grace, tripId)).toEqual([]);
    expect(await sync(sam)).toBe('ok');
    expect(await sam.store.pendingCount()).toBe(0);
    expect(await sync(grace)).toBe('ok');
    expect(await titles(grace, tripId)).toEqual(['Walk']);
    // Moved, edited, and deleted by Grace; Sam hears of each.
    const walk = (await grace.store.tripView(tripId, GRACE))?.items[0];
    if (!walk) throw new Error('no item');
    await grace.store.record(must(editItem(tripId, walk, { title: 'Long walk' }, ctx())).mutation);
    await sync(grace);
    await sync(sam);
    expect(await titles(sam, tripId)).toEqual(['Long walk']);
    const edited = (await sam.store.tripView(tripId, SAM))?.items[0];
    if (!edited) throw new Error('no item');
    await grace.store.record(must(deleteItem(tripId, walk.id, ctx())).mutation);
    await sync(grace);
    await sync(sam);
    expect(await titles(sam, tripId)).toEqual([]);
    expect(edited.updatedBy).toBe(GRACE);
  });

  it('two Travelers editing one item end with the later edit, on both devices, and the earlier author is told', async () => {
    const { tripId, days } = await trip();
    const sam = await device(SAM);
    const grace = await device(GRACE);
    await sam.store.record(
      must(createItem(tripId, days[0], { title: 'Dinner' }, [], null, ctx())).mutation,
    );
    await sync(sam);
    await sync(grace);
    const samItem = (await sam.store.tripView(tripId, SAM))?.items[0];
    const graceItem = (await grace.store.tripView(tripId, GRACE))?.items[0];
    if (!samItem || !graceItem) throw new Error('no item');
    // Both offline, both edit from version 1; Sam's reaches the server first.
    await sam.store.record(
      must(editItem(tripId, samItem, { title: 'Dinner at 8', notes: 'book a table' }, ctx()))
        .mutation,
    );
    await grace.store.record(
      must(editItem(tripId, graceItem, { title: 'Dinner at 9' }, ctx())).mutation,
    );
    expect(await titles(sam, tripId)).toEqual(['Dinner at 8']);
    await sync(sam);
    await sync(grace);
    await sync(sam);
    expect(await titles(sam, tripId)).toEqual(['Dinner at 9']);
    expect(await titles(grace, tripId)).toEqual(['Dinner at 9']);
    expect((await sam.store.tripView(tripId, SAM))?.items[0]).toMatchObject({
      notes: undefined,
      version: 3,
      updatedBy: GRACE,
    });
    const { listNotices } = await import('../notices/notices');
    const told = await listNotices({ database, sealer }, SAM, 10);
    expect(told.map((n) => n.kind)).toEqual(['edit_replaced']);
    expect(JSON.stringify(told)).toContain('book a table');
    expect(await listNotices({ database, sealer }, GRACE, 10)).toEqual([]);
  });

  it('a Traveler made a Follower between syncs has the change kept in Couldn’t sync with its sentence, and it is gone from what is shown', async () => {
    const { tripId, days } = await trip();
    const sam = await device(SAM);
    await sync(sam);
    await sam.store.record(
      must(createItem(tripId, days[0], { title: 'Museum' }, [], null, ctx())).mutation,
    );
    expect(await titles(sam, tripId)).toEqual(['Museum']);
    await setRole(tripDeps, ADA, tripId, SAM, 'follower');
    expect(await sync(sam)).toBe('ok');
    expect(await sam.store.pendingCount()).toBe(0);
    const refused = await sam.store.refused();
    expect(refused).toHaveLength(1);
    expect(refused[0]).toMatchObject({ reason: 'role' });
    expect(refused[0]?.sentence).toContain('Follower of “Iberia”');
    expect(describeMutation(refused[0]?.mutation)).toBe('Item Museum');
    expect(await titles(sam, tripId)).toEqual([]);
    expect((await sam.store.tripView(tripId, SAM))?.role).toBe('follower');
    // Nothing is thrown away: made a Traveler again, it can be sent again.
    await setRole(tripDeps, ADA, tripId, SAM, 'traveler');
    expect(await sam.store.retryRefused(refused[0]?.mutationId ?? '')).toBe(true);
    await sync(sam);
    expect(await sam.store.refused()).toEqual([]);
    expect(await titles(sam, tripId)).toEqual(['Museum']);
  });

  it('a Follower’s device never holds an attachment row; one it held is dropped when it becomes a Follower', async () => {
    const { tripId } = await trip();
    await dbAll(
      database,
      sql`INSERT INTO ${t('media')} (id, trip_id, kind, type, bytes, state, created_at) VALUES (${'m1'}, ${tripId}, 'attachment', 'application/pdf', 3, 'ready', ${clock}) RETURNING id`,
    );
    await dbAll(
      database,
      sql`INSERT INTO ${t('attachment')} (id, trip_id, kind, media_id, seq, sealed, created_at) VALUES (${'a1'}, ${tripId}, 'booking', 'm1', 5, ${sealer.seal('attachment', 'a1', { title: 'Ticket' })}, ${clock}) RETURNING id`,
    );
    const noor = await device(NOOR);
    const sam = await device(SAM);
    await sync(noor);
    await sync(sam);
    expect((await noor.store.trips())[0]?.sets?.attachments).toBeUndefined();
    expect(JSON.stringify(await noor.store.trips())).not.toContain('Ticket');
    expect((await sam.store.trips())[0]?.sets?.attachments?.map((a) => a.title)).toEqual([
      'Ticket',
    ]);
    await setRole(tripDeps, ADA, tripId, SAM, 'follower');
    await sync(sam);
    expect((await sam.store.trips())[0]?.sets?.attachments).toBeUndefined();
    expect(JSON.stringify(await sam.store.trips())).not.toContain('Ticket');
  });

  it('forgets a trip, and every row of it, when the account is not in it any more: deleted, or left', async () => {
    const { tripId, days } = await trip();
    const grace = await device(GRACE);
    const noor = await device(NOOR);
    await grace.store.record(
      must(createItem(tripId, days[0], { title: 'Museum' }, [], null, ctx())).mutation,
    );
    await sync(grace);
    await sync(noor);
    expect(await titles(noor, tripId)).toEqual(['Museum']);
    await dbAll(
      database,
      sql`UPDATE ${t('trip_member')} SET left_at = ${clock} WHERE trip_id = ${tripId} AND account_id = ${NOOR} RETURNING trip_id`,
    );
    await sync(noor);
    expect(await noor.store.trips()).toEqual([]);
    expect(await noor.store.db.count('tripItems')).toBe(0);
    await deleteTrip(tripDeps, ADA, tripId);
    await sync(grace);
    expect(await grace.store.trips()).toEqual([]);
    expect(await grace.store.db.count('tripItems')).toBe(0);
  });

  it('is told of a deleted item by a tombstone, and a device behind a pruned history starts the trip again', async () => {
    const { tripId, days } = await trip();
    const grace = await device(GRACE);
    const sam = await device(SAM);
    let among: { id: string; position: string }[] = [];
    for (const title of ['One', 'Two']) {
      const made = must(createItem(tripId, days[0], { title }, among, null, ctx()));
      await grace.store.record(made.mutation);
      const change = made.mutation.changes[0];
      if (change?.table === 'item' && change.op === 'put')
        among = [...among, { id: change.id, position: change.row.position }];
    }
    await sync(grace);
    await sync(sam);
    expect(await titles(sam, tripId)).toEqual(['One', 'Two']);
    const two = (await sam.store.tripView(tripId, SAM))?.items.find((i) => i.title === 'Two');
    await deleteItemOnline(tripDeps, ADA, tripId, two?.id ?? '');
    await sync(sam);
    expect(await titles(sam, tripId)).toEqual(['One']);
    // A device that was away: it holds an item whose deletion it never heard of.
    const away = await device(GRACE);
    await sync(away);
    const one = (await away.store.db.getAll('tripItems'))[0];
    if (!one) throw new Error('no item');
    await away.store.db.put('tripItems', { ...one, id: randomUUID(), title: 'Ghost' });
    expect(await titles(away, tripId)).toContain('Ghost');
    // Then the history is pruned: the trip's floor rises past what the device last saw.
    await deleteItemOnline(tripDeps, ADA, tripId, one.id);
    clock += KEEP_MS + 1000;
    await pruneHistory(database, clock);
    expect((await away.store.trips())[0]?.floor).toBe(0);
    await sync(away);
    expect(await titles(away, tripId)).toEqual([]);
    expect((await away.store.trips())[0]?.floor).toBeGreaterThan(0);
  });

  it('pages a long trip a few rows at a time and ends with every item', async () => {
    const { tripId, days } = await trip();
    const sam = await device(SAM);
    const made: string[] = [];
    let among: { id: string; position: string }[] = [];
    for (let n = 0; n < 9; n++) {
      const result = must(createItem(tripId, days[0], { title: `Item ${n}` }, among, null, ctx()));
      await sam.store.record(result.mutation);
      const change = result.mutation.changes[0];
      if (change?.table === 'item' && change.op === 'put')
        among = [...among, { id: change.id, position: change.row.position }];
      made.push(`Item ${n}`);
    }
    await sync(sam);
    const grace = await device(GRACE);
    expect(await sync(grace, 2)).toBe('ok');
    expect(await titles(grace, tripId)).toEqual(made);
  });

  it('shows the check-ins members share with the trip, Followers too, and takes one away when it is unshared', async () => {
    const { tripId } = await trip();
    const placeId = randomUUID();
    const checkinId = randomUUID();
    await applyMutation(deps, SAM, {
      mutationId: randomUUID(),
      stream: 'account',
      changes: [
        {
          table: 'place',
          op: 'put',
          id: placeId,
          row: { ...LISBON, source: 'manual', tz: 'Europe/Lisbon', countryCode: null },
        },
        {
          table: 'checkin',
          op: 'put',
          id: checkinId,
          row: {
            placeId,
            at: Date.parse('2026-05-11T12:00:00+01:00'),
            tz: 'Europe/Lisbon',
            offsetMin: 60,
            note: 'tram',
            companions: [],
            tripId: null,
            linkSource: null,
            share: 'trip',
            source: 'live',
          },
        },
      ],
    });
    const noor = await device(NOOR);
    await sync(noor);
    expect((await noor.store.tripView(tripId, NOOR))?.shared).toEqual([]);
    await setShareChoice(tripDeps, SAM, tripId, 'on');
    await sync(noor);
    expect((await noor.store.tripView(tripId, NOOR))?.shared.map((c) => c.note)).toEqual(['tram']);
    await setShareChoice(tripDeps, SAM, tripId, 'off');
    await sync(noor);
    expect((await noor.store.tripView(tripId, NOOR))?.shared).toEqual([]);
  });

  it('leaves a day’s words edited offline on screen at once, and a day moves with its item', async () => {
    const { tripId, days } = await trip();
    const sam = await device(SAM);
    await sync(sam);
    const day = (await sam.store.tripView(tripId, SAM))?.days[1];
    if (!day) throw new Error('no day');
    await sam.store.record(
      must(editDay(tripId, day, { title: 'Travel day', notes: 'early start' }, ctx())).mutation,
    );
    expect((await sam.store.tripView(tripId, SAM))?.days[1]).toMatchObject({
      title: 'Travel day',
      notes: 'early start',
    });
    await sync(sam);
    const grace = await device(GRACE);
    await sync(grace);
    expect((await grace.store.tripView(tripId, GRACE))?.days[1]).toMatchObject({
      title: 'Travel day',
      notes: 'early start',
      version: 2,
    });
    // An item moved to another day, keeping all its fields.
    await sam.store.record(
      must(
        createItem(
          tripId,
          days[0],
          { title: 'Hotel', kind: 'stay', start: '15:00', fixed: true },
          [],
          null,
          ctx(),
        ),
      ).mutation,
    );
    const item = (await sam.store.tripView(tripId, SAM))?.items[0];
    if (!item) throw new Error('no item');
    await sam.store.record(must(moveItem(tripId, item, days[2], [], null, ctx())).mutation);
    await sync(sam);
    await sync(grace);
    expect((await grace.store.tripView(tripId, GRACE))?.items[0]).toMatchObject({
      title: 'Hotel',
      kind: 'stay',
      start: '15:00',
      fixed: true,
      dayId: days[2],
    });
  });

  it('removes the account’s database with sign-out as before, trips included', async () => {
    const { tripId } = await trip();
    const sam = await device(SAM);
    await sync(sam);
    expect(await sam.store.trips()).toHaveLength(1);
    sam.store.close();
    await deleteLocal(SAM);
    const again = await device(SAM);
    expect(await again.store.tripView(tripId, SAM)).toBeUndefined();
  });

  it('upgrades a device that holds the account’s database as version 2: its rows and outbox stay, and it gains the trips', async () => {
    (globalThis as { indexedDB?: IDBFactory }).indexedDB = new IDBFactory();
    const old = await openDB(dbName(SAM), 2, {
      upgrade(db) {
        db.createObjectStore('places', { keyPath: 'id' });
        db.createObjectStore('checkins', { keyPath: 'id' }).createIndex('at', 'at');
        db.createObjectStore('outbox', { keyPath: 'n', autoIncrement: true });
        db.createObjectStore('refused', { keyPath: 'mutationId' });
        db.createObjectStore('meta', { keyPath: 'key' });
        db.createObjectStore('photos', { keyPath: 'id' });
      },
    });
    await old.put('meta', { key: 'cursor', value: 7 });
    old.close();
    const store = new LocalStore(await openLocal(SAM), () => clock);
    expect(await store.cursor()).toBe(7);
    expect(await store.trips()).toEqual([]);
    expect(await store.tripAsks()).toEqual({});
  });
});
