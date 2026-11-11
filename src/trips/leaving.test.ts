import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import sharp from 'sharp';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { lockStreams } from '../access/locks';
import { tableOf } from '../access/trip';
import { workOnRelinks, enqueueRelink } from '../autolink/queue';
import { DEFAULT_LIMITS } from '../config';
import { ringOf } from '../crypto/keys';
import { Sealer } from '../crypto/sealed';
import type { Database } from '../db/client';
import { dbAll, dbGet, transaction } from '../db/exec';
import { makeStore, testTarget } from '../db/test-support';
import { putMedia } from '../media/service';
import { listNotices } from '../notices/notices';
import { listShared } from '../sharing/read';
import { applyMutation } from '../sync/apply';
import { pullTrips } from '../sync/trips';
import { readFileFor } from './attachments';
import { TripError } from './format';
import { leaveTrip, removeMember } from './leaving';
import { addItem, addStop } from './plan';
import { createTrip, getTrip } from './trips';

/**
 * Leaving, removing and handing over (DESIGN.md §11.4), against whichever database the leg runs on: a person who leaves or is removed has **nothing of their check-ins left in the trip** (unlinked in their own stream, unshared in the trip's)
 * and keeps all of them; what they planned stays; **a trip never has no Organizer**, whoever leaves or is removed and however many at once.
 */
const { leg } = testTarget();
const ring = ringOf(randomBytes(32));
if (!ring) throw new Error('no ring');
const sealer = new Sealer(ring);
const [ADA, BEN, SAM, GRACE, NOOR, STRANGER] = ['ada', 'ben', 'sam', 'grace', 'noor', 'stranger'];
let NOW = Date.parse('2026-09-01T12:00:00Z');
let database: Database;
let close: () => Promise<void>;
let directory: string;
let deps: Parameters<typeof createTrip>[0] & { media: Parameters<typeof putMedia>[0] };
const t = (name: string) => tableOf(database, name);
const LISBON = { name: 'Lisbon', lat: 38.7223, lng: -9.1393 };
const picture = () =>
  sharp({ create: { width: 40, height: 30, channels: 3, background: { r: 10, g: 120, b: 30 } } })
    .png()
    .toBuffer();

/** Ada organizes; Ben is a second Organizer when asked; Sam and Grace are Travelers; Noor a Follower. One stop makes 12 May fall into the trip. */
async function trip(options: { second?: boolean } = {}) {
  const made = await createTrip(deps, ADA, { name: 'Iberia' });
  const people: [string, string][] = [
    [SAM, 'traveler'],
    [GRACE, 'traveler'],
    [NOOR, 'follower'],
    ...(options.second ? ([[BEN, 'organizer']] as [string, string][]) : []),
  ];
  for (const [who, role] of people)
    await dbAll(
      database,
      sql`INSERT INTO ${t('trip_member')} (trip_id, account_id, role, going, share_checkins, joined_at, seq) VALUES (${made.id}, ${who}, ${role}, ${role !== 'follower'}, 'ask', ${NOW}, 2) RETURNING trip_id`,
    );
  await addStop(deps, ADA, made.id, { place: LISBON, arrive: '2026-05-10', depart: '2026-05-14' });
  return made.id;
}
async function checkIn(who: string, options: { share?: 'on'; photo?: string } = {}) {
  const placeId = randomUUID();
  const id = randomUUID();
  const result = await applyMutation({ database, sealer, now: () => NOW }, who, {
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
        id,
        row: {
          placeId,
          at: Date.parse('2026-05-12T12:00:00+01:00'),
          tz: 'Europe/Lisbon',
          offsetMin: 60,
          note: `${who}'s note`,
          companions: [],
          tripId: null,
          linkSource: null,
          share: options.share ?? 'trip',
          source: 'live',
          ...(options.photo ? { photos: [options.photo] } : {}),
        },
      },
    ],
  });
  if (result.status !== 'applied') throw new Error('not applied');
  return id;
}
const row = (id: string) =>
  dbGet<{
    tripId: string | null;
    linkSource: string | null;
    version: number | string;
    seq: number | string;
  }>(
    database,
    sql`SELECT trip_id AS "tripId", link_source AS "linkSource", version, seq FROM ${t('checkin')} WHERE id = ${id}`,
  );
const roles = async (tripId: string) =>
  Object.fromEntries(
    (
      await dbAll<{ id: string; role: string; left: number | string | null }>(
        database,
        sql`SELECT account_id AS id, role, left_at AS "left" FROM ${t('trip_member')} WHERE trip_id = ${tripId}`,
      )
    ).map((m) => [m.id, m.left === null ? m.role : 'left']),
  );
const copies = async (who: string) =>
  Number(
    (
      await dbGet<{ n: number | string }>(
        database,
        sql`SELECT COUNT(*) AS n FROM ${t('shared_checkin')} WHERE account_id = ${who}`,
      )
    )?.n ?? 0,
  );
const refusal = async (promise: Promise<unknown>) => {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(TripError);
  return (error as TripError).message;
};

beforeAll(async () => {
  ({ database, close } = await makeStore());
  directory = mkdtempSync(path.join(tmpdir(), 'waymark-leaving-'));
  deps = {
    database,
    sealer,
    now: () => ++NOW,
    limits: DEFAULT_LIMITS,
    media: {
      database,
      ring,
      dir: path.join(directory, 'media'),
      maxAccountBytes: 1 << 30,
      now: () => NOW,
    },
  };
});
afterAll(async () => {
  await close();
  rmSync(directory, { recursive: true, force: true });
});
beforeEach(async () => {
  rmSync(deps.media.dir, { recursive: true, force: true });
  for (const table of [
    'trip_tombstone',
    'shared_checkin',
    'notice',
    'notice_pref',
    'relink',
    'checkin_photo',
    'media',
    'checkin',
    'account_stream',
    'applied_mutation',
    'tombstone',
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

describe(`leaving a trip (${leg})`, () => {
  it('ends the membership and leaves nothing of the person’s check-ins in the trip: unlinked in their own stream, unshared in the trip’s, and still theirs', async () => {
    const tripId = await trip();
    const mine = await checkIn(SAM, { share: 'on' });
    const hers = await checkIn(GRACE, { share: 'on' });
    expect((await row(mine))?.tripId).toBe(tripId);
    expect((await listShared(database, sealer, NOOR, tripId))?.map((c) => c.id).sort()).toEqual(
      [mine, hers].sort(),
    );
    const before = await row(mine);
    const cursor =
      (await pullTrips(deps, NOOR, { [tripId]: { cursor: 0, floor: 0 } }, 100)).trips[0]?.cursor ??
      0;

    expect(await leaveTrip(deps, SAM, tripId)).toEqual({ left: true });

    expect(await roles(tripId)).toMatchObject({
      [SAM]: 'left',
      [GRACE]: 'traveler',
      [ADA]: 'organizer',
    });
    // Theirs: unlinked, a new version and number so their devices find out, and not deleted.
    const after = await row(mine);
    expect(after).toMatchObject({ tripId: null, linkSource: null });
    expect(Number(after?.version)).toBe(Number(before?.version) + 1);
    expect(Number(after?.seq)).toBeGreaterThan(Number(before?.seq));
    // The trip's stream: nothing of theirs, and the others’ untouched; the removal is told to the members' devices.
    expect(await copies(SAM)).toBe(0);
    expect((await listShared(database, sealer, NOOR, tripId))?.map((c) => c.id)).toEqual([hers]);
    expect((await row(hers))?.tripId).toBe(tripId);
    const page = (await pullTrips(deps, NOOR, { [tripId]: { cursor, floor: 0 } }, 100)).trips[0];
    expect(page?.deleted).toEqual([{ table: 'shared_checkin', id: mine, seq: expect.any(Number) }]);
    expect(page?.sets?.members.map((m) => m.accountId)).not.toContain(SAM);
    // They are told the trip is gone from their device, and cannot see it.
    expect((await pullTrips(deps, SAM, { [tripId]: { cursor: 1, floor: 0 } }, 100)).gone).toEqual([
      tripId,
    ]);
    expect(await getTrip(deps, SAM, tripId)).toBeUndefined();
    expect(await listShared(database, sealer, SAM, tripId)).toBeUndefined();
    // Nothing links them again.
    await enqueueRelink(deps.database, tripId, NOW);
    await workOnRelinks({ database, sealer, now: () => NOW }, { budgetMs: 5_000 });
    expect((await row(mine))?.tripId).toBeNull();
  });

  it('keeps what they planned and attached, as the trip’s, and their photos stop being served to the trip', async () => {
    const tripId = await trip();
    const plan = await addStop(deps, SAM, tripId, {
      place: { name: 'Porto', lat: 41.15, lng: -8.62 },
      arrive: '2026-05-20',
      depart: '2026-05-21',
    });
    const dayId = plan?.stops.find((s) => s.arrive === '2026-05-20')?.days[0]?.id ?? '';
    await addItem(deps, SAM, tripId, { dayId, title: 'Wine cellar' });
    const photo = randomUUID();
    const stored = await putMedia(deps.media, {
      accountId: SAM,
      kind: 'photo',
      bytes: await picture(),
      id: photo,
    });
    if (!stored.ok) throw new Error('not stored');
    await checkIn(SAM, { share: 'on', photo });
    expect(await readFileFor(deps.media, NOOR, photo)).toBeDefined();
    await leaveTrip(deps, SAM, tripId);
    expect(await readFileFor(deps.media, NOOR, photo)).toBeUndefined();
    expect(await readFileFor(deps.media, SAM, photo)).toBeDefined();
    const kept = await dbGet<{ n: number | string }>(
      database,
      sql`SELECT COUNT(*) AS n FROM ${t('item')} WHERE trip_id = ${tripId}`,
    );
    expect(Number(kept?.n)).toBe(1);
  });

  it('is any member’s: a Follower leaves too; a person who is not in the trip, has left, or a trip that is not there are told it is not there', async () => {
    const tripId = await trip();
    expect(await leaveTrip(deps, NOOR, tripId)).toEqual({ left: true });
    expect(await leaveTrip(deps, NOOR, tripId)).toBeUndefined();
    expect(await leaveTrip(deps, STRANGER, tripId)).toBeUndefined();
    expect(await leaveTrip(deps, ADA, randomUUID())).toBeUndefined();
    expect(await leaveTrip(deps, ADA, 'nope')).toBeUndefined();
  });
});

describe(`the last Organizer (${leg})`, () => {
  it('must name another first: with people in the trip it is refused in words, and nothing is changed', async () => {
    const tripId = await trip();
    expect(await refusal(leaveTrip(deps, ADA, tripId))).toContain('choose who takes over');
    expect(await refusal(leaveTrip(deps, ADA, tripId, STRANGER))).toContain(
      'choose who takes over',
    );
    expect(await refusal(leaveTrip(deps, ADA, tripId, 'nobody'))).toContain(
      'choose who takes over',
    );
    expect(await roles(tripId)).toMatchObject({ [ADA]: 'organizer' });
  });

  it('hands the trip over in the same transaction to the one named, whatever their part, and tells them', async () => {
    const tripId = await trip();
    await checkIn(ADA, { share: 'on' });
    expect(await leaveTrip(deps, ADA, tripId, NOOR)).toEqual({ left: true });
    expect(await roles(tripId)).toMatchObject({
      [ADA]: 'left',
      [NOOR]: 'organizer',
      [SAM]: 'traveler',
    });
    const told = await listNotices({ database, sealer }, NOOR, 10);
    expect(told.map((n) => n.kind)).toEqual(['role_changed']);
    expect(JSON.stringify(told)).toContain('Iberia');
    expect(await copies(ADA)).toBe(0);
  });

  it('is nobody’s to name when they are alone: leaving is refused and deleting is the way', async () => {
    const made = await createTrip(deps, ADA, { name: 'Solo' });
    expect(await refusal(leaveTrip(deps, ADA, made.id))).toContain('delete it');
  });

  it('is not asked to name anyone when another Organizer remains, and a name given then changes nobody', async () => {
    const tripId = await trip({ second: true });
    expect(await leaveTrip(deps, ADA, tripId, GRACE)).toEqual({ left: true });
    expect(await roles(tripId)).toMatchObject({
      [ADA]: 'left',
      [BEN]: 'organizer',
      [GRACE]: 'traveler',
    });
    // Ben is now the last.
    expect(await refusal(leaveTrip(deps, BEN, tripId))).toContain('choose who takes over');
  });

  it('is never lost to two Organizers leaving at the same moment', async () => {
    const tripId = await trip({ second: true });
    const results = await Promise.allSettled([
      leaveTrip(deps, ADA, tripId, SAM),
      leaveTrip(deps, BEN, tripId, SAM),
    ]);
    const standing = Object.values(await roles(tripId)).filter((r) => r === 'organizer');
    expect(standing.length).toBeGreaterThanOrEqual(1);
    expect(
      results.filter((r) => r.status === 'fulfilled' && r.value).length,
    ).toBeGreaterThanOrEqual(1);
  });
});

describe(`removing a person (${leg})`, () => {
  it('is an Organizer’s: the same effect on their check-ins, and they are told in the bell, in words that name the trip and no one', async () => {
    const tripId = await trip();
    const mine = await checkIn(SAM, { share: 'on' });
    const removed = await removeMember(deps, ADA, tripId, SAM);
    expect(removed?.id).toBe(tripId);
    expect(await roles(tripId)).toMatchObject({ [SAM]: 'left' });
    expect(await row(mine)).toMatchObject({ tripId: null, linkSource: null });
    expect(await copies(SAM)).toBe(0);
    expect((await pullTrips(deps, SAM, { [tripId]: { cursor: 1, floor: 0 } }, 100)).gone).toEqual([
      tripId,
    ]);
    const told = await listNotices({ database, sealer }, SAM, 10);
    expect(told.map((n) => n.kind)).toEqual(['role_changed']);
    expect(JSON.stringify(told)).toContain('removed from “Iberia”');
    expect(JSON.stringify(told)).not.toContain('Ada');
    expect(await listNotices({ database, sealer }, ADA, 10)).toEqual([]);
  });

  it('is refused to a Traveler, a Follower, a stranger and a trip that is not there, all as not found; and of someone who is not in it', async () => {
    const tripId = await trip();
    for (const who of [SAM, NOOR, STRANGER])
      expect(await removeMember(deps, who, tripId, GRACE), who).toBeUndefined();
    expect(await removeMember(deps, ADA, tripId, STRANGER)).toBeUndefined();
    expect(await removeMember(deps, ADA, randomUUID(), GRACE)).toBeUndefined();
    expect(await removeMember(deps, ADA, 'nope', GRACE)).toBeUndefined();
    expect(await roles(tripId)).toMatchObject({ [GRACE]: 'traveler' });
    await removeMember(deps, ADA, tripId, GRACE);
    expect(await removeMember(deps, ADA, tripId, GRACE)).toBeUndefined();
    // Oneself is leaving, said only to an Organizer.
    expect(await refusal(removeMember(deps, ADA, tripId, ADA))).toContain('Leave');
    expect(await removeMember(deps, SAM, tripId, SAM)).toBeUndefined();
  });

  it('can remove another Organizer, and the trip has the one who removed them', async () => {
    const tripId = await trip({ second: true });
    await removeMember(deps, ADA, tripId, BEN);
    expect(await roles(tripId)).toMatchObject({ [ADA]: 'organizer', [BEN]: 'left' });
  });
});

describe(`the order of the locks (${leg})`, () => {
  it('takes streams and changes none: a counter stays what it was, and an account with none is fine', async () => {
    await checkIn(SAM);
    const seqOf = async () =>
      Number(
        (
          await dbGet<{ seq: number | string }>(
            database,
            sql`SELECT seq FROM ${t('account_stream')} WHERE account_id = ${SAM}`,
          )
        )?.seq,
      );
    const before = await seqOf();
    await transaction(database, (tx) => lockStreams(tx, [SAM, 'nobody', SAM, GRACE]));
    expect(await seqOf()).toBe(before);
    expect(
      await dbGet(
        database,
        sql`SELECT account_id FROM ${t('account_stream')} WHERE account_id = ${'nobody'}`,
      ),
    ).toBeUndefined();
  });
});
