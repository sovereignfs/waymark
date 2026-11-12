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
import { setPref } from '../notices/prefs';
import { applyTripMutation } from '../trips/sync';
import { applyOp } from '../trips/ops';
import { leaveTrip } from '../trips/leaving';
import { addItem, addStop } from '../trips/plan';
import { createTrip, deleteTrip, setReady } from '../trips/trips';
import { prefsOfMember, readPrefs, setPrefs } from './prefs';
import { pruneSent, sendReminders, KEEP_MS, type ReminderDeps } from './server';
import { TripError } from '../trips/format';

/**
 * Trip Mode's reminders (DESIGN.md §14.4), on whichever database the leg runs on, on a clock the test sets: sent to the members who go, once each however many workers there are, again for an item moved to a new time, never for an
 * untimed item or a Follower or a trip not yet ready, and through the channels each person chose.
 */
const { leg } = testTarget();
const ring = ringOf(randomBytes(32));
if (!ring) throw new Error('no ring');
const sealer = new Sealer(ring);
const [ADA, SAM, GRACE, NOOR, STRANGER] = ['ada', 'sam', 'grace', 'noor', 'stranger'];
let clock = Date.parse('2026-05-01T12:00:00Z');
let database: Database;
let close: () => Promise<void>;
const t = (name: string) => tableOf(database, name);
const at = (iso: string) => Date.parse(iso);
const deps = (delivery: ReminderDeps['delivery'] = undefined): ReminderDeps => ({
  database,
  sealer,
  now: () => clock,
  limits: DEFAULT_LIMITS,
  delivery,
});
const tripDeps = () => ({ database, sealer, now: () => ++clock, limits: DEFAULT_LIMITS });
const LISBON = { name: 'Lisbon', lat: 38.7223, lng: -9.1393 };

/** Ada organizes (and goes), Sam and Grace are Travelers, Noor a Follower; Lisbon 10 to 12 May; a fixed dinner at 19:00, a flexible lunch, an untimed walk on the 11th. Ready. */
async function trip(options: { ready?: boolean; adaGoes?: boolean } = {}) {
  clock = at('2026-05-01T12:00:00Z');
  const made = await createTrip(tripDeps(), ADA, { name: 'Iberia' });
  for (const [who, role] of [
    [SAM, 'traveler'],
    [GRACE, 'traveler'],
    [NOOR, 'follower'],
  ] as const)
    await dbAll(
      database,
      sql`INSERT INTO ${t('trip_member')} (trip_id, account_id, role, going, share_checkins, joined_at, seq) VALUES (${made.id}, ${who}, ${role}, ${role === 'traveler'}, 'ask', ${clock}, 2) RETURNING trip_id`,
    );
  if (options.adaGoes === false)
    await dbAll(
      database,
      sql`UPDATE ${t('trip_member')} SET going = ${false} WHERE trip_id = ${made.id} AND account_id = ${ADA} RETURNING trip_id`,
    );
  const plan = await addStop(tripDeps(), ADA, made.id, {
    place: LISBON,
    arrive: '2026-05-10',
    depart: '2026-05-12',
  });
  const day = plan?.stops[0]?.days[1];
  if (!day) throw new Error('no day');
  const ids: Record<string, string> = {};
  for (const [name, input] of [
    ['lunch', { title: 'Lunch', start: '13:00', kind: 'food' }],
    ['walk', { title: 'Walk' }],
    ['dinner', { title: 'Dinner', start: '19:00', fixed: true, kind: 'food' }],
  ] as const) {
    const added = await addItem(tripDeps(), ADA, made.id, { dayId: day.id, ...input });
    const found = added?.stops[0]?.days[1]?.items.find((each) => each.title === input.title);
    ids[name] = found?.id ?? '';
  }
  if (options.ready !== false) await setReady(tripDeps(), ADA, made.id, true);
  return { tripId: made.id, dayId: day.id, ids };
}
const run = async (iso: string, d: ReminderDeps = deps()) => {
  clock = at(iso);
  return sendReminders(d);
};
const REMINDERS = ['trip_starts', 'item_soon', 'day_plan'];
/** The reminders a person was told (a trip being made ready tells its members too, which is not what is looked at here). */
const told = async (who: string, kind?: string) =>
  (await listNotices({ database, sealer }, who, 50)).filter((n) =>
    kind ? n.kind === kind : REMINDERS.includes(n.kind),
  );

beforeAll(async () => {
  ({ database, close } = await makeStore());
});
afterAll(async () => close());
beforeEach(async () => {
  for (const table of [
    'push_outbox',
    'push_subscription',
    'reminder_sent',
    'reminder_pref',
    'item_done',
    'notice_pref',
    'notice',
    'relink',
    'trip_tombstone',
    'applied_mutation',
    'account_stream',
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

describe(`the start of a trip (${leg})`, () => {
  it('is told the evening before to every member who goes, once, and not to a Follower, nor before 18:00', async () => {
    await trip();
    expect((await run('2026-05-09T17:59:00+01:00')).sent).toBe(0);
    expect((await run('2026-05-09T18:00:00+01:00')).sent).toBe(3);
    for (const who of [ADA, SAM, GRACE])
      expect((await told(who, 'trip_starts')).length, who).toBe(1);
    expect(await told(NOOR)).toEqual([]);
    expect(await told(STRANGER)).toEqual([]);
    const notice = (await told(SAM, 'trip_starts'))[0];
    expect(notice?.title).toBe('“Iberia” starts tomorrow');
    expect(notice?.href).toMatch(/^\/t\/[0-9a-f-]+\/today$/);
    // Once: the minute after, and the hour after.
    expect((await run('2026-05-09T18:01:00+01:00')).sent).toBe(0);
    expect((await run('2026-05-09T23:00:00+01:00')).sent).toBe(0);
    expect((await told(SAM, 'trip_starts')).length).toBe(1);
  });

  it('is not sent to an Organizer who does not go, nor for a trip that is still being planned', async () => {
    await trip({ adaGoes: false });
    expect((await run('2026-05-09T18:00:00+01:00')).sent).toBe(2);
    expect(await told(ADA)).toEqual([]);
    await dbAll(database, sql`DELETE FROM ${t('reminder_sent')} RETURNING 1 AS gone`);
    await dbAll(database, sql`DELETE FROM ${t('notice')} RETURNING 1 AS gone`);
    await dbAll(database, sql`UPDATE ${t('trip')} SET ready_at = NULL RETURNING id`);
    expect((await run('2026-05-09T18:00:00+01:00')).sent).toBe(0);
  });

  it('is sent once with two workers running at the same moment', async () => {
    await trip();
    clock = at('2026-05-09T18:00:00+01:00');
    const [one, two] = await Promise.all([sendReminders(deps()), sendReminders(deps())]);
    expect(one.sent + two.sent).toBe(3);
    for (const who of [ADA, SAM, GRACE])
      expect((await told(who, 'trip_starts')).length, who).toBe(1);
  });
});

describe(`an item coming up (${leg})`, () => {
  it('is told half an hour before a fixed item, once, to those who go; not for a flexible item or one without a time', async () => {
    const { ids } = await trip();
    expect((await run('2026-05-11T18:29:00+01:00')).sent).toBe(0);
    expect((await run('2026-05-11T18:30:00+01:00')).sent).toBe(3);
    const notice = (await told(GRACE, 'item_soon'))[0];
    expect(notice?.title).toBe('Dinner in 30 minutes');
    expect(notice?.detail).toContain('19:00');
    expect(notice?.detail).toContain('Iberia');
    expect(await told(NOOR)).toEqual([]);
    expect((await run('2026-05-11T18:45:00+01:00')).sent).toBe(0);
    // The flexible lunch and the untimed walk were never reminded of.
    expect((await told(SAM)).map((n) => n.title)).toEqual(['Dinner in 30 minutes']);
    expect(ids.walk).toBeDefined();
  });

  it('is not told to someone who has marked the item done, and is told again when the item is moved to a new time', async () => {
    const { tripId, ids } = await trip();
    await applyTripMutation(tripDeps(), SAM, {
      mutationId: randomUUID(),
      stream: `trip:${tripId}`,
      changes: [{ table: 'item_done', op: 'put', id: ids.dinner }],
    });
    expect((await run('2026-05-11T18:30:00+01:00')).sent).toBe(2);
    expect(await told(SAM)).toEqual([]);
    // Moved to 21:00 by Ada: it reminds again at 20:30, to those who go (Sam's mark is on the item, still).
    await applyTripMutation(tripDeps(), ADA, {
      mutationId: randomUUID(),
      stream: `trip:${tripId}`,
      changes: [
        {
          table: 'item',
          op: 'put',
          id: ids.dinner,
          row: {
            dayId: (
              await dbGet<{ d: string }>(
                database,
                sql`SELECT day_id AS d FROM ${t('item')} WHERE id = ${ids.dinner}`,
              )
            )?.d,
            title: 'Dinner',
            kind: 'food',
            start: '21:00',
            end: null,
            fixed: true,
            placeId: null,
            position: 'a9',
          },
        },
      ],
    });
    expect((await run('2026-05-11T20:29:00+01:00')).sent).toBe(0);
    expect((await run('2026-05-11T20:30:00+01:00')).sent).toBe(2);
    expect((await told(ADA, 'item_soon')).length).toBe(2);
    expect((await told(GRACE, 'item_soon')).length).toBe(2);
  });

  it('follows each member’s own settings for the trip: lead time, flexible items, none at all', async () => {
    const { tripId } = await trip();
    await setPrefs({ database, now: () => clock }, SAM, tripId, { leadMin: 10, flexible: true });
    await setPrefs({ database, now: () => clock }, GRACE, tripId, { itemSoon: false });
    await run('2026-05-11T12:50:00+01:00');
    expect((await told(SAM, 'item_soon')).map((n) => n.title)).toEqual(['Lunch in 10 minutes']);
    expect(await told(GRACE)).toEqual([]);
    // The dinner, ten minutes ahead for Sam and half an hour for those who chose nothing.
    await run('2026-05-11T18:50:00+01:00');
    expect((await told(SAM, 'item_soon')).map((n) => n.title).sort()).toEqual(
      ['Dinner in 10 minutes', 'Lunch in 10 minutes'].sort(),
    );
    expect(await told(GRACE)).toEqual([]);
  });
});

describe(`the plan of the day (${leg})`, () => {
  it('is sent each morning only to those who asked, in one line', async () => {
    const { tripId } = await trip();
    await setPrefs({ database, now: () => clock }, SAM, tripId, { dayPlan: true, itemSoon: false });
    expect((await run('2026-05-11T07:59:00+01:00')).sent).toBe(0);
    expect((await run('2026-05-11T08:00:00+01:00')).sent).toBe(1);
    const notice = (await told(SAM, 'day_plan'))[0];
    expect(notice?.title).toBe('Today on “Iberia”');
    expect(notice?.detail).toBe('3 things planned, starting with Lunch.');
    expect((await run('2026-05-11T09:00:00+01:00')).sent).toBe(0);
    expect(await told(ADA, 'day_plan')).toEqual([]);
    // A day with nothing in it has no plan to say.
    expect((await run('2026-05-12T09:00:00+01:00')).sent).toBe(0);
  });
});

describe(`the channels (${leg})`, () => {
  it('reach the bell always, and a device by push only if the person turned push on and wants the kind by push', async () => {
    await trip();
    const device = randomUUID();
    await dbAll(
      database,
      sql`INSERT INTO ${t('push_subscription')} (id, account_id, endpoint_hash, last_ok_at, sealed, created_at, updated_at) VALUES (${device}, ${SAM}, 'h', NULL, ${sealer.seal('push_subscription', device, { endpoint: 'https://fcm.googleapis.com/x', keys: { p256dh: 'a', auth: 'b' } })}, ${clock}, ${clock}) RETURNING id`,
    );
    await run(
      '2026-05-09T18:00:00+01:00',
      deps(() => ({ push: true })),
    );
    expect((await told(SAM, 'trip_starts')).length).toBe(1);
    // By default a reminder is pushed; and the push says the kind and the path.
    const pushes = await dbAll<{ kind: string; path: string; account: string }>(
      database,
      sql`SELECT kind, path, account_id AS account FROM ${t('push_outbox')}`,
    );
    expect(pushes).toHaveLength(1);
    expect(pushes[0]).toMatchObject({ kind: 'trip_starts', account: SAM });
    expect(pushes[0]?.path).toMatch(/^\/t\/[0-9a-f-]+\/today$/);
    // Turned off for the kind: the bell still has it.
    await setPref(database, SAM, 'item_soon', 'push', false, clock);
    await run(
      '2026-05-11T18:30:00+01:00',
      deps(() => ({ push: true })),
    );
    expect((await told(SAM, 'item_soon')).length).toBe(1);
    expect(await dbAll(database, sql`SELECT id FROM ${t('push_outbox')}`)).toHaveLength(1);
  });
});

describe(`a member’s settings (${leg})`, () => {
  it('are theirs for the trip: the defaults, then what they change, within the limits, for Organizers and Travelers alone', async () => {
    const { tripId } = await trip();
    const d = { database, now: () => clock };
    expect(await readPrefs(d, SAM, tripId)).toEqual({
      tripStarts: true,
      itemSoon: true,
      leadMin: 30,
      flexible: false,
      dayPlan: false,
    });
    expect(await setPrefs(d, SAM, tripId, { leadMin: 45, dayPlan: true })).toEqual({
      tripStarts: true,
      itemSoon: true,
      leadMin: 45,
      flexible: false,
      dayPlan: true,
    });
    expect(await setPrefs(d, SAM, tripId, { flexible: true })).toMatchObject({
      leadMin: 45,
      flexible: true,
    });
    expect(await readPrefs(d, GRACE, tripId)).toMatchObject({ leadMin: 30, dayPlan: false });
    for (const bad of [
      { leadMin: 4 },
      { leadMin: 241 },
      { leadMin: 1.5 },
      { leadMin: '30' },
      { dayPlan: 'yes' },
      {},
    ])
      await expect(setPrefs(d, SAM, tripId, bad), JSON.stringify(bad)).rejects.toBeInstanceOf(
        TripError,
      );
    expect(await readPrefs(d, NOOR, tripId)).toBeUndefined();
    expect(await setPrefs(d, NOOR, tripId, { dayPlan: true })).toBeUndefined();
    expect(await readPrefs(d, STRANGER, tripId)).toBeUndefined();
    expect(await readPrefs(d, SAM, randomUUID())).toBeUndefined();
    expect(await readPrefs(d, SAM, 'nope')).toBeUndefined();
    expect(await prefsOfMember(database, tripId, NOOR)).toMatchObject({ leadMin: 30 });
  });

  it('are changed through the trip’s operations, and go when the person leaves or the trip is deleted', async () => {
    const { tripId } = await trip();
    const ops = { ...tripDeps(), media: undefined as never };
    expect(await applyOp(ops, SAM, { op: 'reminder.set', tripId, leadMin: 15 })).toMatchObject({
      ok: true,
      reminders: { leadMin: 15 },
    });
    expect(await applyOp(ops, SAM, { op: 'reminder.get', tripId })).toMatchObject({
      ok: true,
      reminders: { leadMin: 15 },
    });
    expect(await applyOp(ops, SAM, { op: 'reminder.set', tripId, leadMin: 1 })).toMatchObject({
      ok: false,
      reason: 'invalid',
    });
    expect(await applyOp(ops, NOOR, { op: 'reminder.get', tripId })).toEqual({
      ok: false,
      reason: 'not_found',
    });
    await run('2026-05-09T18:00:00+01:00');
    const count = async (table: string, who?: string) =>
      Number(
        (
          await dbGet<{ n: number | string }>(
            database,
            sql`SELECT COUNT(*) AS n FROM ${t(table)} ${who ? sql`WHERE account_id = ${who}` : sql``}`,
          )
        )?.n,
      );
    expect(await count('reminder_pref', SAM)).toBe(1);
    expect(await count('reminder_sent', SAM)).toBe(1);
    await leaveTrip(tripDeps(), SAM, tripId);
    expect(await count('reminder_pref', SAM)).toBe(0);
    expect(await count('reminder_sent', SAM)).toBe(0);
    expect(await count('reminder_sent')).toBeGreaterThan(0);
    await deleteTrip(tripDeps(), ADA, tripId);
    expect(await count('reminder_sent')).toBe(0);
    expect(await count('reminder_pref')).toBe(0);
  });

  it('forget what was sent after a month', async () => {
    await trip();
    await run('2026-05-09T18:00:00+01:00');
    expect(await pruneSent(database, clock + KEEP_MS - 1)).toBe(0);
    expect(await pruneSent(database, clock + KEEP_MS + 1000)).toBe(3);
  });
});
