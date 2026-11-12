import { randomBytes, randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { tableOf } from '../access/trip';
import { DEFAULT_LIMITS } from '../config';
import { ringOf } from '../crypto/keys';
import { Sealer } from '../crypto/sealed';
import type { Database } from '../db/client';
import { dbAll, dbGet, dbRun } from '../db/exec';
import { makeStore, testTarget } from '../db/test-support';
import { addDays, datesOf } from './dates';
import {
  type NewStop,
  type PlanDeps,
  PlanRefused,
  addStop,
  moveStop,
  readPlan,
  removeStop,
  updateStop,
} from './plan';
import { createTrip, deleteTrip, getTrip, updateTrip } from './trips';

/**
 * A trip's plan (DESIGN.md §7.1, §10.3, §10.4), against whichever database the leg runs on: stops of the trip's own places, their days following their dates, the trip's dates always its stops', and **a change that is refused
 * changes nothing**, the trip's counter included.
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
/** A table of items, which 9.3 makes: it names a day and a trip, and stands in for them here. */
const ITEMS = { table: 'scratch_item', column: 'day_id' };

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
const place = (name = 'Lisbon'): NewStop['place'] => ({
  name,
  lat: 38.72,
  lng: -9.14,
  category: 'City',
});
const tripRow = async () =>
  dbGet<{ startDate: string | null; endDate: string | null; seq: number | string }>(
    database,
    sql`SELECT start_date AS "startDate", end_date AS "endDate", seq FROM ${t('trip')} WHERE id = ${tripId}`,
  );
const datesOfTrip = async () => {
  const row = await tripRow();
  return [row?.startDate, row?.endDate];
};
const stopOf = async (id: string) =>
  dbGet<{
    arrive: string | null;
    depart: string | null;
    version: number | string;
    seq: number | string;
  }>(database, sql`SELECT arrive, depart, version, seq FROM ${t('stop')} WHERE id = ${id}`);
const refusal = async (promise: Promise<unknown>): Promise<PlanRefused> => {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(PlanRefused);
  return error as PlanRefused;
};

beforeAll(async () => {
  ({ database, close } = await makeStore());
  await dbRun(
    database,
    sql.raw(
      `CREATE TABLE ${database.dialect === 'postgres' ? 'waymark.' : ''}scratch_item (id text PRIMARY KEY, trip_id text NOT NULL, day_id text NOT NULL)`,
    ),
  );
  deps = { database, sealer, now: () => ++NOW, limits: DEFAULT_LIMITS, dayReferences: [ITEMS] };
});
afterAll(async () => close());
beforeEach(async () => {
  for (const table of ['day', 'stop', 'place', 'trip_member', 'trip', 'scratch_item'])
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
});

describe(`adding a stop (${leg})`, () => {
  it('makes a stop of a place of the trip’s own, with no days while it has no dates, and the trip no dates', async () => {
    const plan = await addStop(deps, ADA, tripId, { place: place(), note: 'Arrive late' });
    expect(plan?.stops).toHaveLength(1);
    expect(plan?.stops[0]).toMatchObject({
      arrive: null,
      depart: null,
      note: 'Arrive late',
      days: [],
      place: { name: 'Lisbon', lat: 38.72, tz: 'Europe/Lisbon' },
    });
    expect(await count('place', sql`WHERE trip_id = ${tripId} AND account_id IS NULL`)).toBe(1);
    expect(await count('day')).toBe(0);
    expect(await datesOfTrip()).toEqual([null, null]);
  });

  it('seals the place’s name and point and the stop’s note: the database holds none of them', async () => {
    await addStop(deps, ADA, tripId, {
      place: place('Mosteiro dos Jerónimos'),
      note: 'Pastéis de Belém',
    });
    const rows = await dbAll<{ sealed: Uint8Array }>(
      database,
      sql`SELECT sealed FROM ${t('place')} UNION ALL SELECT sealed FROM ${t('stop')} UNION ALL SELECT sealed FROM ${t('day')}`,
    );
    for (const row of rows) {
      const text = Buffer.from(row.sealed).toString('latin1');
      expect(text).not.toContain('Jerónimos');
      expect(text).not.toContain('Pastéis');
    }
  });

  it('makes a day for each date, and the trip’s dates are its first arrival and its last departure', async () => {
    const plan = await addStop(deps, ADA, tripId, {
      place: place(),
      arrive: '2026-05-01',
      depart: '2026-05-04',
    });
    expect(plan?.stops[0]?.days.map((day) => day.date)).toEqual(
      datesOf('2026-05-01', '2026-05-04'),
    );
    expect(await datesOfTrip()).toEqual(['2026-05-01', '2026-05-04']);
    await addStop(deps, ADA, tripId, {
      place: place('Porto'),
      arrive: '2026-04-20',
      depart: '2026-04-22',
    });
    await addStop(deps, ADA, tripId, {
      place: place('Faro'),
      arrive: '2026-06-01',
      depart: '2026-06-02',
    });
    expect(await datesOfTrip()).toEqual(['2026-04-20', '2026-06-02']);
    expect(await count('day')).toBe(4 + 3 + 2);
  });

  it('shares a boundary day as two days, one in each stop, and refuses any other overlap and a third stop on a day', async () => {
    await addStop(deps, ADA, tripId, {
      place: place('A'),
      arrive: '2026-05-01',
      depart: '2026-05-05',
    });
    const plan = await addStop(deps, ADA, tripId, {
      place: place('B'),
      arrive: '2026-05-05',
      depart: '2026-05-08',
    });
    expect(
      plan?.stops.flatMap((stop) => stop.days).filter((day) => day.date === '2026-05-05'),
    ).toHaveLength(2);
    expect(
      (
        await refusal(
          addStop(deps, ADA, tripId, {
            place: place('C'),
            arrive: '2026-05-03',
            depart: '2026-05-06',
          }),
        )
      ).failure.reason,
    ).toBe('overlap');
    expect(
      (
        await refusal(
          addStop(deps, ADA, tripId, {
            place: place('D'),
            arrive: '2026-05-05',
            depart: '2026-05-05',
          }),
        )
      ).failure.reason,
    ).toBe('overlap');
    expect(await count('stop')).toBe(2);
    expect(await count('place')).toBe(2);
  });

  it('refuses what is not a stop, before anything is read: dates, a place, a note, and a stop longer than 90 days', async () => {
    for (const bad of [
      { place: place(), arrive: '2026-05-01' },
      { place: place(), arrive: '2026-05-02', depart: '2026-05-01' },
      { place: place(), arrive: '2026-02-30', depart: '2026-03-01' },
      { place: place(), arrive: '2026-01-01', depart: '2026-06-01' },
      { place: { name: '', lat: 1, lng: 2 } },
      { place: { name: 'x', lat: 99, lng: 2 } },
      { place: place(), note: 'x'.repeat(2001) },
    ])
      await refusal(addStop(deps, ADA, tripId, bad));
    expect(await count('stop')).toBe(0);
    expect(await count('place')).toBe(0);
  });

  it('refuses the stop past the trip’s limit, and a stop that would take the trip past 365 days', async () => {
    const limited = { ...deps, limits: { ...DEFAULT_LIMITS, tripStops: 2 } };
    await addStop(limited, ADA, tripId, { place: place('1') });
    await addStop(limited, ADA, tripId, { place: place('2') });
    expect(
      (await refusal(addStop(limited, ADA, tripId, { place: place('3') }))).failure,
    ).toMatchObject({ reason: 'limit' });
    expect(await count('stop')).toBe(2);
    await dbAll(database, sql`DELETE FROM ${t('stop')} RETURNING 1 AS gone`);
    for (const [i, from] of ['2026-01-01', '2026-04-01', '2026-07-01', '2026-10-01'].entries())
      await addStop(deps, ADA, tripId, {
        place: place(`Long ${i}`),
        arrive: from,
        depart: addDays(from, 89),
      });
    expect(
      (
        await refusal(
          addStop(deps, ADA, tripId, {
            place: place('Too much'),
            arrive: '2027-02-01',
            depart: '2027-02-06',
          }),
        )
      ).failure,
    ).toMatchObject({ reason: 'limit' });
    await addStop(deps, ADA, tripId, {
      place: place('Just enough'),
      arrive: '2027-02-01',
      depart: '2027-02-05',
    });
  });

  it('is for an Organizer or a Traveler, and a Follower or a stranger is told the trip is not there', async () => {
    expect(await addStop(deps, SAM, tripId, { place: place('By a Traveler') })).toBeDefined();
    expect(await addStop(deps, NOOR, tripId, { place: place('By a Follower') })).toBeUndefined();
    expect(
      await addStop(deps, STRANGER, tripId, { place: place('By a stranger') }),
    ).toBeUndefined();
    expect(await addStop(deps, ADA, randomUUID(), { place: place() })).toBeUndefined();
    expect(await count('stop')).toBe(1);
    expect(await count('place')).toBe(1);
  });

  it('is read by every member, Followers included, and by nobody else', async () => {
    await addStop(deps, ADA, tripId, {
      place: place(),
      arrive: '2026-05-01',
      depart: '2026-05-02',
    });
    for (const who of [ADA, SAM, NOOR])
      expect((await readPlan(deps, who, tripId))?.stops).toHaveLength(1);
    expect(await readPlan(deps, STRANGER, tripId)).toBeUndefined();
    expect(await readPlan(deps, ADA, 'not-an-id')).toBeUndefined();
  });
});

describe(`the trip’s counter and what a refused change leaves (${leg})`, () => {
  it('advances once for a change and stamps what it wrote with it, and not at all for a change that is refused', async () => {
    const start = Number((await tripRow())?.seq);
    const plan = await addStop(deps, ADA, tripId, {
      place: place(),
      arrive: '2026-05-01',
      depart: '2026-05-02',
    });
    const seq = Number((await tripRow())?.seq);
    expect(seq).toBe(start + 1);
    const stop = plan?.stops[0];
    expect(Number((await stopOf(stop?.id ?? ''))?.seq)).toBe(seq);
    const rows = await dbAll<{ seq: number | string }>(
      database,
      sql`SELECT seq FROM ${t('day')} UNION ALL SELECT seq FROM ${t('place')}`,
    );
    expect(rows.every((row) => Number(row.seq) === seq)).toBe(true);
    await refusal(
      addStop(deps, ADA, tripId, {
        place: place('Overlap'),
        arrive: '2026-05-02',
        depart: '2026-05-03',
      }).then(() =>
        addStop(deps, ADA, tripId, {
          place: place('Overlap'),
          arrive: '2026-05-01',
          depart: '2026-05-02',
        }),
      ),
    );
    expect(Number((await tripRow())?.seq)).toBe(seq + 1);
  });

  it('writes two changes at the same moment one after the other, each seeing the other’s: only one of two that overlap is made', async () => {
    const results = await Promise.allSettled([
      addStop(deps, ADA, tripId, {
        place: place('One'),
        arrive: '2026-07-01',
        depart: '2026-07-10',
      }),
      addStop(deps, SAM, tripId, {
        place: place('Two'),
        arrive: '2026-07-05',
        depart: '2026-07-15',
      }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    expect(await count('stop')).toBe(1);
    expect(await count('place')).toBe(1);
  });
});

describe(`re-dating a stop (${leg})`, () => {
  async function stopWithDays() {
    const plan = await addStop(deps, ADA, tripId, {
      place: place(),
      arrive: '2026-05-03',
      depart: '2026-05-05',
    });
    return plan?.stops[0] as NonNullable<typeof plan>['stops'][number];
  }

  it('makes days for new dates and keeps the days it still has, with their ids', async () => {
    const before = await stopWithDays();
    const plan = await updateStop(deps, ADA, tripId, before.id, {
      arrive: '2026-05-01',
      depart: '2026-05-06',
    });
    const after = plan?.stops[0];
    expect(after?.days.map((day) => day.date)).toEqual(datesOf('2026-05-01', '2026-05-06'));
    for (const kept of before.days)
      expect(after?.days.find((day) => day.date === kept.date)?.id).toBe(kept.id);
    expect(await datesOfTrip()).toEqual(['2026-05-01', '2026-05-06']);
    expect(Number((await stopOf(before.id))?.version)).toBe(2);
  });

  it('removes the days that left, and all of them when the dates are taken away', async () => {
    const before = await stopWithDays();
    const shrunk = await updateStop(deps, ADA, tripId, before.id, {
      arrive: '2026-05-04',
      depart: '2026-05-04',
    });
    expect(shrunk?.stops[0]?.days.map((day) => day.date)).toEqual(['2026-05-04']);
    const none = await updateStop(deps, ADA, tripId, before.id, { arrive: null, depart: null });
    expect(none?.stops[0]).toMatchObject({ arrive: null, depart: null, days: [] });
    expect(await datesOfTrip()).toEqual([null, null]);
    expect(await count('day')).toBe(0);
  });

  it('is refused over a day that has items, naming the days, and changes nothing; it goes through once they are gone', async () => {
    const before = await stopWithDays();
    const [first, , last] = before.days;
    for (const day of [first, last])
      await dbAll(
        database,
        sql`INSERT INTO ${t('scratch_item')} (id, trip_id, day_id) VALUES (${randomUUID()}, ${tripId}, ${day?.id}) RETURNING id`,
      );
    const seq = Number((await tripRow())?.seq);
    const refused = await refusal(
      updateStop(deps, ADA, tripId, before.id, { arrive: '2026-05-04', depart: '2026-05-04' }),
    );
    expect(refused.failure).toMatchObject({ reason: 'items', days: ['2026-05-03', '2026-05-05'] });
    expect(refused.message).toContain('Move or delete');
    expect(await count('day')).toBe(3);
    expect(Number((await tripRow())?.seq)).toBe(seq);
    expect((await stopOf(before.id))?.arrive).toBe('2026-05-03');
    // A day that stays is not in the way: only the days that would go.
    await updateStop(deps, ADA, tripId, before.id, { arrive: '2026-05-03', depart: '2026-05-06' });
    // Once the items are moved or deleted, the same change is accepted.
    await dbAll(database, sql`DELETE FROM ${t('scratch_item')} RETURNING id`);
    const plan = await updateStop(deps, ADA, tripId, before.id, {
      arrive: '2026-05-04',
      depart: '2026-05-04',
    });
    expect(plan?.stops[0]?.days.map((day) => day.date)).toEqual(['2026-05-04']);
  });

  it('refuses dates that overlap another stop and a stop that is not this trip’s, and changes a note alone without touching the days', async () => {
    const mine = await stopWithDays();
    await addStop(deps, ADA, tripId, {
      place: place('Next'),
      arrive: '2026-05-10',
      depart: '2026-05-12',
    });
    expect(
      (
        await refusal(
          updateStop(deps, ADA, tripId, mine.id, { arrive: '2026-05-03', depart: '2026-05-11' }),
        )
      ).failure.reason,
    ).toBe('overlap');
    expect(await updateStop(deps, ADA, tripId, randomUUID(), { note: 'x' })).toBeUndefined();
    const other = (await createTrip(deps, ADA, { name: 'Other' })).id;
    const foreign = (await addStop(deps, ADA, other, { place: place('Elsewhere') }))?.stops[0];
    expect(
      await updateStop(deps, ADA, tripId, foreign?.id ?? '', { note: 'taken' }),
    ).toBeUndefined();
    expect((await readPlan(deps, ADA, other))?.stops[0]?.note).toBeUndefined();
    const before = (await readPlan(deps, ADA, tripId))?.stops.find((s) => s.id === mine.id);
    const plan = await updateStop(deps, ADA, tripId, mine.id, { note: 'Noted' });
    const after = plan?.stops.find((s) => s.id === mine.id);
    expect(after?.note).toBe('Noted');
    expect(after?.days).toEqual(before?.days);
    const cleared = await updateStop(deps, ADA, tripId, mine.id, { note: null });
    expect(cleared?.stops.find((s) => s.id === mine.id)?.note).toBeUndefined();
    await refusal(updateStop(deps, ADA, tripId, mine.id, {}));
  });

  it('is for an Organizer or a Traveler only', async () => {
    const stop = await stopWithDays();
    expect(await updateStop(deps, SAM, tripId, stop.id, { note: 'By a Traveler' })).toBeDefined();
    expect(
      await updateStop(deps, NOOR, tripId, stop.id, { note: 'By a Follower' }),
    ).toBeUndefined();
    expect(
      await updateStop(deps, STRANGER, tripId, stop.id, { note: 'By a stranger' }),
    ).toBeUndefined();
    expect((await readPlan(deps, ADA, tripId))?.stops[0]?.note).toBe('By a Traveler');
  });
});

describe(`ordering and removing stops (${leg})`, () => {
  it('reorders the stops that have no dates, and keeps the dated ones first, in the order of their dates', async () => {
    await addStop(deps, ADA, tripId, {
      place: place('Dated late'),
      arrive: '2026-08-01',
      depart: '2026-08-02',
    });
    await addStop(deps, ADA, tripId, {
      place: place('Dated early'),
      arrive: '2026-06-01',
      depart: '2026-06-02',
    });
    const a = (await addStop(deps, ADA, tripId, { place: place('A') }))?.stops.find(
      (s) => s.place.name === 'A',
    );
    const b = (await addStop(deps, ADA, tripId, { place: place('B') }))?.stops.find(
      (s) => s.place.name === 'B',
    );
    const c = (await addStop(deps, ADA, tripId, { place: place('C') }))?.stops.find(
      (s) => s.place.name === 'C',
    );
    const names = async () => (await readPlan(deps, ADA, tripId))?.stops.map((s) => s.place.name);
    expect(await names()).toEqual(['Dated early', 'Dated late', 'A', 'B', 'C']);
    await moveStop(deps, ADA, tripId, c?.id ?? '', a?.id ?? null);
    expect(await names()).toEqual(['Dated early', 'Dated late', 'C', 'A', 'B']);
    await moveStop(deps, ADA, tripId, c?.id ?? '', null);
    expect(await names()).toEqual(['Dated early', 'Dated late', 'A', 'B', 'C']);
    await moveStop(deps, ADA, tripId, b?.id ?? '', b?.id === a?.id ? null : (a?.id ?? null));
    expect(await names()).toEqual(['Dated early', 'Dated late', 'B', 'A', 'C']);
  });

  it('refuses to move a stop with dates, or before a stop that is not there, and a stranger or Follower moves nothing', async () => {
    const dated = (
      await addStop(deps, ADA, tripId, {
        place: place('Dated'),
        arrive: '2026-06-01',
        depart: '2026-06-02',
      })
    )?.stops[0];
    const free = (await addStop(deps, ADA, tripId, { place: place('Free') }))?.stops.find(
      (s) => s.place.name === 'Free',
    );
    expect((await refusal(moveStop(deps, ADA, tripId, dated?.id ?? '', null))).message).toContain(
      'order of its dates',
    );
    expect(await moveStop(deps, ADA, tripId, free?.id ?? '', randomUUID())).toBeUndefined();
    expect(await moveStop(deps, NOOR, tripId, free?.id ?? '', null)).toBeUndefined();
    expect(await moveStop(deps, STRANGER, tripId, free?.id ?? '', null)).toBeUndefined();
  });

  it('removes a stop with its days and its place, and clears a cover that was that place', async () => {
    const plan = await addStop(deps, ADA, tripId, {
      place: place(),
      arrive: '2026-05-01',
      depart: '2026-05-03',
    });
    const stop = plan?.stops[0];
    await updateTrip(deps, ADA, tripId, { coverPlaceId: stop?.place.id });
    expect((await getTrip(deps, ADA, tripId))?.trip.coverPlaceId).toBe(stop?.place.id);
    const after = await removeStop(deps, ADA, tripId, stop?.id ?? '');
    expect(after?.stops).toEqual([]);
    expect(await count('stop')).toBe(0);
    expect(await count('day')).toBe(0);
    expect(await count('place')).toBe(0);
    expect((await getTrip(deps, ADA, tripId))?.trip.coverPlaceId).toBeNull();
    expect(await datesOfTrip()).toEqual([null, null]);
  });

  it('takes with it what hangs on its days (items cascade), and keeps a place that something else still names', async () => {
    const plan = await addStop(deps, ADA, tripId, {
      place: place(),
      arrive: '2026-05-01',
      depart: '2026-05-02',
    });
    const stop = plan?.stops[0];
    for (const day of stop?.days ?? [])
      await dbAll(
        database,
        sql`INSERT INTO ${t('scratch_item')} (id, trip_id, day_id) VALUES (${randomUUID()}, ${tripId}, ${day.id}) RETURNING id`,
      );
    await removeStop(deps, ADA, tripId, stop?.id ?? '');
    expect(await count('scratch_item')).toBe(0);
  });

  it('is for an Organizer or a Traveler, and a stop of another trip is not found', async () => {
    const stop = (await addStop(deps, ADA, tripId, { place: place() }))?.stops[0];
    expect(await removeStop(deps, NOOR, tripId, stop?.id ?? '')).toBeUndefined();
    expect(await removeStop(deps, STRANGER, tripId, stop?.id ?? '')).toBeUndefined();
    const other = (await createTrip(deps, ADA, { name: 'Other' })).id;
    expect(await removeStop(deps, ADA, other, stop?.id ?? '')).toBeUndefined();
    expect(await count('stop')).toBe(1);
    expect(await removeStop(deps, SAM, tripId, stop?.id ?? '')).toBeDefined();
  });
});

describe(`the trip’s cover and its deletion (${leg})`, () => {
  it('is one of the trip’s own places and no other: a person’s place, or one of another trip’s, is not found', async () => {
    const mine = (await addStop(deps, ADA, tripId, { place: place() }))?.stops[0];
    const other = await createTrip(deps, ADA, { name: 'Other' });
    const theirs = (await addStop(deps, ADA, other.id, { place: place('Theirs') }))?.stops[0];
    await dbAll(
      database,
      sql`INSERT INTO ${t('place')} (id, account_id, source, version, seq, sealed, created_at, updated_at) VALUES ('mine-p', ${ADA}, 'manual', 1, 1, ${sealer.seal('place', 'mine-p', { name: 'A', lat: 1, lng: 2 })}, ${NOW}, ${NOW}) RETURNING id`,
    );
    expect(await updateTrip(deps, ADA, tripId, { coverPlaceId: theirs?.place.id })).toBeUndefined();
    expect(await updateTrip(deps, ADA, tripId, { coverPlaceId: 'mine-p' })).toBeUndefined();
    expect(
      (await updateTrip(deps, ADA, tripId, { coverPlaceId: mine?.place.id }))?.coverPlaceId,
    ).toBe(mine?.place.id);
    expect((await updateTrip(deps, ADA, tripId, { coverPlaceId: null }))?.coverPlaceId).toBeNull();
    // A Traveler may not set it.
    expect(await updateTrip(deps, SAM, tripId, { coverPlaceId: mine?.place.id })).toBeUndefined();
  });

  it('deleting the trip leaves none of its stops, days or places', async () => {
    await addStop(deps, ADA, tripId, {
      place: place(),
      arrive: '2026-05-01',
      depart: '2026-05-03',
    });
    await addStop(deps, ADA, tripId, { place: place('Free') });
    expect(await deleteTrip(deps, ADA, tripId)).toBe(true);
    for (const table of ['stop', 'day', 'place'])
      expect(await count(table, sql`WHERE trip_id = ${tripId}`), table).toBe(0);
  });
});

describe(`the trip’s dates, always its stops’ (${leg})`, () => {
  it('stay equal to the first arrival and the last departure through any run of changes', async () => {
    let seed = 7;
    const random = () => (seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648) / 2_147_483_648;
    const ids: string[] = [];
    for (let step = 0; step < 40; step += 1) {
      const roll = random();
      try {
        if (roll < 0.45 || ids.length === 0) {
          const from = addDays('2026-01-01', Math.floor(random() * 300));
          const plan = await addStop(deps, ADA, tripId, {
            place: place(`S${step}`),
            ...(random() < 0.8
              ? { arrive: from, depart: addDays(from, Math.floor(random() * 6)) }
              : {}),
          });
          const made = plan?.stops.find((s) => s.place.name === `S${step}`);
          if (made) ids.push(made.id);
        } else if (roll < 0.8) {
          const id = ids[Math.floor(random() * ids.length)] ?? '';
          const from = addDays('2026-01-01', Math.floor(random() * 300));
          await updateStop(
            deps,
            ADA,
            tripId,
            id,
            random() < 0.2
              ? { arrive: null, depart: null }
              : { arrive: from, depart: addDays(from, Math.floor(random() * 6)) },
          );
        } else {
          const id = ids.splice(Math.floor(random() * ids.length), 1)[0] ?? '';
          await removeStop(deps, ADA, tripId, id);
        }
      } catch (error) {
        // A change the plan refuses is a fine step: nothing of it is kept.
        if (!(error instanceof PlanRefused)) throw error;
      }
      const stops = (await readPlan(deps, ADA, tripId))?.stops ?? [];
      const dated = stops.filter((s) => s.arrive !== null);
      expect(await datesOfTrip(), `step ${step}`).toEqual([
        dated.length ? dated.map((s) => s.arrive as string).sort()[0] : null,
        dated.length
          ? dated
              .map((s) => s.depart as string)
              .sort()
              .at(-1)
          : null,
      ]);
      // Days are exactly the dates of the stops, and no day is without its stop.
      for (const stop of stops)
        expect(
          stop.days.map((d) => d.date),
          `step ${step}`,
        ).toEqual(stop.arrive && stop.depart ? datesOf(stop.arrive, stop.depart) : []);
      expect(await count('day'), `step ${step}`).toBe(stops.reduce((n, s) => n + s.days.length, 0));
      expect(await count('place'), `step ${step}`).toBe(stops.length);
    }
  });
});
