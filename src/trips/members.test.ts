import { randomBytes } from 'node:crypto';
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
import { TripError } from './format';
import { setGoing, setRole } from './members';
import { addStop, readPlan } from './plan';
import { createTrip, getTrip } from './trips';

/**
 * Roles (DESIGN.md §11.1) against whichever database the leg runs on: an Organizer changes a role, **a trip always has an Organizer**, and every statement names the role it needs. A Traveler cannot change a role, a Follower cannot
 * edit anything, and the person whose role changed is told, never the person who changed it.
 */
const { leg } = testTarget();
const ring = ringOf(randomBytes(32));
if (!ring) throw new Error('no ring');
const sealer = new Sealer(ring);
const [ADA, GRACE, SAM, NOOR, STRANGER, GONE] = [
  'ada-acct',
  'grace-acct',
  'sam-acct',
  'noor-acct',
  'stranger-acct',
  'gone-acct',
];
let NOW = 1_800_000_000_000;
let database: Database;
let close: () => Promise<void>;
let deps: Parameters<typeof createTrip>[0];
let tripId: string;

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
const member = async (who: string) =>
  dbGet<{ role: string; going: boolean | number; seq: number | string }>(
    database,
    sql`SELECT role, going, seq FROM ${t('trip_member')} WHERE trip_id = ${tripId} AND account_id = ${who}`,
  );
const roleOf = async (who: string) => (await member(who))?.role;
const organizers = async () =>
  count('trip_member', sql`WHERE trip_id = ${tripId} AND role = 'organizer' AND left_at IS NULL`);
const tripSeq = async () =>
  Number(
    (
      await dbGet<{ seq: number | string }>(
        database,
        sql`SELECT seq FROM ${t('trip')} WHERE id = ${tripId}`,
      )
    )?.seq,
  );
const noticesOf = async (who: string) =>
  (await listNotices({ database, sealer }, who)).filter((n) => n.tripId === tripId);

beforeAll(async () => {
  ({ database, close } = await makeStore());
  deps = { database, sealer, now: () => ++NOW, limits: DEFAULT_LIMITS };
});
afterAll(async () => close());
beforeEach(async () => {
  for (const table of ['notice', 'item', 'day', 'stop', 'place', 'trip_member', 'trip'])
    await dbAll(database, sql`DELETE FROM ${t(table)} RETURNING 1 AS gone`);
  tripId = (await createTrip(deps, ADA, { name: 'Iberia' })).id;
  for (const [id, role, left] of [
    [GRACE, 'organizer', false],
    [SAM, 'traveler', false],
    [NOOR, 'follower', false],
    [GONE, 'traveler', true],
  ] as const)
    await dbAll(
      database,
      sql`INSERT INTO ${t('trip_member')} (trip_id, account_id, role, going, share_checkins, joined_at, left_at, seq) VALUES (${tripId}, ${id}, ${role}, ${role !== 'follower'}, 'ask', ${NOW}, ${left ? NOW : null}, 2) RETURNING trip_id`,
    );
});

describe(`changing a role (${leg})`, () => {
  it('lets an Organizer make a Traveler an Organizer, a Follower a Traveler, and an Organizer a Follower, with who goes following the role', async () => {
    expect((await setRole(deps, ADA, tripId, SAM, 'organizer'))?.role).toBe('organizer');
    expect(await member(SAM)).toMatchObject({ role: 'organizer' });
    await setRole(deps, ADA, tripId, NOOR, 'traveler');
    expect(await member(NOOR)).toMatchObject({ role: 'traveler', going: expect.anything() });
    expect(Boolean((await member(NOOR))?.going)).toBe(true);
    await setRole(deps, ADA, tripId, GRACE, 'follower');
    expect(await roleOf(GRACE)).toBe('follower');
    expect(Boolean((await member(GRACE))?.going)).toBe(false);
    expect(await organizers()).toBe(2);
  });

  it('advances the trip’s counter once and stamps the member with it', async () => {
    const before = await tripSeq();
    await setRole(deps, ADA, tripId, SAM, 'organizer');
    expect(await tripSeq()).toBe(before + 1);
    expect(Number((await member(SAM))?.seq)).toBe(before + 1);
    // Asking for the role they have changes nothing: not the counter, not a notice.
    await setRole(deps, ADA, tripId, SAM, 'organizer');
    expect(await tripSeq()).toBe(before + 1);
    expect(await count('notice')).toBe(1);
  });

  it('holds the last Organizer: they cannot become another role until someone else is made Organizer', async () => {
    await setRole(deps, ADA, tripId, GRACE, 'traveler');
    await expect(setRole(deps, ADA, tripId, ADA, 'traveler')).rejects.toBeInstanceOf(TripError);
    await expect(setRole(deps, ADA, tripId, ADA, 'follower')).rejects.toThrow(
      'always has an Organizer',
    );
    expect(await roleOf(ADA)).toBe('organizer');
    expect(await organizers()).toBe(1);
    // With another Organizer made, she can step down.
    await setRole(deps, ADA, tripId, SAM, 'organizer');
    expect((await setRole(deps, ADA, tripId, ADA, 'traveler'))?.role).toBe('traveler');
    // And then she is no Organizer: she cannot change another role.
    expect(await setRole(deps, ADA, tripId, SAM, 'follower')).toBeUndefined();
  });

  it('never leaves a trip with no Organizer when two Organizers step down themselves at the same moment', async () => {
    const results = await Promise.allSettled([
      setRole(deps, ADA, tripId, ADA, 'traveler'),
      setRole(deps, GRACE, tripId, GRACE, 'traveler'),
    ]);
    expect(await organizers()).toBe(1);
    expect(results.filter((r) => r.status === 'fulfilled' && r.value !== undefined)).toHaveLength(
      1,
    );
    for (const r of results.filter((r) => r.status === 'rejected'))
      expect((r as PromiseRejectedResult).reason).toBeInstanceOf(TripError);
  });

  it('never leaves a trip with no Organizer when two Organizers demote each other at the same moment', async () => {
    const results = await Promise.allSettled([
      setRole(deps, ADA, tripId, GRACE, 'traveler'),
      setRole(deps, GRACE, tripId, ADA, 'traveler'),
    ]);
    expect(await organizers()).toBe(1);
    expect(results.filter((r) => r.status === 'fulfilled' && r.value !== undefined)).toHaveLength(
      1,
    );
    // The loser was either refused in words or found it was no longer an Organizer.
    for (const r of results.filter((r) => r.status === 'rejected'))
      expect((r as PromiseRejectedResult).reason).toBeInstanceOf(TripError);
  });

  it('is for an Organizer only: a Traveler, a Follower, a former member and a stranger are told it is not there, and nothing changes', async () => {
    const seq = await tripSeq();
    for (const who of [SAM, NOOR, GONE, STRANGER]) {
      expect(
        await setRole(deps, who, tripId, who === SAM ? SAM : NOOR, 'organizer'),
        who,
      ).toBeUndefined();
      expect(await setRole(deps, who, tripId, ADA, 'follower'), who).toBeUndefined();
    }
    expect(await roleOf(SAM)).toBe('traveler');
    expect(await roleOf(NOOR)).toBe('follower');
    expect(await roleOf(ADA)).toBe('organizer');
    expect(await tripSeq()).toBe(seq);
    expect(await count('notice')).toBe(0);
  });

  it('is told not found for someone who is not in the trip or has left it, and refused in words for a role that is not one', async () => {
    expect(await setRole(deps, ADA, tripId, STRANGER, 'traveler')).toBeUndefined();
    expect(await setRole(deps, ADA, tripId, GONE, 'organizer')).toBeUndefined();
    expect(await setRole(deps, ADA, tripId, '', 'traveler')).toBeUndefined();
    expect(await setRole(deps, ADA, 'not-an-id', SAM, 'traveler')).toBeUndefined();
    for (const role of ['admin', '', 'ORGANIZER', 'traveller'])
      await expect(setRole(deps, ADA, tripId, SAM, role), role).rejects.toBeInstanceOf(TripError);
    expect(await roleOf(GONE)).toBe('traveler');
    expect(await member(GONE)).toBeDefined();
  });

  it('tells the person whose role changed, in words that name only the trip and the role, and never the Organizer who changed it', async () => {
    await setRole(deps, ADA, tripId, SAM, 'organizer');
    const [told] = await noticesOf(SAM);
    expect(told).toMatchObject({
      kind: 'role_changed',
      title: 'Your part in “Iberia” is now Organizer',
      href: `/trips/${tripId}`,
    });
    for (const who of [ADA, GRACE, NOOR, STRANGER]) expect(await noticesOf(who), who).toEqual([]);
    // Changing their own role tells nobody.
    await setRole(deps, SAM, tripId, SAM, 'traveler');
    expect((await noticesOf(SAM)).length).toBe(1);
    const rows = await dbAll<{ sealed: Uint8Array }>(
      database,
      sql`SELECT sealed FROM ${t('notice')}`,
    );
    for (const row of rows)
      expect(Buffer.from(row.sealed).toString('latin1')).not.toContain('Iberia');
  });

  it('changes what the person may do at once: a Follower made a Traveler edits the plan, and one made a Follower no longer does', async () => {
    expect(
      await addStop(deps, NOOR, tripId, { place: { name: 'A', lat: 1, lng: 2 } }),
    ).toBeUndefined();
    await setRole(deps, ADA, tripId, NOOR, 'traveler');
    expect(
      await addStop(deps, NOOR, tripId, { place: { name: 'A', lat: 1, lng: 2 } }),
    ).toBeDefined();
    await setRole(deps, ADA, tripId, NOOR, 'follower');
    expect(
      await addStop(deps, NOOR, tripId, { place: { name: 'B', lat: 1, lng: 2 } }),
    ).toBeUndefined();
    // A Follower still reads the plan.
    expect((await readPlan(deps, NOOR, tripId))?.stops).toHaveLength(1);
    // A Traveler made an Organizer can now mark ready and change roles, and not before.
    expect(await setRole(deps, SAM, tripId, NOOR, 'traveler')).toBeUndefined();
    await setRole(deps, ADA, tripId, SAM, 'organizer');
    expect(await setRole(deps, SAM, tripId, NOOR, 'traveler')).toBeDefined();
  });
});

describe(`an Organizer who is not going (${leg})`, () => {
  it('switches it off and on for themselves, and the trip says who goes', async () => {
    expect(Boolean((await member(ADA))?.going)).toBe(true);
    expect((await setGoing(deps, ADA, tripId, false))?.going).toBe(false);
    expect(Boolean((await member(ADA))?.going)).toBe(false);
    expect(
      (await getTrip(deps, GRACE, tripId))?.members.find((m) => m.accountId === ADA)?.going,
    ).toBe(false);
    expect((await setGoing(deps, ADA, tripId, true))?.going).toBe(true);
  });

  it('changes nothing, counts nothing and says nothing when it already is so', async () => {
    const seq = await tripSeq();
    await setGoing(deps, ADA, tripId, true);
    expect(await tripSeq()).toBe(seq);
    await setGoing(deps, ADA, tripId, false);
    await setGoing(deps, ADA, tripId, false);
    expect(await tripSeq()).toBe(seq + 1);
    expect(await count('notice')).toBe(0);
  });

  it('is an Organizer’s alone: a Traveler goes and a Follower does not, and they have no switch', async () => {
    for (const who of [SAM, NOOR, GONE, STRANGER])
      expect(await setGoing(deps, who, tripId, false), who).toBeUndefined();
    expect(Boolean((await member(SAM))?.going)).toBe(true);
    expect(Boolean((await member(NOOR))?.going)).toBe(false);
    // It is their own switch: an Organizer cannot set another's.
    expect(Boolean((await member(GRACE))?.going)).toBe(true);
    await setGoing(deps, ADA, tripId, false);
    expect(Boolean((await member(GRACE))?.going)).toBe(true);
  });

  it('is reset by a change of role: an Organizer who steps down to Traveler goes, and one who becomes a Follower does not', async () => {
    await setGoing(deps, ADA, tripId, false);
    await setRole(deps, GRACE, tripId, ADA, 'traveler');
    expect(Boolean((await member(ADA))?.going)).toBe(true);
  });
});
