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
import {
  type ItemView,
  type Plan,
  type PlanDeps,
  PlanRefused,
  addItem,
  addStop,
  clearDayItems,
  deleteItem,
  moveDayItems,
  moveItem,
  readPlan,
  removeStop,
  updateItem,
  updateStop,
} from './plan';
import { createTrip, deleteTrip } from './trips';

/**
 * Items (DESIGN.md §10.5), against whichever database the leg runs on: a place or a title, fixed only with a start, an order that is the day's as dragged, a move that keeps every field, and a day that is emptied the way a
 * refused shrink asks. **What an item is called is sealed**, and a change that is refused changes nothing.
 */
const { leg } = testTarget();
const ring = ringOf(randomBytes(32));
if (!ring) throw new Error('no ring');
const sealer = new Sealer(ring);
const [ADA, SAM, NOOR, STRANGER] = ['ada-acct', 'sam-acct', 'noor-acct', 'stranger-acct'];
let NOW = 1_800_000_000_000;
let database: Database;
let close: () => Promise<void>;
let deps: PlanDeps;
let tripId: string;
let day1: string;
let day2: string;
let day3: string;
let otherStopDay: string;

const t = (name: string) => tableOf(database, name);
const count = async (table: string, where = sql``): Promise<number> =>
  Number(
    (
      await dbGet<{ n: number | string }>(
        database,
        sql`SELECT COUNT(*) AS n FROM ${t(table)} ${where}`,
      )
    )?.n ?? 0,
  );
const itemsOf = (plan: Plan | undefined, dayId: string): ItemView[] =>
  plan?.stops.flatMap((stop) => stop.days).find((day) => day.id === dayId)?.items ?? [];
const titles = async (dayId: string) =>
  itemsOf(await readPlan(deps, ADA, tripId), dayId).map((item) => item.title);
const refusal = async (promise: Promise<unknown>): Promise<PlanRefused> => {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(PlanRefused);
  return error as PlanRefused;
};
const lisbon = { name: 'Time Out Market', lat: 38.7, lng: -9.14, category: 'Food hall' };

beforeAll(async () => {
  ({ database, close } = await makeStore());
  deps = { database, sealer, now: () => ++NOW, limits: DEFAULT_LIMITS };
});
afterAll(async () => close());
beforeEach(async () => {
  for (const table of ['item', 'day', 'stop', 'place', 'trip_member', 'trip'])
    await dbAll(database, sql`DELETE FROM ${t(table)} RETURNING 1 AS gone`);
  tripId = (await createTrip(deps, ADA, { name: 'Iberia' })).id;
  for (const [id, role] of [
    [SAM, 'traveler'],
    [NOOR, 'follower'],
  ] as const)
    await dbAll(
      database,
      sql`INSERT INTO ${t('trip_member')} (trip_id, account_id, role, going, share_checkins, joined_at, seq) VALUES (${tripId}, ${id}, ${role}, ${role === 'traveler'}, 'ask', ${NOW}, 2) RETURNING trip_id`,
    );
  await addStop(deps, ADA, tripId, {
    place: { name: 'Lisbon', lat: 38.72, lng: -9.14 },
    arrive: '2026-05-01',
    depart: '2026-05-03',
  });
  const plan = await addStop(deps, ADA, tripId, {
    place: { name: 'Porto', lat: 41.15, lng: -8.61 },
    arrive: '2026-05-03',
    depart: '2026-05-04',
  });
  const [a, b, c] = plan?.stops[0]?.days ?? [];
  [day1, day2, day3] = [a?.id ?? '', b?.id ?? '', c?.id ?? ''];
  otherStopDay = plan?.stops[1]?.days[1]?.id ?? '';
});

describe(`making an item (${leg})`, () => {
  it('has a place or a title or both, a kind, times and whether it is fixed, and notes', async () => {
    const plan = await addItem(deps, ADA, tripId, {
      dayId: day1,
      title: 'Dinner at Belcanto',
      notes: 'Ask for the terrace',
      kind: 'food',
      start: '19:00',
      end: '21:30',
      fixed: true,
      place: lisbon,
    });
    expect(itemsOf(plan, day1)).toEqual([
      expect.objectContaining({
        title: 'Dinner at Belcanto',
        notes: 'Ask for the terrace',
        kind: 'food',
        start: '19:00',
        end: '21:30',
        fixed: true,
        createdBy: ADA,
        updatedBy: ADA,
        version: 1,
        place: expect.objectContaining({ name: 'Time Out Market', tz: 'Europe/Lisbon' }),
      }),
    ]);
    const bare = await addItem(deps, ADA, tripId, { dayId: day1, title: 'Wander' });
    expect(itemsOf(bare, day1)[1]).toMatchObject({
      kind: 'other',
      start: null,
      end: null,
      fixed: false,
      place: undefined,
    });
    const placeOnly = await addItem(deps, ADA, tripId, {
      dayId: day1,
      place: { name: 'A viewpoint', lat: 38.7, lng: -9.1 },
    });
    expect(itemsOf(placeOnly, day1)[2]).toMatchObject({
      title: undefined,
      place: { name: 'A viewpoint' },
    });
  });

  it('refuses what is not an item, naming nothing that was typed, and makes nothing of it', async () => {
    for (const bad of [
      { dayId: day1 },
      { dayId: day1, title: '   ' },
      { dayId: day1, title: 'Reservation', fixed: true },
      { dayId: day1, title: 'x', end: '10:00' },
      { dayId: day1, title: 'x', start: '10:00', end: '09:00' },
      { dayId: day1, title: 'x', start: '24:00' },
      { dayId: day1, title: 'x', kind: 'museum' },
      { dayId: day1, title: 'x', notes: 'n'.repeat(2001) },
      { dayId: day1, title: 'x', place: lisbon, placeId: randomUUID() },
      { dayId: day1, place: { name: '', lat: 1, lng: 2 } },
      { dayId: day1, place: { name: 'x', lat: 200, lng: 2 } },
    ])
      await refusal(addItem(deps, ADA, tripId, bad));
    expect(await count('item')).toBe(0);
    // Only the stops' places are there: none was made for a refused item.
    expect(await count('place')).toBe(2);
  });

  it('seals the title and notes and the place’s name: the database holds none of them', async () => {
    await addItem(deps, ADA, tripId, {
      dayId: day1,
      title: 'Pastéis de Belém',
      notes: 'Arrive before ten',
      place: { name: 'Antiga Confeitaria', lat: 38.69, lng: -9.2 },
    });
    const rows = await dbAll<{ sealed: Uint8Array }>(
      database,
      sql`SELECT sealed FROM ${t('item')} UNION ALL SELECT sealed FROM ${t('place')}`,
    );
    for (const row of rows) {
      const text = Buffer.from(row.sealed).toString('latin1');
      for (const secret of ['Pastéis', 'Arrive before', 'Antiga'])
        expect(text).not.toContain(secret);
    }
  });

  it('names a place the trip has by its id, and a place that is not the trip’s is not found', async () => {
    const stopPlace = (await readPlan(deps, ADA, tripId))?.stops[0]?.place.id ?? '';
    const plan = await addItem(deps, ADA, tripId, { dayId: day1, placeId: stopPlace });
    expect(itemsOf(plan, day1)[0]?.place?.id).toBe(stopPlace);
    expect(await count('place')).toBe(2);
    await dbAll(
      database,
      sql`INSERT INTO ${t('place')} (id, account_id, source, version, seq, sealed, created_at, updated_at) VALUES ('hers', ${ADA}, 'manual', 1, 1, ${sealer.seal('place', 'hers', { name: 'A', lat: 1, lng: 2 })}, ${NOW}, ${NOW}) RETURNING id`,
    );
    expect(await addItem(deps, ADA, tripId, { dayId: day1, placeId: 'hers' })).toBeUndefined();
    const other = (await createTrip(deps, ADA, { name: 'Other' })).id;
    const foreign =
      (await addStop(deps, ADA, other, { place: { name: 'Else', lat: 1, lng: 2 } }))?.stops[0]
        ?.place.id ?? '';
    expect(await addItem(deps, ADA, tripId, { dayId: day1, placeId: foreign })).toBeUndefined();
    expect(await count('item')).toBe(1);
  });

  it('is put at the end of the day, or just before another, and the order is the database’s too', async () => {
    const a = itemsOf(await addItem(deps, ADA, tripId, { dayId: day1, title: 'A' }), day1)[0];
    await addItem(deps, ADA, tripId, { dayId: day1, title: 'B' });
    await addItem(deps, ADA, tripId, { dayId: day1, title: 'C' });
    expect(await titles(day1)).toEqual(['A', 'B', 'C']);
    await addItem(deps, ADA, tripId, { dayId: day1, title: 'Before A', before: a?.id ?? null });
    await addItem(deps, ADA, tripId, {
      dayId: day1,
      title: 'Between',
      before: itemsOf(await readPlan(deps, ADA, tripId), day1)[2]?.id ?? null,
    });
    expect(await titles(day1)).toEqual(['Before A', 'A', 'Between', 'B', 'C']);
    // The database orders them the same way, as bytes.
    const stored = await dbAll<{ position: string }>(
      database,
      sql`SELECT position FROM ${t('item')} WHERE day_id = ${day1} ORDER BY position`,
    );
    expect(stored.map((row) => row.position)).toEqual(
      itemsOf(await readPlan(deps, ADA, tripId), day1).map((item) => item.position),
    );
    // A neighbour that is not an item of the day is not found, and nothing is made.
    expect(
      await addItem(deps, ADA, tripId, { dayId: day1, title: 'x', before: randomUUID() }),
    ).toBeUndefined();
    expect(await titles(day1)).toEqual(['Before A', 'A', 'Between', 'B', 'C']);
  });

  it('goes on any day of the trip, a day of another trip is not found, and a Follower or a stranger adds nothing', async () => {
    expect(
      itemsOf(
        await addItem(deps, ADA, tripId, { dayId: otherStopDay, title: 'In Porto' }),
        otherStopDay,
      ),
    ).toHaveLength(1);
    const other = (await createTrip(deps, ADA, { name: 'Other' })).id;
    const foreignDay =
      (
        await addStop(deps, ADA, other, {
          place: { name: 'E', lat: 1, lng: 2 },
          arrive: '2026-09-01',
          depart: '2026-09-01',
        })
      )?.stops[0]?.days[0]?.id ?? '';
    expect(
      await addItem(deps, ADA, tripId, { dayId: foreignDay, title: 'Wrong trip' }),
    ).toBeUndefined();
    expect(await addItem(deps, SAM, tripId, { dayId: day1, title: 'By a Traveler' })).toBeDefined();
    expect(
      await addItem(deps, NOOR, tripId, { dayId: day1, title: 'By a Follower' }),
    ).toBeUndefined();
    expect(
      await addItem(deps, STRANGER, tripId, { dayId: day1, title: 'By a stranger' }),
    ).toBeUndefined();
    expect(await count('item')).toBe(2);
  });

  it('is refused past the day’s limit, and the limit does not touch another day', async () => {
    const limited = { ...deps, limits: { ...DEFAULT_LIMITS, dayItems: 2 } };
    await addItem(limited, ADA, tripId, { dayId: day1, title: '1' });
    await addItem(limited, ADA, tripId, { dayId: day1, title: '2' });
    expect(
      (await refusal(addItem(limited, ADA, tripId, { dayId: day1, title: '3' }))).failure,
    ).toMatchObject({ reason: 'limit' });
    expect(await count('item', sql`WHERE day_id = ${day1}`)).toBe(2);
    await addItem(limited, ADA, tripId, { dayId: day2, title: 'Elsewhere' });
  });

  it('stamps what it writes with the trip’s counter, which advances once for it', async () => {
    const before = Number(
      (
        await dbGet<{ seq: number | string }>(
          database,
          sql`SELECT seq FROM ${t('trip')} WHERE id = ${tripId}`,
        )
      )?.seq,
    );
    await addItem(deps, ADA, tripId, { dayId: day1, title: 'Counted', place: lisbon });
    const after = Number(
      (
        await dbGet<{ seq: number | string }>(
          database,
          sql`SELECT seq FROM ${t('trip')} WHERE id = ${tripId}`,
        )
      )?.seq,
    );
    expect(after).toBe(before + 1);
    const rows = await dbAll<{ seq: number | string }>(
      database,
      sql`SELECT seq FROM ${t('item')} UNION ALL SELECT seq FROM ${t('place')} WHERE seq > ${before}`,
    );
    expect(rows.map((row) => Number(row.seq))).toEqual([after, after]);
  });
});

describe(`changing an item (${leg})`, () => {
  async function made(fields: Record<string, unknown> = {}) {
    const plan = await addItem(deps, ADA, tripId, {
      dayId: day1,
      title: 'Original',
      kind: 'sight',
      ...fields,
    });
    return itemsOf(plan, day1).at(-1) as ItemView;
  }
  const current = async (id: string) =>
    itemsOf(await readPlan(deps, ADA, tripId), day1)
      .concat(itemsOf(await readPlan(deps, ADA, tripId), day2))
      .find((item) => item.id === id);

  it('changes the fields given and keeps the rest, advancing its version and naming who changed it', async () => {
    const item = await made({ notes: 'Keep me', start: '10:00' });
    await updateItem(deps, SAM, tripId, item.id, { title: 'Renamed', kind: 'food' });
    expect(await current(item.id)).toMatchObject({
      title: 'Renamed',
      kind: 'food',
      notes: 'Keep me',
      start: '10:00',
      version: 2,
      createdBy: ADA,
      updatedBy: SAM,
    });
    await updateItem(deps, ADA, tripId, item.id, { notes: null, start: null });
    expect(await current(item.id)).toMatchObject({ notes: undefined, start: null, version: 3 });
  });

  it('is checked as a whole: no change leaves an item with neither place nor title, or a fixed one with no start', async () => {
    const titled = await made();
    await refusal(updateItem(deps, ADA, tripId, titled.id, { title: null }));
    const fixed = await made({ title: 'Booked', start: '19:00', fixed: true });
    await refusal(updateItem(deps, ADA, tripId, fixed.id, { start: null }));
    await refusal(updateItem(deps, ADA, tripId, fixed.id, { end: '18:00' }));
    await refusal(updateItem(deps, ADA, tripId, fixed.id, {}));
    expect(await current(fixed.id)).toMatchObject({ start: '19:00', fixed: true, version: 1 });
    // With a place, the title can go.
    const placed = await made({ place: lisbon });
    await updateItem(deps, ADA, tripId, placed.id, { title: null });
    expect(await current(placed.id)).toMatchObject({
      title: undefined,
      place: { name: 'Time Out Market' },
    });
  });

  it('replaces or removes its place, and a place nothing names any more is removed with it', async () => {
    const item = await made({ place: lisbon });
    expect(await count('place')).toBe(3);
    await updateItem(deps, ADA, tripId, item.id, {
      place: { name: 'Another place', lat: 38.7, lng: -9.1 },
    });
    expect(await count('place')).toBe(3);
    expect((await current(item.id))?.place?.name).toBe('Another place');
    await updateItem(deps, ADA, tripId, item.id, { placeId: null });
    expect(await count('place')).toBe(2);
    expect((await current(item.id))?.place).toBeUndefined();
    // A stop's place named by an item stays when the item lets go of it.
    const stopPlace = (await readPlan(deps, ADA, tripId))?.stops[0]?.place.id ?? '';
    await updateItem(deps, ADA, tripId, item.id, { placeId: stopPlace });
    await updateItem(deps, ADA, tripId, item.id, { placeId: null });
    expect(await count('place')).toBe(2);
  });

  it('is for an Organizer or a Traveler, and an item that is not this trip’s is not found', async () => {
    const item = await made();
    expect(
      await updateItem(deps, NOOR, tripId, item.id, { title: 'By a Follower' }),
    ).toBeUndefined();
    expect(
      await updateItem(deps, STRANGER, tripId, item.id, { title: 'By a stranger' }),
    ).toBeUndefined();
    const other = (await createTrip(deps, ADA, { name: 'Other' })).id;
    expect(await updateItem(deps, ADA, other, item.id, { title: 'Wrong trip' })).toBeUndefined();
    expect((await current(item.id))?.title).toBe('Original');
  });
});

describe(`moving and deleting items (${leg})`, () => {
  const add = async (dayId: string, title: string, fields: Record<string, unknown> = {}) =>
    itemsOf(await addItem(deps, ADA, tripId, { dayId, title, ...fields }), dayId).find(
      (item) => item.title === title,
    ) as ItemView;

  it('moves within a day to just before another or to the end', async () => {
    const [a, b, c] = [await add(day1, 'A'), await add(day1, 'B'), await add(day1, 'C')];
    await moveItem(deps, ADA, tripId, c.id, day1, a.id);
    expect(await titles(day1)).toEqual(['C', 'A', 'B']);
    await moveItem(deps, ADA, tripId, c.id, day1, null);
    expect(await titles(day1)).toEqual(['A', 'B', 'C']);
    await moveItem(deps, ADA, tripId, a.id, day1, c.id);
    expect(await titles(day1)).toEqual(['B', 'A', 'C']);
    expect(b.id).toBeDefined();
  });

  it('moves to another day, of the same stop or of another, with every field kept', async () => {
    const item = await add(day1, 'Booked', {
      notes: 'Window seat',
      kind: 'food',
      start: '19:00',
      end: '21:00',
      fixed: true,
      place: lisbon,
    });
    await add(day3, 'Already there');
    const plan = await moveItem(deps, ADA, tripId, item.id, day3, null);
    const moved = itemsOf(plan, day3).find((each) => each.id === item.id);
    const { dayId: _d, position: _p, version: _v, ...kept } = moved as ItemView;
    const { dayId: _d2, position: _p2, version: _v2, ...before } = item;
    expect(kept).toEqual(before);
    expect(moved?.version).toBe(2);
    expect(itemsOf(plan, day1)).toEqual([]);
    expect(await titles(day3)).toEqual(['Already there', 'Booked']);
    // And into another stop's day.
    const across = await moveItem(deps, ADA, tripId, item.id, otherStopDay, null);
    expect(itemsOf(across, otherStopDay).map((each) => each.title)).toEqual(['Booked']);
    expect(itemsOf(across, otherStopDay)[0]?.place?.name).toBe('Time Out Market');
  });

  it('is refused into a day that is full, and a day or a neighbour that is not found, and by a Follower', async () => {
    const limited = { ...deps, limits: { ...DEFAULT_LIMITS, dayItems: 1 } };
    const a = itemsOf(
      await addItem(limited, ADA, tripId, { dayId: day1, title: 'A' }),
      day1,
    )[0] as ItemView;
    await addItem(limited, ADA, tripId, { dayId: day2, title: 'B' });
    expect((await refusal(moveItem(limited, ADA, tripId, a.id, day2, null))).failure).toMatchObject(
      { reason: 'limit' },
    );
    expect(await moveItem(deps, ADA, tripId, a.id, randomUUID(), null)).toBeUndefined();
    expect(await moveItem(deps, ADA, tripId, a.id, day2, randomUUID())).toBeUndefined();
    expect(await moveItem(deps, NOOR, tripId, a.id, day3, null)).toBeUndefined();
    expect(await moveItem(deps, STRANGER, tripId, a.id, day3, null)).toBeUndefined();
    expect(itemsOf(await readPlan(deps, ADA, tripId), day1).map((each) => each.id)).toEqual([a.id]);
  });

  it('deletes an item and the place only it named, and no one else’s item', async () => {
    const item = await add(day1, 'Gone', { place: lisbon });
    const kept = await add(day1, 'Kept');
    expect(await count('place')).toBe(3);
    expect(await deleteItem(deps, NOOR, tripId, item.id)).toBeUndefined();
    expect(await deleteItem(deps, STRANGER, tripId, item.id)).toBeUndefined();
    expect(await deleteItem(deps, SAM, tripId, item.id)).toBeDefined();
    expect(await count('place')).toBe(2);
    expect(await titles(day1)).toEqual(['Kept']);
    expect(await deleteItem(deps, ADA, tripId, item.id)).toBeUndefined();
    expect(kept.id).toBeDefined();
  });
});

describe(`a day that would go (${leg})`, () => {
  const add = async (dayId: string, title: string, fields: Record<string, unknown> = {}) =>
    itemsOf(await addItem(deps, ADA, tripId, { dayId, title, ...fields }), dayId).find(
      (item) => item.title === title,
    ) as ItemView;
  const lisbonStop = async () => (await readPlan(deps, ADA, tripId))?.stops[0]?.id ?? '';

  it('is refused to a shrink naming the days, until its items are moved to another day, and then they are there', async () => {
    await add(day3, 'On the last day', { place: lisbon });
    const stop = await lisbonStop();
    const refused = await refusal(
      updateStop(deps, ADA, tripId, stop, { arrive: '2026-05-01', depart: '2026-05-02' }),
    );
    expect(refused.failure).toMatchObject({ reason: 'items', days: ['2026-05-03'] });
    expect(await count('item')).toBe(1);
    await moveDayItems(deps, ADA, tripId, day3, day1);
    const plan = await updateStop(deps, ADA, tripId, stop, {
      arrive: '2026-05-01',
      depart: '2026-05-02',
    });
    expect(itemsOf(plan, day1).map((item) => item.title)).toEqual(['On the last day']);
    expect(itemsOf(plan, day1)[0]?.place?.name).toBe('Time Out Market');
  });

  it('goes through once its items are deleted, and their places with them', async () => {
    await add(day3, 'One', { place: lisbon });
    await add(day3, 'Two');
    const stop = await lisbonStop();
    await refusal(
      updateStop(deps, ADA, tripId, stop, { arrive: '2026-05-01', depart: '2026-05-02' }),
    );
    await clearDayItems(deps, ADA, tripId, day3);
    expect(await count('item')).toBe(0);
    expect(await count('place')).toBe(2);
    await updateStop(deps, ADA, tripId, stop, { arrive: '2026-05-01', depart: '2026-05-02' });
    expect(await count('day', sql`WHERE stop_id = ${stop}`)).toBe(2);
  });

  it('moves a whole day’s items in their order to the end of another day, in the limit, and by an editor only', async () => {
    for (const title of ['M1', 'M2', 'M3']) await add(day1, title);
    await add(day2, 'Already');
    const plan = await moveDayItems(deps, ADA, tripId, day1, day2);
    expect(itemsOf(plan, day2).map((item) => item.title)).toEqual(['Already', 'M1', 'M2', 'M3']);
    expect(itemsOf(plan, day1)).toEqual([]);
    await refusal(moveDayItems(deps, ADA, tripId, day2, day2));
    const limited = { ...deps, limits: { ...DEFAULT_LIMITS, dayItems: 3 } };
    // Four items into an empty day that holds three: refused, and they are where they were.
    expect((await refusal(moveDayItems(limited, ADA, tripId, day2, day3))).failure).toMatchObject({
      reason: 'limit',
    });
    expect(await titles(day2)).toEqual(['Already', 'M1', 'M2', 'M3']);
    expect(await moveDayItems(deps, NOOR, tripId, day2, day3)).toBeUndefined();
    expect(await clearDayItems(deps, NOOR, tripId, day2)).toBeUndefined();
    expect(await clearDayItems(deps, STRANGER, tripId, day2)).toBeUndefined();
    expect(await moveDayItems(deps, ADA, tripId, day2, randomUUID())).toBeUndefined();
  });

  it('is taken with its items when its stop is removed, and the places nothing names go too', async () => {
    await add(day1, 'Lisbon thing', { place: lisbon });
    await add(day2, 'Another', { place: { name: 'Elsewhere', lat: 38.7, lng: -9.1 } });
    await removeStop(deps, ADA, tripId, await lisbonStop());
    expect(await count('item')).toBe(0);
    expect(await count('day')).toBe(2);
    expect(await count('place')).toBe(1);
  });

  it('is deleted with the trip, items and all', async () => {
    await add(day1, 'x', { place: lisbon });
    await deleteTrip(deps, ADA, tripId);
    for (const table of ['item', 'day', 'stop', 'place'])
      expect(await count(table, sql`WHERE trip_id = ${tripId}`), table).toBe(0);
  });
});
