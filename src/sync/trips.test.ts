import { randomBytes, randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { tableOf } from '../access/trip';
import { DEFAULT_LIMITS } from '../config';
import { ringOf } from '../crypto/keys';
import { Sealer } from '../crypto/sealed';
import type { Database } from '../db/client';
import { dbAll, dbGet } from '../db/exec';
import { makeStore, testTarget } from '../db/test-support';
import { listNotices } from '../notices/notices';
import { setShareChoice } from '../sharing/choice';
import { setRole } from '../trips/members';
import { addStop, clearDayItems, deleteItem, removeStop } from '../trips/plan';
import { applyTripMutation } from '../trips/sync';
import { deleteTrip, createTrip } from '../trips/trips';
import { addLink } from '../trips/links';
import { applyMutation } from './apply';
import { handleSync } from './endpoint';
import { PROTOCOL_VERSION } from './format';
import { KEEP_MS, pruneHistory } from './history';
import type { TripPage } from './trip-format';
import { pullTrips } from './trips';

/**
 * A trip's stream (DESIGN.md §15.1, §15.3, §15.4), against whichever database the leg runs on: what a member's device is given by role, how it is paged and what it is told of deletions; and the items and days' words a Traveler makes offline, applied once,
 * by role, the later edit standing and the earlier author told.
 */
const { leg } = testTarget();
const ring = ringOf(randomBytes(32));
if (!ring) throw new Error('no ring');
const sealer = new Sealer(ring);
const [ADA, SAM, NOOR, GRACE, STRANGER] = ['ada', 'sam', 'noor', 'grace', 'stranger'];
let NOW = Date.parse('2026-09-01T12:00:00Z');
let database: Database;
let close: () => Promise<void>;
let deps: { database: Database; sealer: Sealer; now: () => number; limits: typeof DEFAULT_LIMITS };
const t = (name: string) => tableOf(database, name);
const LISBON = { name: 'Lisbon', lat: 38.7223, lng: -9.1393 };

/** A trip: Ada Organizer, Sam and Grace Travelers, Noor a Follower; one stop of three days. */
async function trip() {
  const made = await createTrip(deps, ADA, { name: 'Iberia' });
  for (const [who, role] of [
    [SAM, 'traveler'],
    [GRACE, 'traveler'],
    [NOOR, 'follower'],
  ] as const)
    await dbAll(
      database,
      sql`INSERT INTO ${t('trip_member')} (trip_id, account_id, role, going, share_checkins, joined_at, seq) VALUES (${made.id}, ${who}, ${role}, ${role === 'traveler'}, 'ask', ${NOW}, 2) RETURNING trip_id`,
    );
  await addStop(deps, ADA, made.id, { place: LISBON, arrive: '2026-05-10', depart: '2026-05-12' });
  const days = (
    await dbAll<{ id: string }>(
      database,
      sql`SELECT id FROM ${t('day')} WHERE trip_id = ${made.id} ORDER BY date`,
    )
  ).map((row) => row.id);
  return { tripId: made.id, days: days as [string, string, string] };
}

const item = (dayId: string, patch: Record<string, unknown> = {}) => ({
  dayId,
  title: 'Dinner',
  kind: 'food',
  start: '20:00',
  end: null,
  fixed: false,
  placeId: null,
  position: 'a0',
  ...patch,
});
const send = (who: string, tripId: string, changes: unknown[], mutationId = randomUUID()) =>
  applyTripMutation({ ...deps }, who, { mutationId, stream: `trip:${tripId}`, changes });
const put = (id: string, row: Record<string, unknown>, baseVersion?: number) => ({
  table: 'item',
  op: 'put',
  id,
  ...(baseVersion ? { baseVersion } : {}),
  row,
});
const pull = async (
  who: string,
  asks: Record<string, { cursor: number; floor: number }> = {},
  limit = 100,
) => pullTrips(deps, who, asks, limit);
const page = async (who: string, tripId: string, cursor = 0, limit = 100): Promise<TripPage> => {
  const found = (await pull(who, { [tripId]: { cursor, floor: 0 } }, limit)).trips.find(
    (each) => each.tripId === tripId,
  );
  if (!found) throw new Error('no page');
  return found;
};
const versionOf = async (id: string) =>
  Number(
    (
      await dbGet<{ v: number | string }>(
        database,
        sql`SELECT version AS v FROM ${t('item')} WHERE id = ${id}`,
      )
    )?.v,
  );

beforeAll(async () => {
  ({ database, close } = await makeStore());
  deps = { database, sealer, now: () => ++NOW, limits: DEFAULT_LIMITS };
});
afterAll(async () => close());
beforeEach(async () => {
  for (const table of [
    'item_done',
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

describe(`what a device is given of a trip (${leg})`, () => {
  it('is, for each trip the account is in, the trip, its members, stops, days and links whole, and the items past the cursor', async () => {
    const { tripId, days } = await trip();
    await addLink(deps, ADA, tripId, { url: 'https://example.org/plan', title: 'Plan' });
    await send(SAM, tripId, [put(randomUUID(), item(days[0]))]);
    const { trips, gone } = await pull(SAM);
    expect(gone).toEqual([]);
    expect(trips).toHaveLength(1);
    const first = trips[0] as TripPage;
    expect(first).toMatchObject({ tripId, role: 'traveler', reset: false, more: false });
    expect(first.sets?.trip.name).toBe('Iberia');
    expect(first.sets?.members.map((m) => m.accountId).sort()).toEqual(
      [ADA, GRACE, NOOR, SAM].sort(),
    );
    expect(first.sets?.stops).toHaveLength(1);
    expect(first.sets?.days.map((d) => d.id)).toEqual(days);
    expect(first.sets?.links.map((l) => l.title)).toEqual(['Plan']);
    expect(first.items.map((i) => i.title)).toEqual(['Dinner']);
    expect(first.cursor).toBe(first.head);
    // Caught up: nothing more, and no sets again.
    const again = await page(SAM, tripId, first.cursor);
    expect(again.items).toEqual([]);
    expect(again.sets).toBeUndefined();
  });

  it('never has another account’s trips, and a trip the account is not in any more is "gone"', async () => {
    const { tripId } = await trip();
    expect((await pull(STRANGER)).trips).toEqual([]);
    expect((await pull(STRANGER, { [tripId]: { cursor: 3, floor: 0 } })).gone).toEqual([tripId]);
    await dbAll(
      database,
      sql`UPDATE ${t('trip_member')} SET left_at = ${NOW} WHERE trip_id = ${tripId} AND account_id = ${NOOR} RETURNING trip_id`,
    );
    const left = await pull(NOOR, { [tripId]: { cursor: 3, floor: 0 } });
    expect(left.trips).toEqual([]);
    expect(left.gone).toEqual([tripId]);
    // Deleted: gone for everyone who held it.
    await deleteTrip(deps, ADA, tripId);
    expect((await pull(SAM, { [tripId]: { cursor: 1, floor: 0 } })).gone).toEqual([tripId]);
  });

  it('holds no attachment for a Follower: not a set, and not a deletion', async () => {
    const { tripId } = await trip();
    await dbAll(
      database,
      sql`INSERT INTO ${t('media')} (id, trip_id, kind, type, bytes, state, created_at) VALUES (${'m1'}, ${tripId}, 'attachment', 'application/pdf', 3, 'ready', ${NOW}) RETURNING id`,
    );
    await dbAll(
      database,
      sql`INSERT INTO ${t('attachment')} (id, trip_id, kind, media_id, seq, sealed, created_at) VALUES (${'a1'}, ${tripId}, 'booking', 'm1', 5, ${sealer.seal('attachment', 'a1', { title: 'Ticket' })}, ${NOW}) RETURNING id`,
    );
    expect((await page(SAM, tripId)).sets?.attachments?.map((a) => a.title)).toEqual(['Ticket']);
    expect((await page(ADA, tripId)).sets?.attachments).toHaveLength(1);
    const follower = await page(NOOR, tripId);
    expect(follower.role).toBe('follower');
    expect(follower.sets).toBeDefined();
    expect(follower.sets?.attachments).toBeUndefined();
    expect(JSON.stringify(follower)).not.toContain('Ticket');
  });

  it('tells of an item that was deleted, once its row is gone, past the cursor; and an edit that restores it takes the tombstone away', async () => {
    const { tripId, days } = await trip();
    const id = randomUUID();
    await send(SAM, tripId, [put(id, item(days[0]))]);
    const cursor = (await page(GRACE, tripId)).cursor;
    await send(SAM, tripId, [{ table: 'item', op: 'delete', id }]);
    const after = await page(GRACE, tripId, cursor);
    expect(after.items).toEqual([]);
    expect(after.deleted).toEqual([{ table: 'item', id, seq: expect.any(Number) }]);
    // Restored by an edit.
    await send(GRACE, tripId, [put(id, item(days[0], { title: 'Dinner again' }), 1)]);
    const restored = await page(NOOR, tripId, after.cursor);
    expect(restored.items.map((i) => i.title)).toEqual(['Dinner again']);
    expect((await page(NOOR, tripId, 0)).deleted).toEqual([]);
  });

  it('is cut only between numbers of the trip’s counter, and a device that pages through gets every item once', async () => {
    const { tripId, days } = await trip();
    // Seven mutations, one number each; and one mutation of three items, which share a number.
    const ids: string[] = [];
    for (let n = 0; n < 7; n++) {
      const id = randomUUID();
      ids.push(id);
      await send(SAM, tripId, [put(id, item(days[0], { title: `One ${n}`, position: `a${n}` }))]);
    }
    const three = [randomUUID(), randomUUID(), randomUUID()];
    expect(
      (
        await send(
          SAM,
          tripId,
          three.map((id, n) =>
            put(id, item(days[1], { title: `Three ${n}`, position: `a${n + 1}` })),
          ),
        )
      ).status,
    ).toBe('applied');
    ids.push(...three);
    const seen: string[] = [];
    let cursor = 0;
    let rounds = 0;
    for (;;) {
      const next = await page(GRACE, tripId, cursor, 2);
      seen.push(...next.items.map((i) => i.id));
      cursor = next.cursor;
      rounds += 1;
      if (!next.more) break;
      expect(rounds).toBeLessThan(20);
    }
    expect(seen.sort()).toEqual([...ids].sort());
    expect(rounds).toBeGreaterThan(2);
    // The three that share a number came in one page.
    const pages: string[][] = [];
    cursor = 0;
    for (;;) {
      const next = await page(GRACE, tripId, cursor, 2);
      pages.push(next.items.map((i) => i.id));
      cursor = next.cursor;
      if (!next.more) break;
    }
    const where = pages
      .map((p) => three.filter((id) => p.includes(id)).length)
      .filter((n) => n > 0);
    expect(where).toEqual([3]);
  });

  it('removing a stop, a day’s items and a copy tell the device, and a pruned history gives a fresh snapshot', async () => {
    const { tripId, days } = await trip();
    const a = randomUUID();
    const b = randomUUID();
    await send(SAM, tripId, [put(a, item(days[0])), put(b, item(days[1], { title: 'Walk' }))]);
    const cursor = (await page(GRACE, tripId)).cursor;
    await clearDayItems(deps, ADA, tripId, days[0]);
    const stop = await dbGet<{ id: string }>(
      database,
      sql`SELECT id FROM ${t('stop')} WHERE trip_id = ${tripId}`,
    );
    await removeStop(deps, ADA, tripId, stop?.id ?? '');
    const told = await page(GRACE, tripId, cursor);
    expect(told.deleted.map((d) => d.id).sort()).toEqual([a, b].sort());
    expect(told.sets?.stops).toEqual([]);
    expect(told.sets?.days).toEqual([]);
    // Pruned after 90 days: the floor rises, and a device behind it starts again.
    NOW += KEEP_MS + 1000;
    const pruned = await pruneHistory(database, NOW);
    expect(pruned.tombstones).toBeGreaterThan(0);
    const behind = await pull(GRACE, { [tripId]: { cursor, floor: 0 } });
    expect(behind.trips[0]).toMatchObject({ reset: true });
    const ok = await pull(GRACE, {
      [tripId]: { cursor: behind.trips[0]?.cursor ?? 0, floor: behind.trips[0]?.floor ?? 0 },
    });
    expect(ok.trips[0]).toMatchObject({ reset: false });
  });

  it('includes the copies of shared check-ins for every member, and tells of one that is unshared', async () => {
    const { tripId } = await trip();
    const placeId = randomUUID();
    const checkinId = randomUUID();
    await applyMutation({ database, sealer, now: () => NOW }, SAM, {
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
            note: 'hello',
            companions: [],
            tripId: null,
            linkSource: null,
            share: 'trip',
            source: 'live',
          },
        },
      ],
    });
    await setShareChoice(deps, SAM, tripId, 'on');
    for (const who of [ADA, GRACE, NOOR]) {
      const mine = await page(who, tripId);
      expect(
        mine.shared.map((c) => c.id),
        who,
      ).toEqual([checkinId]);
      expect(mine.shared[0]?.note).toBe('hello');
    }
    expect((await page(SAM, tripId)).shared).toEqual([]);
    const cursor = (await page(NOOR, tripId)).cursor;
    await setShareChoice(deps, SAM, tripId, 'off');
    const after = await page(NOOR, tripId, cursor);
    expect(after.shared).toEqual([]);
    expect(after.deleted).toEqual([
      { table: 'shared_checkin', id: checkinId, seq: expect.any(Number) },
    ]);
  });

  it('is told by the endpoint with the account’s own stream, for the trips named, and the mutations are applied before the pull', async () => {
    const { tripId, days } = await trip();
    const id = randomUUID();
    const answer = await handleSync({ database, sealer, now: () => NOW }, SAM, {
      protocol: PROTOCOL_VERSION,
      outbox: [
        { mutationId: randomUUID(), stream: `trip:${tripId}`, changes: [put(id, item(days[2]))] },
      ],
      cursor: 0,
      trips: {},
    });
    expect(answer.status).toBe(200);
    if (answer.status !== 200) return;
    expect(answer.body.results).toMatchObject([{ status: 'applied' }]);
    expect(answer.body.trips[0]?.items.map((i) => i.id)).toEqual([id]);
    expect(answer.body.gone).toEqual([]);
    for (const bad of [
      { trips: [] },
      { trips: { nope: { cursor: 0, floor: 0 } } },
      { trips: { [tripId]: { cursor: -1, floor: 0 } } },
    ])
      expect(
        await handleSync({ database, sealer, now: () => NOW }, SAM, {
          protocol: PROTOCOL_VERSION,
          ...bad,
        }),
      ).toMatchObject({ status: 400 });
  });
});

describe(`items and days a Traveler makes offline (${leg})`, () => {
  it('are made, edited and deleted once, whole, and a replay writes nothing', async () => {
    const { tripId, days } = await trip();
    const id = randomUUID();
    const mutationId = randomUUID();
    const made = await send(SAM, tripId, [put(id, item(days[0]))], mutationId);
    expect(made.status).toBe('applied');
    expect(await send(SAM, tripId, [put(id, item(days[0]))], mutationId)).toEqual({
      status: 'replay',
    });
    expect(await versionOf(id)).toBe(1);
    expect(
      (await send(GRACE, tripId, [put(id, item(days[1], { title: 'Moved', position: 'a1' }), 1)]))
        .status,
    ).toBe('applied');
    const row = (await page(ADA, tripId)).items.find((i) => i.id === id);
    expect(row).toMatchObject({
      title: 'Moved',
      dayId: days[1],
      version: 2,
      createdBy: SAM,
      updatedBy: GRACE,
      position: 'a1',
    });
    expect((await send(ADA, tripId, [{ table: 'item', op: 'delete', id }])).status).toBe('applied');
    expect((await page(ADA, tripId)).items).toEqual([]);
    // Deleting what is not there is nothing.
    expect((await send(ADA, tripId, [{ table: 'item', op: 'delete', id }])).status).toBe('applied');
  });

  it('are refused for a Follower, a person who has left and a stranger, each with a sentence, and nothing is kept', async () => {
    const { tripId, days } = await trip();
    const id = randomUUID();
    const follower = await send(NOOR, tripId, [put(id, item(days[0]))]);
    expect(follower).toMatchObject({ status: 'refused', reason: 'role' });
    expect((follower as { sentence: string }).sentence).toContain('Follower of “Iberia”');
    await dbAll(
      database,
      sql`UPDATE ${t('trip_member')} SET left_at = ${NOW} WHERE trip_id = ${tripId} AND account_id = ${GRACE} RETURNING trip_id`,
    );
    for (const who of [GRACE, STRANGER]) {
      const refused = await send(who, tripId, [put(id, item(days[0]))]);
      expect(refused, who).toMatchObject({ status: 'refused', reason: 'not_in_trip' });
      expect(JSON.stringify(refused)).not.toContain('Iberia');
    }
    expect(
      await dbGet(database, sql`SELECT id FROM ${t('item')} WHERE id = ${id}`),
    ).toBeUndefined();
    // A Traveler lowered to a Follower between syncs: their next edit goes to Couldn't sync, and the id is not spent.
    const mutationId = randomUUID();
    await setRole(deps, ADA, tripId, SAM, 'follower');
    expect(await send(SAM, tripId, [put(id, item(days[0]))], mutationId)).toMatchObject({
      status: 'refused',
      reason: 'role',
    });
    await setRole(deps, ADA, tripId, SAM, 'traveler');
    expect((await send(SAM, tripId, [put(id, item(days[0]))], mutationId)).status).toBe('applied');
  });

  it('the later edit stands, whole, and the earlier author is told what their edit said; never the one who replaced it', async () => {
    const { tripId, days } = await trip();
    const id = randomUUID();
    await send(ADA, tripId, [put(id, item(days[0], { title: 'Original' }))]);
    // Sam edits the version he saw: nothing was replaced, so nobody is told.
    await send(SAM, tripId, [
      put(id, item(days[0], { title: 'Sam’s plan', notes: 'bring cash' }), 1),
    ]);
    expect(await listNotices({ database, sealer }, ADA, 10)).toEqual([]);
    // Grace, who also saw version 1, edits later: hers stands, and Sam is told what his said.
    await send(GRACE, tripId, [put(id, item(days[0], { title: 'Grace’s plan' }), 1)]);
    expect((await page(ADA, tripId)).items[0]).toMatchObject({
      title: 'Grace’s plan',
      notes: undefined,
      updatedBy: GRACE,
    });
    const sam = await listNotices({ database, sealer }, SAM, 10);
    expect(sam.map((n) => n.kind)).toEqual(['edit_replaced']);
    expect(JSON.stringify(sam)).toContain('Sam’s plan');
    expect(JSON.stringify(sam)).toContain('bring cash');
    expect(JSON.stringify(sam)).toContain('Iberia');
    expect(JSON.stringify(sam)).not.toContain('Grace');
    expect(await listNotices({ database, sealer }, GRACE, 10)).toEqual([]);
    expect(await listNotices({ database, sealer }, ADA, 10)).toEqual([]);
    // An edit from the version the row has replaces nobody's.
    await send(SAM, tripId, [put(id, item(days[0], { title: 'Sam sees it' }), 3)]);
    expect(await listNotices({ database, sealer }, GRACE, 10)).toEqual([]);
    // Ada, still on version 2, replaces Sam's later edit: Sam is told again.
    await send(ADA, tripId, [put(id, item(days[0], { title: 'Ada’s' }), 2)]);
    expect(
      (await listNotices({ database, sealer }, SAM, 10)).filter((n) => n.kind === 'edit_replaced'),
    ).toHaveLength(2);
    expect(
      (await listNotices({ database, sealer }, GRACE, 10)).filter(
        (n) => n.kind === 'edit_replaced',
      ),
    ).toHaveLength(0);
    // One's own earlier edit replaced by one's own later one: nobody is told.
    const mine = (await listNotices({ database, sealer }, ADA, 10)).length;
    await send(ADA, tripId, [put(id, item(days[0], { title: 'Ada again' }), 2)]);
    expect((await listNotices({ database, sealer }, ADA, 10)).length).toBe(mine);
  });

  it('an edit of an item another member deleted restores it, in its place, and a delete after an edit deletes it', async () => {
    const { tripId, days } = await trip();
    const id = randomUUID();
    await send(SAM, tripId, [put(id, item(days[0]))]);
    await deleteItem(deps, ADA, tripId, id);
    expect((await page(SAM, tripId)).items).toEqual([]);
    expect(
      (await send(SAM, tripId, [put(id, item(days[0], { title: 'Still wanted' }), 1)])).status,
    ).toBe('applied');
    expect((await page(ADA, tripId)).items.map((i) => i.title)).toEqual(['Still wanted']);
    await send(ADA, tripId, [{ table: 'item', op: 'delete', id }]);
    expect((await page(SAM, tripId)).items).toEqual([]);
  });

  it('are refused for a day that was removed, a place the trip does not have, an id of another trip, and past a day’s limit', async () => {
    const { tripId, days } = await trip();
    const other = await trip();
    const id = randomUUID();
    expect(await send(SAM, tripId, [put(id, item(randomUUID()))])).toMatchObject({
      status: 'refused',
      reason: 'day_gone',
    });
    expect(
      await send(SAM, tripId, [put(id, item(days[0], { placeId: randomUUID() }))]),
    ).toMatchObject({ status: 'refused', reason: 'place_gone' });
    // Another trip's day, and another trip's item id.
    expect(await send(SAM, tripId, [put(id, item(other.days[0]))])).toMatchObject({
      status: 'refused',
      reason: 'day_gone',
    });
    const theirs = randomUUID();
    await send(SAM, other.tripId, [put(theirs, item(other.days[0]))]);
    expect(await send(SAM, tripId, [put(theirs, item(days[0]))])).toMatchObject({
      status: 'refused',
      reason: 'missing',
    });
    // A day's limit.
    const small = { ...deps, limits: { ...DEFAULT_LIMITS, dayItems: 2 } };
    const sendSmall = (changes: unknown[]) =>
      applyTripMutation(small, SAM, {
        mutationId: randomUUID(),
        stream: `trip:${tripId}`,
        changes,
      });
    expect(
      (
        await sendSmall([
          put(randomUUID(), item(days[1], { position: 'a0' })),
          put(randomUUID(), item(days[1], { position: 'a1' })),
        ])
      ).status,
    ).toBe('applied');
    expect(await sendSmall([put(randomUUID(), item(days[1], { position: 'a2' }))])).toMatchObject({
      status: 'refused',
      reason: 'limit',
    });
  });

  it('is whole or not at all: a refused change keeps none of the others’, and the id', async () => {
    const { tripId, days } = await trip();
    const good = randomUUID();
    const mutationId = randomUUID();
    const refused = await send(
      SAM,
      tripId,
      [put(good, item(days[0])), put(randomUUID(), item(randomUUID()))],
      mutationId,
    );
    expect(refused.status).toBe('refused');
    expect(
      await dbGet(database, sql`SELECT id FROM ${t('item')} WHERE id = ${good}`),
    ).toBeUndefined();
    expect(await send(SAM, tripId, [put(good, item(days[0]))], mutationId)).toMatchObject({
      status: 'applied',
    });
  });

  it('are checked by the same rules the device runs: a value that is not an item’s is refused with a sentence that repeats nothing', async () => {
    const { tripId, days } = await trip();
    for (const bad of [
      item(days[0], { title: '', placeId: null }),
      item(days[0], { kind: 'party' }),
      item(days[0], { fixed: true, start: null }),
      item(days[0], { start: '25:99' }),
      item(days[0], { position: 'not a position!' }),
      item(days[0], { extra: 1 }),
    ]) {
      const refused = await send(SAM, tripId, [put(randomUUID(), bad)]);
      expect(refused).toMatchObject({ status: 'refused' });
    }
    for (const bad of [
      { mutationId: 'x', stream: `trip:${tripId}`, changes: [] },
      { mutationId: randomUUID(), stream: 'trip:nope', changes: [{}] },
      {
        mutationId: randomUUID(),
        stream: `trip:${tripId}`,
        changes: [{ table: 'stop', op: 'delete', id: randomUUID() }],
      },
      {
        mutationId: randomUUID(),
        stream: `trip:${tripId}`,
        changes: [{ table: 'day', op: 'delete', id: days[0] }],
      },
    ])
      expect(await applyTripMutation(deps, SAM, bad)).toMatchObject({ status: 'refused' });
  });

  it('a day’s title and notes are edited, and a day that was removed is refused; Followers cannot', async () => {
    const { tripId, days } = await trip();
    const day = (title: string, notes?: string) => ({
      table: 'day',
      op: 'put',
      id: days[1],
      row: { title, ...(notes ? { notes } : {}) },
    });
    expect((await send(SAM, tripId, [day('Travel day', 'long')])).status).toBe('applied');
    const row = (await page(NOOR, tripId, 0)).sets?.days.find((d) => d.id === days[1]);
    expect(row).toMatchObject({ title: 'Travel day', notes: 'long', version: 2 });
    expect(await send(NOOR, tripId, [day('Mine')])).toMatchObject({
      status: 'refused',
      reason: 'role',
    });
    expect(
      await send(SAM, tripId, [{ table: 'day', op: 'put', id: randomUUID(), row: { title: 'x' } }]),
    ).toMatchObject({ status: 'refused', reason: 'day_gone' });
    expect(await send(SAM, tripId, [day('x'.repeat(201))])).toMatchObject({
      status: 'refused',
      reason: 'day_text',
    });
  });
});

describe(`a person’s Done marks (${leg})`, () => {
  const done = (id: string, op: 'put' | 'delete' = 'put') => ({ table: 'item_done', op, id });
  const marks = async (who: string, tripId: string) => (await page(who, tripId)).sets?.done ?? [];

  it('are the person’s own: made and taken away by them, seen by them on every device, and by no one else', async () => {
    const { tripId, days } = await trip();
    const id = randomUUID();
    await send(SAM, tripId, [put(id, item(days[0]))]);
    expect((await send(SAM, tripId, [done(id)])).status).toBe('applied');
    expect(await marks(SAM, tripId)).toEqual([id]);
    for (const who of [GRACE, ADA, NOOR]) expect(await marks(who, tripId), who).toEqual([]);
    // Twice is once; taking it away is the person’s, and doing it for what is not marked is nothing.
    await send(SAM, tripId, [done(id)]);
    expect(await marks(SAM, tripId)).toEqual([id]);
    await send(GRACE, tripId, [done(id, 'delete')]);
    expect(await marks(SAM, tripId)).toEqual([id]);
    await send(SAM, tripId, [done(id, 'delete')]);
    expect(await marks(SAM, tripId)).toEqual([]);
    expect((await send(SAM, tripId, [done(id, 'delete')])).status).toBe('applied');
  });

  it('are for an item of this trip, by an Organizer or a Traveler; and an item deleted takes its mark out of sight', async () => {
    const { tripId, days } = await trip();
    const other = await trip();
    const id = randomUUID();
    await send(SAM, tripId, [put(id, item(days[0]))]);
    expect(await send(NOOR, tripId, [done(id)])).toMatchObject({
      status: 'refused',
      reason: 'role',
    });
    expect(await send(STRANGER, tripId, [done(id)])).toMatchObject({
      status: 'refused',
      reason: 'not_in_trip',
    });
    expect(await send(SAM, tripId, [done(randomUUID())])).toMatchObject({
      status: 'refused',
      reason: 'item_gone',
    });
    // An item of another trip is not this trip’s to mark.
    const theirs = randomUUID();
    await send(ADA, other.tripId, [put(theirs, item(other.days[0]))]);
    expect(await send(SAM, tripId, [done(theirs)])).toMatchObject({
      status: 'refused',
      reason: 'item_gone',
    });
    await send(SAM, tripId, [done(id)]);
    await deleteItem(deps, ADA, tripId, id);
    expect(await marks(SAM, tripId)).toEqual([]);
  });

  it('go with the trip, with the person who leaves it, and with the account', async () => {
    const { tripId, days } = await trip();
    const id = randomUUID();
    await send(GRACE, tripId, [put(id, item(days[0]))]);
    await send(SAM, tripId, [done(id)]);
    await send(GRACE, tripId, [done(id)]);
    const count = async () =>
      Number(
        (
          await dbGet<{ n: number | string }>(
            database,
            sql`SELECT COUNT(*) AS n FROM ${t('item_done')}`,
          )
        )?.n,
      );
    expect(await count()).toBe(2);
    const { leaveTrip } = await import('../trips/leaving');
    await leaveTrip(deps, SAM, tripId);
    expect(await count()).toBe(1);
    await deleteTrip(deps, ADA, tripId);
    expect(await count()).toBe(0);
  });
});
