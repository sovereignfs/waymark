import { randomBytes, randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { tableOf } from '../access/trip';
import { DEFAULT_LIMITS } from '../config';
import { ringOf } from '../crypto/keys';
import { Sealer } from '../crypto/sealed';
import type { Database } from '../db/client';
import { dbAll, dbGet, transaction } from '../db/exec';
import { makeStore, testTarget } from '../db/test-support';
import { applyMutation } from '../sync/apply';
import { addStop, removeStop, updateStop } from '../trips/plan';
import { setGoing, setRole } from '../trips/members';
import { createTrip, deleteTrip, getTrip } from '../trips/trips';
import { type Candidate, decide } from './decide';
import { LEASE_MS, enqueueRelink, workOnRelinks } from './queue';
import { decideFor } from './server';

/**
 * Auto-link on the server (DESIGN.md §12), against whichever database the leg runs on: applied with every check-in by the one write path, decided again by a job when a trip's stops change dates, **never changing a link set by
 * hand**, never linking a person to a trip they do not go on, and **always the same trip the device (the pure function) would choose**.
 */
const { leg } = testTarget();
const ring = ringOf(randomBytes(32));
if (!ring) throw new Error('no ring');
const sealer = new Sealer(ring);
const [ADA, GRACE, SAM, NOOR, STRANGER] = [
  'ada-acct',
  'grace-acct',
  'sam-acct',
  'noor-acct',
  'stranger-acct',
];
const NOW = Date.parse('2026-09-01T12:00:00Z');
let database: Database;
let close: () => Promise<void>;
let deps: Parameters<typeof createTrip>[0];

const t = (name: string) => tableOf(database, name);
const LISBON = { name: 'Lisbon', lat: 38.7223, lng: -9.1393 };
const PORTO = { name: 'Porto', lat: 41.1579, lng: -8.6291 };
const AUCKLAND = { name: 'Auckland', lat: -36.8485, lng: 174.7633 };
const iso = (text: string) => Date.parse(text);

async function tripWith(
  owner: string,
  name: string,
  stops: [string, string, { name: string; lat: number; lng: number }][],
  extra: Record<string, 'traveler' | 'follower'> = {},
) {
  const trip = await createTrip(deps, owner, { name });
  for (const [who, role] of Object.entries(extra))
    await dbAll(
      database,
      sql`INSERT INTO ${t('trip_member')} (trip_id, account_id, role, going, share_checkins, joined_at, seq) VALUES (${trip.id}, ${who}, ${role}, ${role === 'traveler'}, 'ask', ${NOW}, 2) RETURNING trip_id`,
    );
  for (const [arrive, depart, place] of stops)
    await addStop(deps, owner, trip.id, { place, arrive, depart });
  return trip.id;
}

/** A place of the person's and a check-in at it, through the one write path, as a device would send it. */
async function checkIn(
  who: string,
  where: { name: string; lat: number; lng: number },
  when: string,
  tz: string,
  link: { tripId: string | null; linkSource: 'auto' | 'manual' | null } = {
    tripId: null,
    linkSource: null,
  },
  ids: { place?: string; checkin?: string } = {},
) {
  const placeId = ids.place ?? randomUUID();
  const id = ids.checkin ?? randomUUID();
  const result = await applyMutation({ database, sealer, now: () => NOW }, who, {
    mutationId: randomUUID(),
    stream: 'account',
    changes: [
      {
        table: 'place',
        op: 'put',
        id: placeId,
        row: {
          name: where.name,
          lat: where.lat,
          lng: where.lng,
          source: 'manual',
          tz,
          countryCode: null,
        },
      },
      {
        table: 'checkin',
        op: 'put',
        id,
        row: {
          placeId,
          at: iso(when),
          tz,
          offsetMin: 0,
          companions: [],
          tripId: link.tripId,
          linkSource: link.linkSource,
          share: 'trip',
          source: 'live',
        },
      },
    ],
  });
  return { result, id, placeId };
}
const linkOf = async (id: string) =>
  dbGet<{
    tripId: string | null;
    linkSource: string | null;
    version: number | string;
    seq: number | string;
  }>(
    database,
    sql`SELECT trip_id AS "tripId", link_source AS "linkSource", version, seq FROM ${t('checkin')} WHERE id = ${id}`,
  );

beforeAll(async () => {
  ({ database, close } = await makeStore());
  deps = { database, sealer, now: () => NOW, limits: DEFAULT_LIMITS };
});
afterAll(async () => close());
beforeEach(async () => {
  for (const table of [
    'relink',
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
  ])
    await dbAll(database, sql`DELETE FROM ${t(table)} RETURNING 1 AS gone`);
});

describe(`a check-in applied by the one write path (${leg})`, () => {
  it('is linked to the trip whose dates and stop it falls into, by the server, whatever the device said', async () => {
    const trip = await tripWith(ADA, 'Iberia', [['2026-05-10', '2026-05-14', LISBON]]);
    const linked = await checkIn(ADA, LISBON, '2026-05-12T12:00:00+01:00', 'Europe/Lisbon');
    expect(linked.result.status).toBe('applied');
    expect(await linkOf(linked.id)).toMatchObject({ tripId: trip, linkSource: 'auto' });
    // Outside the dates: not linked.
    const outside = await checkIn(ADA, LISBON, '2026-05-15T12:00:00+01:00', 'Europe/Lisbon');
    expect(await linkOf(outside.id)).toMatchObject({ tripId: null, linkSource: null });
    // A device that says a check-in is in a trip it is not in is decided again: auto is the server's to decide.
    const lie = await checkIn(ADA, LISBON, '2026-06-20T12:00:00+01:00', 'Europe/Lisbon', {
      tripId: trip,
      linkSource: 'auto',
    });
    expect(await linkOf(lie.id)).toMatchObject({ tripId: null, linkSource: null });
  });

  it('is decided in the zone the check-in was made in: across the date line, and at 23:59', async () => {
    const trip = await tripWith(ADA, 'Auckland', [['2026-05-11', '2026-05-11', AUCKLAND]]);
    const across = await checkIn(ADA, AUCKLAND, '2026-05-10T13:00:00Z', 'Pacific/Auckland');
    expect(await linkOf(across.id)).toMatchObject({ tripId: trip, linkSource: 'auto' });
    const elsewhere = await checkIn(ADA, AUCKLAND, '2026-05-10T13:00:00Z', 'Pacific/Honolulu');
    expect(await linkOf(elsewhere.id)).toMatchObject({ tripId: null });
    const late = await tripWith(GRACE, 'Late', [['2026-06-14', '2026-06-14', LISBON]]);
    expect(
      await linkOf((await checkIn(GRACE, LISBON, '2026-06-14T23:59:00+01:00', 'Europe/Lisbon')).id),
    ).toMatchObject({ tripId: late });
    expect(
      await linkOf((await checkIn(GRACE, LISBON, '2026-06-15T00:00:00+01:00', 'Europe/Lisbon')).id),
    ).toMatchObject({ tripId: null });
  });

  it('goes to the nearest stop when a work trip and a weekend share dates, and to the shorter trip in the end', async () => {
    const work = await tripWith(ADA, 'Work', [['2026-05-11', '2026-05-17', LISBON]]);
    const weekend = await tripWith(ADA, 'Weekend', [['2026-05-16', '2026-05-17', PORTO]]);
    expect(
      await linkOf((await checkIn(ADA, PORTO, '2026-05-16T12:00:00+01:00', 'Europe/Lisbon')).id),
    ).toMatchObject({ tripId: weekend });
    expect(
      await linkOf((await checkIn(ADA, LISBON, '2026-05-16T12:00:00+01:00', 'Europe/Lisbon')).id),
    ).toMatchObject({ tripId: work });
    expect(
      await linkOf((await checkIn(ADA, LISBON, '2026-05-13T12:00:00+01:00', 'Europe/Lisbon')).id),
    ).toMatchObject({ tripId: work });
  });

  it('is never linked to a trip the person does not go on: a Follower, a stranger, an Organizer who is not going, a former member', async () => {
    const trip = await tripWith(ADA, 'Closed', [['2026-05-10', '2026-05-14', LISBON]], {
      [NOOR]: 'follower',
      [SAM]: 'traveler',
    });
    await setGoing(deps, ADA, trip, false);
    for (const who of [NOOR, STRANGER, ADA])
      expect(
        await linkOf((await checkIn(who, LISBON, '2026-05-12T12:00:00+01:00', 'Europe/Lisbon')).id),
        who,
      ).toMatchObject({ tripId: null });
    expect(
      await linkOf((await checkIn(SAM, LISBON, '2026-05-12T12:00:00+01:00', 'Europe/Lisbon')).id),
    ).toMatchObject({ tripId: trip, linkSource: 'auto' });
    await dbAll(
      database,
      sql`UPDATE ${t('trip_member')} SET left_at = ${NOW} WHERE trip_id = ${trip} AND account_id = ${SAM} RETURNING 1 AS x`,
    );
    expect(
      await linkOf((await checkIn(SAM, LISBON, '2026-05-12T13:00:00+01:00', 'Europe/Lisbon')).id),
    ).toMatchObject({ tripId: null });
  });

  it('counts a trip that is still being planned if it has dates, and not one with none', async () => {
    const planning = await tripWith(ADA, 'Planning', [['2026-05-10', '2026-05-14', LISBON]]);
    expect((await getTrip(deps, ADA, planning))?.trip.status).toBe('planning');
    expect(
      await linkOf((await checkIn(ADA, LISBON, '2026-05-12T12:00:00+01:00', 'Europe/Lisbon')).id),
    ).toMatchObject({ tripId: planning });
    await tripWith(GRACE, 'Undated', []);
    expect(
      await linkOf((await checkIn(GRACE, LISBON, '2026-05-12T12:00:00+01:00', 'Europe/Lisbon')).id),
    ).toMatchObject({ tripId: null });
  });
});

describe(`a link set by hand (${leg})`, () => {
  it('is kept as it was sent, to a trip the person may link to, and a link to none by hand stays none though a trip matches', async () => {
    const trip = await tripWith(ADA, 'Iberia', [['2026-05-10', '2026-05-14', LISBON]], {
      [SAM]: 'traveler',
    });
    const other = await tripWith(ADA, 'Elsewhere', [['2026-07-01', '2026-07-03', PORTO]], {
      [SAM]: 'traveler',
    });
    const byHand = await checkIn(SAM, LISBON, '2026-05-12T12:00:00+01:00', 'Europe/Lisbon', {
      tripId: other,
      linkSource: 'manual',
    });
    expect(byHand.result.status).toBe('applied');
    expect(await linkOf(byHand.id)).toMatchObject({ tripId: other, linkSource: 'manual' });
    const none = await checkIn(SAM, LISBON, '2026-05-13T12:00:00+01:00', 'Europe/Lisbon', {
      tripId: null,
      linkSource: 'manual',
    });
    expect(await linkOf(none.id)).toMatchObject({ tripId: null, linkSource: 'manual' });
    expect(trip).toBeDefined();
  });

  it('is refused for a trip the person is not an Organizer or Traveler of, as a link to a trip that is not there, and nothing is written', async () => {
    const trip = await tripWith(ADA, 'Private', [['2026-05-10', '2026-05-14', LISBON]], {
      [NOOR]: 'follower',
    });
    for (const who of [NOOR, STRANGER, GRACE]) {
      const attempt = await checkIn(who, LISBON, '2026-05-12T12:00:00+01:00', 'Europe/Lisbon', {
        tripId: trip,
        linkSource: 'manual',
      });
      expect(attempt.result, who).toMatchObject({ status: 'refused', reason: 'link' });
      expect(await linkOf(attempt.id), who).toBeUndefined();
    }
    expect(
      await dbGet<{ n: number | string }>(
        database,
        sql`SELECT COUNT(*) AS n FROM ${t('place')} WHERE account_id = ${NOOR}`,
      ).then((r) => Number(r?.n)),
    ).toBe(0);
    // A trip that is not an id's at all is the same.
    const missing = await checkIn(ADA, LISBON, '2026-05-12T12:00:00+01:00', 'Europe/Lisbon', {
      tripId: randomUUID(),
      linkSource: 'manual',
    });
    expect(missing.result).toMatchObject({ status: 'refused', reason: 'link' });
  });

  it('is never changed by an edit of the moment or the place, which re-decide an automatic link', async () => {
    const trip = await tripWith(ADA, 'Iberia', [['2026-05-10', '2026-05-14', LISBON]]);
    const auto = await checkIn(ADA, LISBON, '2026-05-12T12:00:00+01:00', 'Europe/Lisbon');
    const manual = await checkIn(ADA, LISBON, '2026-05-12T13:00:00+01:00', 'Europe/Lisbon', {
      tripId: null,
      linkSource: 'manual',
    });
    expect(await linkOf(auto.id)).toMatchObject({ tripId: trip });
    // The same check-ins, edited to another day (outside the trip): the automatic one loses its link, the one by hand keeps its own.
    await checkIn(
      ADA,
      LISBON,
      '2026-06-30T12:00:00+01:00',
      'Europe/Lisbon',
      { tripId: trip, linkSource: 'auto' },
      { checkin: auto.id, place: auto.placeId },
    );
    await checkIn(
      ADA,
      LISBON,
      '2026-06-30T13:00:00+01:00',
      'Europe/Lisbon',
      { tripId: null, linkSource: 'manual' },
      { checkin: manual.id, place: manual.placeId },
    );
    expect(await linkOf(auto.id)).toMatchObject({ tripId: null, linkSource: null });
    expect(await linkOf(manual.id)).toMatchObject({ tripId: null, linkSource: 'manual' });
    // And back inside: the automatic one is linked again.
    await checkIn(
      ADA,
      LISBON,
      '2026-05-11T12:00:00+01:00',
      'Europe/Lisbon',
      { tripId: null, linkSource: null },
      { checkin: auto.id, place: auto.placeId },
    );
    expect(await linkOf(auto.id)).toMatchObject({ tripId: trip, linkSource: 'auto' });
  });
});

describe(`linking again when a trip’s stops change dates (${leg})`, () => {
  it('asks for it in the transaction of the change, and not when the change is refused or changes no date', async () => {
    const trip = await createTrip(deps, ADA, { name: 'Iberia' });
    const queued = async () =>
      Number(
        (
          await dbGet<{ n: number | string }>(
            database,
            sql`SELECT COUNT(*) AS n FROM ${t('relink')}`,
          )
        )?.n,
      );
    await addStop(deps, ADA, trip.id, { place: LISBON });
    expect(await queued()).toBe(0);
    const plan = await addStop(deps, ADA, trip.id, {
      place: LISBON,
      arrive: '2026-05-10',
      depart: '2026-05-14',
    });
    expect(await queued()).toBe(1);
    await dbAll(database, sql`DELETE FROM ${t('relink')} RETURNING 1 AS x`);
    await updateStop(deps, ADA, trip.id, plan?.stops[0]?.id ?? '', { note: 'Noted' });
    expect(await queued()).toBe(0);
    await expect(
      addStop(deps, ADA, trip.id, { place: LISBON, arrive: '2026-05-12', depart: '2026-05-13' }),
    ).rejects.toBeDefined();
    expect(await queued()).toBe(0);
    await updateStop(deps, ADA, trip.id, plan?.stops[0]?.id ?? '', {
      arrive: '2026-05-11',
      depart: '2026-05-14',
    });
    expect(await queued()).toBe(1);
  });

  it('links check-ins already there when a trip gets its dates, and leaves what is outside, what is by hand and what is another person’s alone', async () => {
    const inside = await checkIn(ADA, LISBON, '2026-05-12T12:00:00+01:00', 'Europe/Lisbon');
    const outside = await checkIn(ADA, LISBON, '2026-05-20T12:00:00+01:00', 'Europe/Lisbon');
    const byHand = await checkIn(ADA, LISBON, '2026-05-13T12:00:00+01:00', 'Europe/Lisbon', {
      tripId: null,
      linkSource: 'manual',
    });
    const strangers = await checkIn(STRANGER, LISBON, '2026-05-12T12:00:00+01:00', 'Europe/Lisbon');
    const trip = await tripWith(ADA, 'Iberia', [['2026-05-10', '2026-05-14', LISBON]]);
    expect(await linkOf(inside.id)).toMatchObject({ tripId: null });
    const before = Number((await linkOf(inside.id))?.version);
    const done = await workOnRelinks({ database, sealer, now: () => NOW });
    expect(done).toEqual({ trips: 1, changed: 1 });
    expect(await linkOf(inside.id)).toMatchObject({
      tripId: trip,
      linkSource: 'auto',
      version: before + 1,
    });
    for (const untouched of [outside, byHand, strangers])
      expect(await linkOf(untouched.id)).toMatchObject({ tripId: null });
    expect((await linkOf(byHand.id))?.linkSource).toBe('manual');
    expect(
      await dbGet<{ n: number | string }>(
        database,
        sql`SELECT COUNT(*) AS n FROM ${t('relink')}`,
      ).then((r) => Number(r?.n)),
    ).toBe(0);
    // The owner's stream moved, so that their device pulls it.
    expect(Number((await linkOf(inside.id))?.seq)).toBeGreaterThan(0);
    // Doing it again changes nothing.
    await enqueueRelink(database, trip, NOW + 1);
    expect(await workOnRelinks({ database, sealer, now: () => NOW + 2 })).toEqual({
      trips: 1,
      changed: 0,
    });
  });

  it('moves a link that no longer fits when a stop is re-dated, to another trip or to none, and keeps one by hand through the re-date', async () => {
    const trip = await createTrip(deps, ADA, { name: 'Iberia' });
    const plan = await addStop(deps, ADA, trip.id, {
      place: LISBON,
      arrive: '2026-05-10',
      depart: '2026-05-14',
    });
    const stop = plan?.stops[0]?.id ?? '';
    const auto = await checkIn(ADA, LISBON, '2026-05-12T12:00:00+01:00', 'Europe/Lisbon');
    const byHand = await checkIn(ADA, LISBON, '2026-05-12T13:00:00+01:00', 'Europe/Lisbon', {
      tripId: trip.id,
      linkSource: 'manual',
    });
    expect(await linkOf(auto.id)).toMatchObject({ tripId: trip.id, linkSource: 'auto' });
    await workOnRelinks({ database, sealer, now: () => NOW });
    // Re-dated away from the check-in: the automatic link goes, the manual one stays.
    await updateStop(deps, ADA, trip.id, stop, { arrive: '2026-06-01', depart: '2026-06-03' });
    expect(await workOnRelinks({ database, sealer, now: () => NOW + 10 })).toMatchObject({
      trips: 1,
      changed: 1,
    });
    expect(await linkOf(auto.id)).toMatchObject({ tripId: null, linkSource: null });
    expect(await linkOf(byHand.id)).toMatchObject({ tripId: trip.id, linkSource: 'manual' });
    // Another trip takes the check-in's days: it moves there, and a re-date back does not take it from where it is.
    const other = await tripWith(ADA, 'Other', [['2026-05-11', '2026-05-13', LISBON]]);
    await workOnRelinks({ database, sealer, now: () => NOW + 20 });
    expect(await linkOf(auto.id)).toMatchObject({ tripId: other, linkSource: 'auto' });
    // A stop removed takes its trip's links with it.
    await removeStop(
      deps,
      ADA,
      other,
      (await getTrip(deps, ADA, other))
        ? ((
            await dbGet<{ id: string }>(
              database,
              sql`SELECT id FROM ${t('stop')} WHERE trip_id = ${other}`,
            )
          )?.id ?? '')
        : '',
    );
    await workOnRelinks({ database, sealer, now: () => NOW + 30 });
    expect(await linkOf(auto.id)).toMatchObject({ tripId: null, linkSource: null });
  });

  it('links a person’s check-ins when they become a Traveler and takes the links away when they stop going', async () => {
    const trip = await tripWith(ADA, 'Iberia', [['2026-05-10', '2026-05-14', LISBON]], {
      [NOOR]: 'follower',
    });
    const nooRs = await checkIn(NOOR, LISBON, '2026-05-12T12:00:00+01:00', 'Europe/Lisbon');
    expect(await linkOf(nooRs.id)).toMatchObject({ tripId: null });
    await dbAll(database, sql`DELETE FROM ${t('relink')} RETURNING 1 AS x`);
    await setRole(deps, ADA, trip, NOOR, 'traveler');
    await workOnRelinks({ database, sealer, now: () => NOW + 1 });
    expect(await linkOf(nooRs.id)).toMatchObject({ tripId: trip, linkSource: 'auto' });
    await setRole(deps, ADA, trip, NOOR, 'follower');
    await workOnRelinks({ database, sealer, now: () => NOW + 2 });
    expect(await linkOf(nooRs.id)).toMatchObject({ tripId: null, linkSource: null });
  });

  it('does a trip once for two workers at the same moment, keeps a trip asked for again meanwhile, and forgets a trip that is gone', async () => {
    for (let i = 0; i < 5; i += 1)
      await checkIn(ADA, LISBON, `2026-05-1${i}T12:00:00+01:00`, 'Europe/Lisbon');
    const trip = await tripWith(ADA, 'Iberia', [['2026-05-10', '2026-05-14', LISBON]]);
    const [a, b] = await Promise.all([
      workOnRelinks({ database, sealer, now: () => NOW }),
      workOnRelinks({ database, sealer, now: () => NOW }),
    ]);
    expect(a.trips + b.trips).toBe(1);
    expect(a.changed + b.changed).toBe(5);
    // A lease that is held keeps the row from a second worker until it lapses.
    await enqueueRelink(database, trip, NOW);
    await dbAll(
      database,
      sql`UPDATE ${t('relink')} SET claimed_until = ${NOW + LEASE_MS} WHERE trip_id = ${trip} RETURNING 1 AS x`,
    );
    expect(await workOnRelinks({ database, sealer, now: () => NOW + 1 })).toEqual({
      trips: 0,
      changed: 0,
    });
    expect(await workOnRelinks({ database, sealer, now: () => NOW + LEASE_MS + 1 })).toMatchObject({
      trips: 1,
    });
    // Asking again moves the time, and one row is kept.
    await enqueueRelink(database, trip, NOW + 5);
    await enqueueRelink(database, trip, NOW + 6);
    expect(
      await dbAll<{ requestedAt: number | string }>(
        database,
        sql`SELECT requested_at AS "requestedAt" FROM ${t('relink')}`,
      ),
    ).toHaveLength(1);
    // Deleting the trip takes its request with it, and a request for a trip that is gone is done and forgotten.
    await deleteTrip(deps, ADA, trip);
    expect(
      await dbGet<{ n: number | string }>(
        database,
        sql`SELECT COUNT(*) AS n FROM ${t('relink')}`,
      ).then((r) => Number(r?.n)),
    ).toBe(0);
    await enqueueRelink(database, trip, NOW + 9);
    expect(await workOnRelinks({ database, sealer, now: () => NOW + 10 })).toEqual({
      trips: 1,
      changed: 0,
    });
  });

  it('works a trip with more check-ins than one batch, and stops and goes on', async () => {
    const trip = await tripWith(ADA, 'Many', [['2026-05-01', '2026-05-30', LISBON]]);
    await dbAll(database, sql`DELETE FROM ${t('relink')} RETURNING 1 AS x`);
    const placeId = randomUUID();
    await checkIn(ADA, LISBON, '2026-04-01T12:00:00+01:00', 'Europe/Lisbon', undefined, {
      place: placeId,
    });
    // 230 check-ins in the trip's dates, written straight in as an import long ago would have (no link).
    for (let i = 0; i < 230; i += 1) {
      const id = `bulk-${String(i).padStart(4, '0')}`;
      await dbAll(
        database,
        sql`INSERT INTO ${t('checkin')} (id, account_id, place_id, at, tz, offset_min, trip_id, link_source, share, source, version, seq, sealed, created_at, updated_at) VALUES (${id}, ${ADA}, ${placeId}, ${iso('2026-05-10T12:00:00+01:00') + i * 60_000}, 'Europe/Lisbon', 60, NULL, NULL, 'trip', 'live', 1, 0, ${sealer.seal('checkin', id, {})}, ${NOW}, ${NOW}) RETURNING id`,
      );
    }
    await enqueueRelink(database, trip, NOW);
    // A budget that is spent at once does one pass of the claim and goes on next time: the result is the same either way.
    expect((await workOnRelinks({ database, sealer, now: () => NOW })).changed).toBe(230);
    expect(
      await dbGet<{ n: number | string }>(
        database,
        sql`SELECT COUNT(*) AS n FROM ${t('checkin')} WHERE trip_id = ${trip} AND link_source = 'auto'`,
      ).then((r) => Number(r?.n)),
    ).toBe(230);
    // The owner's stream counted all of them once.
    const stream = await dbGet<{ seq: number | string }>(
      database,
      sql`SELECT seq FROM ${t('account_stream')} WHERE account_id = ${ADA}`,
    );
    expect(Number(stream?.seq)).toBeGreaterThanOrEqual(230);
  });
});

describe(`the device and the server choose the same trip (${leg})`, () => {
  it('through a run of random trips and check-ins: the server’s decision equals the pure function’s, from the same facts', async () => {
    let seed = 11;
    const random = () => (seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648) / 2_147_483_648;
    const places = [
      LISBON,
      PORTO,
      AUCKLAND,
      { name: 'Madrid', lat: 40.4168, lng: -3.7038 },
      { name: 'Faro', lat: 37.0194, lng: -7.9304 },
    ];
    const day = (n: number) =>
      new Date(Date.UTC(2026, 5, 1) + n * 86_400_000).toISOString().slice(0, 10);
    for (let i = 0; i < 6; i += 1) {
      const from = Math.floor(random() * 20);
      const place = places[Math.floor(random() * places.length)] ?? LISBON;
      await tripWith(ADA, `T${i}`, [[day(from), day(from + Math.floor(random() * 6)), place]]);
    }
    for (let i = 0; i < 40; i += 1) {
      const where = places[Math.floor(random() * places.length)] ?? LISBON;
      const tz =
        ['Europe/Lisbon', 'Pacific/Auckland', 'Europe/Madrid'][Math.floor(random() * 3)] ?? 'UTC';
      const at = Date.UTC(2026, 5, 1, 0, 0) + Math.floor(random() * 28 * 24 * 60) * 60_000;
      const placeId = randomUUID();
      await checkIn(ADA, where, new Date(at).toISOString(), tz, undefined, { place: placeId });
      // What a device would hold: **all** of the person's trips with their stops (not only those on one day), decided by the one pure function.
      const onDevice = decide(
        { at, tz, point: { lat: where.lat, lng: where.lng } },
        await everyTrip(ADA),
      );
      const onServer = await transaction(database, (tx) =>
        decideFor(tx, sealer, ADA, { at, tz, placeId }),
      );
      expect(onServer, `check-in ${i}`).toBe(onDevice);
    }
  });
});

/** The trips as a device holds them: every trip the person goes on, with every stop. */
async function everyTrip(who: string): Promise<Candidate[]> {
  const trips = await dbAll<{
    id: string;
    createdAt: number | string;
    startDate: string | null;
    endDate: string | null;
  }>(
    database,
    sql`SELECT t.id, t.created_at AS "createdAt", t.start_date AS "startDate", t.end_date AS "endDate" FROM ${t('trip')} t JOIN ${t('trip_member')} m ON m.trip_id = t.id
        WHERE m.account_id = ${who} AND m.left_at IS NULL AND m.role IN ('organizer', 'traveler') AND m.going = ${true}`,
  );
  const out: Candidate[] = [];
  for (const trip of trips) {
    const stops = await dbAll<{
      arrive: string;
      depart: string;
      placeId: string;
      sealed: Uint8Array;
    }>(
      database,
      sql`SELECT s.arrive, s.depart, s.place_id AS "placeId", p.sealed FROM ${t('stop')} s JOIN ${t('place')} p ON p.id = s.place_id WHERE s.trip_id = ${trip.id} AND s.arrive IS NOT NULL`,
    );
    out.push({
      id: trip.id,
      createdAt: Number(trip.createdAt),
      goes: true,
      startDate: trip.startDate,
      endDate: trip.endDate,
      stops: stops.map((stop) => {
        const place = sealer.unseal('place', stop.placeId, new Uint8Array(stop.sealed));
        return {
          arrive: stop.arrive,
          depart: stop.depart,
          point: { lat: place.lat, lng: place.lng },
        };
      }),
    });
  }
  return out;
}
