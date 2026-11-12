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
import type { Limiter } from '../limits/rate';
import { listNotices } from '../notices/notices';
import { createProfile } from '../profile/profile';
import { TripError } from '../trips/format';
import { leaveTrip } from '../trips/leaving';
import { addStop } from '../trips/plan';
import { createTrip, deleteTrip } from '../trips/trips';
import { accept, preview } from './http';
import {
  type InviteDeps,
  acceptInvitation,
  createInvitation,
  listInvitations,
  previewInvitation,
  pruneInvitations,
  resendInvitation,
  revokeInvitation,
} from './service';
import {
  INVITE_TTL_MS,
  MAX_PENDING,
  RESEND_AFTER_MS,
  hashToken,
  isToken,
  newToken,
  sameHash,
} from './token';

/**
 * Invitations (DESIGN.md §11.2), on whichever database the leg runs on: a link, a name or an address; the token kept only as its hash; valid 14 days, single-use, revocable, sent again at most once an hour; every link that cannot be used
 * the same answer; accepted by whoever holds it, once; the inviter told who.
 */
const { leg } = testTarget();
const ring = ringOf(randomBytes(32));
if (!ring) throw new Error('no ring');
const sealer = new Sealer(ring);
const [ADA, SAM, NOOR, GRACE, ZED, HAL] = ['ada', 'sam', 'noor', 'grace', 'zed', 'hal'];
let NOW = Date.parse('2026-09-01T12:00:00Z');
let database: Database;
let close: () => Promise<void>;
const t = (name: string) => tableOf(database, name);
const URL_BASE = 'https://waymark.example';

const deps = (over: Partial<InviteDeps> = {}): InviteDeps => ({
  database,
  sealer,
  now: () => NOW,
  limits: DEFAULT_LIMITS,
  url: URL_BASE,
  delivery: () => ({ mail: { app: 'Waymark', url: URL_BASE } }),
  accountByEmail: async (email) => (email === 'grace@example.com' ? GRACE : undefined),
  ...over,
});
const tokenOf = (link: string) => link.slice(link.lastIndexOf('/') + 1);
const member = (tripId: string, who: string, role: string, left = false) =>
  dbAll(
    database,
    sql`INSERT INTO ${t('trip_member')} (trip_id, account_id, role, going, share_checkins, joined_at, left_at, seq) VALUES (${tripId}, ${who}, ${role}, ${role !== 'follower'}, 'ask', ${NOW}, ${left ? NOW : null}, 2) RETURNING trip_id`,
  );

/** Ada organizes "Iberia" with Sam (Traveler) and Noor (Follower); Grace shares another trip with Ada; Zed shares nothing. */
async function trip() {
  const made = await createTrip(deps(), ADA, { name: 'Iberia' });
  await member(made.id, SAM, 'traveler');
  await member(made.id, NOOR, 'follower');
  await addStop(deps(), ADA, made.id, {
    place: { name: 'Lisbon', lat: 38.7, lng: -9.1 },
    arrive: '2026-05-10',
    depart: '2026-05-12',
  });
  const other = await createTrip(deps(), ADA, { name: 'Elsewhere' });
  await member(other.id, GRACE, 'traveler');
  await createTrip(deps(), ZED, { name: 'Zed’s' });
  return made.id;
}
const rolesOf = async (tripId: string) =>
  Object.fromEntries(
    (
      await dbAll<{ id: string; role: string; left: number | string | null }>(
        database,
        sql`SELECT account_id AS id, role, left_at AS "left" FROM ${t('trip_member')} WHERE trip_id = ${tripId}`,
      )
    ).map((m) => [m.id, m.left === null ? m.role : 'left']),
  );
const count = async (table: string) =>
  Number(
    (await dbGet<{ n: number | string }>(database, sql`SELECT COUNT(*) AS n FROM ${t(table)}`))?.n,
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
  for (const [id, name] of [
    [ADA, 'Ada Lovelace'],
    [GRACE, 'Grace Hopper'],
    [ZED, 'Zed Stranger'],
    [HAL, 'Hal Smith'],
  ] as const)
    await createProfile(database, sealer, { accountId: id, name, email: `${id}@example.com` }, NOW);
});
afterAll(async () => close());
beforeEach(async () => {
  NOW += 1000;
  for (const table of [
    'invitation',
    'mail_outbox',
    'notice',
    'notice_pref',
    'relink',
    'trip_tombstone',
    'item',
    'day',
    'stop',
    'place',
    'trip_member',
    'trip',
    'account_stream',
  ])
    await dbAll(database, sql`DELETE FROM ${t(table)} RETURNING 1 AS gone`);
});

describe('a token', () => {
  it('is 32 random bytes, hashed for keeping, compared by its hash, and a string of any other shape is no token', () => {
    const a = newToken();
    const b = newToken();
    expect(a.token).not.toBe(b.token);
    expect(isToken(a.token)).toBe(true);
    expect(a.token).toHaveLength(43);
    expect(a.hash).toBe(hashToken(a.token));
    expect(a.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(a.hash).not.toContain(a.token);
    expect(sameHash(a.hash, a.token)).toBe(true);
    expect(sameHash(a.hash, b.token)).toBe(false);
    expect(sameHash('zz', a.token)).toBe(false);
    for (const bad of [
      '',
      'short',
      `${a.token}x`,
      a.token.slice(1),
      `${a.token.slice(0, 42)}!`,
      5,
      null,
      undefined,
    ])
      expect(isToken(bad), String(bad)).toBe(false);
  });
});

describe(`making an invitation (${leg})`, () => {
  it('is by a link, for an Organizer: 14 days, one role, the token kept only as its hash and shown once', async () => {
    const tripId = await trip();
    const sent = await createInvitation(deps(), ADA, tripId, { role: 'traveler' });
    if (!sent) throw new Error('not made');
    expect(sent).toMatchObject({
      role: 'traveler',
      via: 'link',
      mail: true,
      expiresAt: NOW + INVITE_TTL_MS,
    });
    expect(sent.link).toMatch(new RegExp(`^${URL_BASE}/invite/[A-Za-z0-9_-]{43}$`));
    const token = tokenOf(sent.link);
    // Nothing in the database holds the token: not a column, not the envelope.
    const row = await dbGet<Record<string, unknown>>(
      database,
      sql`SELECT * FROM ${t('invitation')}`,
    );
    expect(
      JSON.stringify(row, (_k, v) =>
        v instanceof Uint8Array ? Buffer.from(v).toString('latin1') : v,
      ),
    ).not.toContain(token);
    expect(row?.token_hash ?? row?.tokenHash).toBe(hashToken(token));
    // The list shows who is waiting and never a link.
    const waiting = await listInvitations(deps(), ADA, tripId);
    expect(waiting).toHaveLength(1);
    expect(JSON.stringify(waiting)).not.toContain(token);
    expect(waiting?.[0]).toMatchObject({ id: sent.id, role: 'traveler', via: 'link' });
  });

  it('is an Organizer’s alone: a Traveler, a Follower, a stranger and a trip that is not there are told it is not there', async () => {
    const tripId = await trip();
    for (const who of [SAM, NOOR, ZED]) {
      expect(
        await createInvitation(deps(), who, tripId, { role: 'follower' }),
        who,
      ).toBeUndefined();
      expect(await listInvitations(deps(), who, tripId), who).toBeUndefined();
    }
    expect(await createInvitation(deps(), ADA, randomUUID(), { role: 'follower' })).toBeUndefined();
    expect(await createInvitation(deps(), ADA, 'nope', { role: 'follower' })).toBeUndefined();
    expect(await count('invitation')).toBe(0);
  });

  it('is refused in words for a role that is not one, a person and an address together, and an address that is not one', async () => {
    const tripId = await trip();
    for (const input of [{ role: 'boss' }, { role: undefined }, { role: 5 }])
      await refusal(createInvitation(deps(), ADA, tripId, input));
    await refusal(
      createInvitation(deps(), ADA, tripId, {
        role: 'traveler',
        accountId: GRACE,
        email: 'x@example.com',
      }),
    );
    for (const email of [
      'nope',
      'a@b',
      'a b@example.com',
      'a@example.com, b@example.com',
      '<a@example.com>',
      5,
      `${'x'.repeat(250)}@example.com`,
    ])
      await refusal(createInvitation(deps(), ADA, tripId, { role: 'traveler', email }));
    await refusal(createInvitation(deps(), ADA, tripId, { role: 'traveler', accountId: 5 }));
    expect(await count('invitation')).toBe(0);
  });

  it('is by a name only for someone the Organizer already shares a trip with, told by a notice with the link, and not for someone already in it', async () => {
    const tripId = await trip();
    const sent = await createInvitation(deps(), ADA, tripId, {
      role: 'follower',
      accountId: GRACE,
    });
    expect(sent).toMatchObject({ via: 'account' });
    const notice = (await listNotices({ database, sealer }, GRACE, 10))[0];
    expect(notice).toMatchObject({
      kind: 'invited',
      title: 'Ada Lovelace invited you to “Iberia”',
    });
    expect(notice?.href).toBe(`/invite/${tokenOf(sent?.link ?? '')}`);
    // The notice is also emailed to her, as an invitation is by default: it is her notice's mail, not an invitation to an address.
    expect(await count('mail_outbox')).toBe(1);
    // Not someone they share nothing with, and not someone who is in the trip.
    expect(
      await createInvitation(deps(), ADA, tripId, { role: 'traveler', accountId: ZED }),
    ).toBeUndefined();
    expect(
      await createInvitation(deps(), ADA, tripId, { role: 'traveler', accountId: randomUUID() }),
    ).toBeUndefined();
    expect(
      await refusal(createInvitation(deps(), ADA, tripId, { role: 'traveler', accountId: SAM })),
    ).toContain('already');
    expect(await count('invitation')).toBe(1);
  });

  it('is by an address: a notice to an account that has it, an email to any other, and the answer says the same of both', async () => {
    const tripId = await trip();
    const known = await createInvitation(deps(), ADA, tripId, {
      role: 'traveler',
      email: ' Grace@Example.com ',
    });
    // Her notice is emailed as notices are; nothing is mailed to the address as an invitation.
    expect(await count('mail_outbox')).toBe(1);
    expect((await listNotices({ database, sealer }, GRACE, 10)).map((n) => n.kind)).toEqual([
      'invited',
    ]);
    const unknown = await createInvitation(deps(), ADA, tripId, {
      role: 'traveler',
      email: 'new.person@example.com',
    });
    expect(await count('mail_outbox')).toBe(2);
    // Which is which is not told: the same shape, the same words.
    expect(Object.keys(known ?? {}).sort()).toEqual(Object.keys(unknown ?? {}).sort());
    expect({
      ...known,
      id: 0,
      link: 0,
      createdAt: 0,
      lastSentAt: 0,
      expiresAt: 0,
      email: 0,
    }).toEqual({ ...unknown, id: 0, link: 0, createdAt: 0, lastSentAt: 0, expiresAt: 0, email: 0 });
    const mail = await dbAll<{ kind: string }>(database, sql`SELECT kind FROM ${t('mail_outbox')}`);
    expect(mail.map((each) => each.kind)).toEqual(['notice', 'notice']);
  });

  it('with no mail set up has the link as the only way, and says so; an address already in the trip is not mailed', async () => {
    const tripId = await trip();
    const sent = await createInvitation(deps({ delivery: () => ({}) }), ADA, tripId, {
      role: 'traveler',
      email: 'new@example.com',
    });
    expect(sent).toMatchObject({ mail: false });
    expect(await count('mail_outbox')).toBe(0);
    expect(sent?.link).toContain('/invite/');
    const inTrip = await createInvitation(deps({ accountByEmail: async () => SAM }), ADA, tripId, {
      role: 'traveler',
      email: 'sam@example.com',
    });
    expect(inTrip).toBeDefined();
    expect(await count('mail_outbox')).toBe(0);
  });

  it('is limited each hour for each person, and asking which account an address is, too; and waiting ones are at most fifty', async () => {
    const tripId = await trip();
    const counts: Record<string, number> = {};
    const limiter: Limiter = {
      take: async (key, rule) => {
        counts[key] = (counts[key] ?? 0) + 1;
        return counts[key] <= rule.limit ? { ok: true } : { ok: false, retryAfterMs: 1 };
      },
    };
    for (let n = 0; n < 30; n++)
      expect(
        await createInvitation(deps({ limiter }), ADA, tripId, {
          role: 'traveler',
          email: `p${n}@example.com`,
        }),
      ).toBeDefined();
    await refusal(
      createInvitation(deps({ limiter }), ADA, tripId, {
        role: 'traveler',
        email: 'p31@example.com',
      }),
    );
    expect(Object.keys(counts)).toEqual(
      expect.arrayContaining([`invite:${ADA}`, `invite-lookup:${ADA}`]),
    );
    const total = async () =>
      Number(
        (
          await dbGet<{ n: number | string }>(
            database,
            sql`SELECT COUNT(*) AS n FROM ${t('invitation')}`,
          )
        )?.n,
      );
    for (let n = await total(); n < MAX_PENDING; n++)
      await createInvitation(deps(), ADA, tripId, { role: 'follower' });
    expect(await refusal(createInvitation(deps(), ADA, tripId, { role: 'follower' }))).toContain(
      String(MAX_PENDING),
    );
  });
});

describe(`what a link shows (${leg})`, () => {
  it('is the trip’s name and dates, who invited and the role, and nothing else; the same nothing for every link that cannot be used', async () => {
    const tripId = await trip();
    const sent = await createInvitation(deps(), ADA, tripId, { role: 'follower' });
    const token = tokenOf(sent?.link ?? '');
    const shown = await previewInvitation(deps(), token);
    expect(shown).toEqual({
      tripName: 'Iberia',
      startDate: '2026-05-10',
      endDate: '2026-05-12',
      inviter: 'Ada Lovelace',
      role: 'follower',
    });
    expect(Object.keys(shown ?? {}).sort()).toEqual([
      'endDate',
      'inviter',
      'role',
      'startDate',
      'tripName',
    ]);
    // Every other case is the one answer.
    NOW += INVITE_TTL_MS;
    expect(await previewInvitation(deps(), token)).toBeUndefined();
    NOW -= INVITE_TTL_MS;
    for (const bad of ['', 'x', newToken().token, `${token}x`, token.toUpperCase()])
      expect(await previewInvitation(deps(), bad), bad).toBeUndefined();
    expect(await revokeInvitation(deps(), ADA, tripId, sent?.id ?? '')).toBe(true);
    expect(await previewInvitation(deps(), token)).toBeUndefined();
  });

  it('is nothing once the trip is gone, and nothing once the link is used', async () => {
    const tripId = await trip();
    const used = tokenOf(
      (await createInvitation(deps(), ADA, tripId, { role: 'traveler' }))?.link ?? '',
    );
    const gone = tokenOf(
      (await createInvitation(deps(), ADA, tripId, { role: 'traveler' }))?.link ?? '',
    );
    await acceptInvitation(deps(), HAL, used);
    expect(await previewInvitation(deps(), used)).toBeUndefined();
    await deleteTrip(deps(), ADA, tripId);
    expect(await previewInvitation(deps(), gone)).toBeUndefined();
    expect(await count('invitation')).toBe(0);
  });
});

describe(`accepting (${leg})`, () => {
  it('joins the trip with the invited role, once; the inviter is told who; their check-ins that fall in the dates are asked to be linked', async () => {
    const tripId = await trip();
    const sent = await createInvitation(deps(), ADA, tripId, { role: 'traveler' });
    const token = tokenOf(sent?.link ?? '');
    expect(await acceptInvitation(deps(), HAL, token)).toEqual({
      status: 'joined',
      tripId,
      role: 'traveler',
    });
    expect(await rolesOf(tripId)).toMatchObject({ [HAL]: 'traveler' });
    const going = await dbGet<{ going: boolean | number }>(
      database,
      sql`SELECT going FROM ${t('trip_member')} WHERE trip_id = ${tripId} AND account_id = ${HAL}`,
    );
    expect(Boolean(going?.going)).toBe(true);
    const told = (await listNotices({ database, sealer }, ADA, 10)).find(
      (n) => n.kind === 'invite_accepted',
    );
    expect(told?.title).toBe('Hal Smith joined “Iberia”');
    expect(told?.detail).toContain('Traveler');
    expect(await count('relink')).toBe(1);
    // Used.
    expect(await acceptInvitation(deps(), ZED, token)).toBeUndefined();
    expect(await acceptInvitation(deps(), HAL, token)).toBeUndefined();
    expect(await rolesOf(tripId)).not.toHaveProperty(ZED);
    expect(await listInvitations(deps(), ADA, tripId)).toEqual([]);
  });

  it('a Follower joins as one and does not go; an Organizer joins as one', async () => {
    const tripId = await trip();
    await acceptInvitation(
      deps(),
      HAL,
      tokenOf((await createInvitation(deps(), ADA, tripId, { role: 'follower' }))?.link ?? ''),
    );
    await acceptInvitation(
      deps(),
      ZED,
      tokenOf((await createInvitation(deps(), ADA, tripId, { role: 'organizer' }))?.link ?? ''),
    );
    expect(await rolesOf(tripId)).toMatchObject({ [HAL]: 'follower', [ZED]: 'organizer' });
    const going = await dbGet<{ going: boolean | number }>(
      database,
      sql`SELECT going FROM ${t('trip_member')} WHERE trip_id = ${tripId} AND account_id = ${HAL}`,
    );
    expect(Boolean(going?.going)).toBe(false);
  });

  it('is won by one of two who accept at the same moment', async () => {
    const tripId = await trip();
    const token = tokenOf(
      (await createInvitation(deps(), ADA, tripId, { role: 'traveler' }))?.link ?? '',
    );
    const results = await Promise.allSettled([
      acceptInvitation(deps(), HAL, token),
      acceptInvitation(deps(), ZED, token),
    ]);
    const joined = results.filter((r) => r.status === 'fulfilled' && r.value?.status === 'joined');
    expect(joined).toHaveLength(1);
    const roles = await rolesOf(tripId);
    expect([HAL, ZED].filter((who) => who in roles)).toHaveLength(1);
  });

  it('changes nothing for someone already in the trip, and says so; the invitation is still good for another', async () => {
    const tripId = await trip();
    const token = tokenOf(
      (await createInvitation(deps(), ADA, tripId, { role: 'organizer' }))?.link ?? '',
    );
    expect(await acceptInvitation(deps(), SAM, token)).toEqual({ status: 'already', tripId });
    expect(await rolesOf(tripId)).toMatchObject({ [SAM]: 'traveler' });
    expect(await listInvitations(deps(), ADA, tripId)).toHaveLength(1);
    expect(await acceptInvitation(deps(), HAL, token)).toMatchObject({ status: 'joined' });
  });

  it('brings back someone who left, with the part invited and their sharing reset', async () => {
    const tripId = await trip();
    await leaveTrip(deps(), SAM, tripId);
    expect(await rolesOf(tripId)).toMatchObject({ [SAM]: 'left' });
    const token = tokenOf(
      (await createInvitation(deps(), ADA, tripId, { role: 'follower' }))?.link ?? '',
    );
    expect(await acceptInvitation(deps(), SAM, token)).toMatchObject({
      status: 'joined',
      role: 'follower',
    });
    expect(await rolesOf(tripId)).toMatchObject({ [SAM]: 'follower' });
  });

  it('is refused in words for a full trip, and the invitation is not used up', async () => {
    const tripId = await trip();
    const token = tokenOf(
      (await createInvitation(deps(), ADA, tripId, { role: 'traveler' }))?.link ?? '',
    );
    const small = deps({ limits: { ...DEFAULT_LIMITS, tripMembers: 3 } });
    expect(await refusal(acceptInvitation(small, HAL, token))).toContain('as many people');
    expect(await listInvitations(deps(), ADA, tripId)).toHaveLength(1);
    expect(await acceptInvitation(deps(), HAL, token)).toMatchObject({ status: 'joined' });
  });

  it('cannot be used when it has run out or been revoked, and is not told apart', async () => {
    const tripId = await trip();
    const old = await createInvitation(deps(), ADA, tripId, { role: 'traveler' });
    NOW += INVITE_TTL_MS - 1;
    expect(await acceptInvitation(deps(), HAL, tokenOf(old?.link ?? ''))).toMatchObject({
      status: 'joined',
    });
    NOW += 10;
    const stale = await createInvitation(deps(), ADA, tripId, { role: 'traveler' });
    NOW += INVITE_TTL_MS;
    expect(await acceptInvitation(deps(), ZED, tokenOf(stale?.link ?? ''))).toBeUndefined();
    const revoked = await createInvitation(deps(), ADA, tripId, { role: 'traveler' });
    await revokeInvitation(deps(), ADA, tripId, revoked?.id ?? '');
    expect(await acceptInvitation(deps(), ZED, tokenOf(revoked?.link ?? ''))).toBeUndefined();
    expect(await acceptInvitation(deps(), ZED, 'not a token')).toBeUndefined();
  });
});

describe(`revoking and sending again (${leg})`, () => {
  it('revoking is an Organizer’s, ends the link at once, and is nothing to do twice', async () => {
    const tripId = await trip();
    const sent = await createInvitation(deps(), ADA, tripId, { role: 'traveler' });
    expect(await revokeInvitation(deps(), SAM, tripId, sent?.id ?? '')).toBe(false);
    expect(await revokeInvitation(deps(), ZED, tripId, sent?.id ?? '')).toBe(false);
    expect(await revokeInvitation(deps(), ADA, randomUUID(), sent?.id ?? '')).toBe(false);
    expect(await revokeInvitation(deps(), ADA, tripId, sent?.id ?? '')).toBe(true);
    expect(await revokeInvitation(deps(), ADA, tripId, sent?.id ?? '')).toBe(false);
    expect(await listInvitations(deps(), ADA, tripId)).toEqual([]);
  });

  it('sending again is at most once an hour, makes a new link, and the old one stops; it mails the address again', async () => {
    const tripId = await trip();
    const sent = await createInvitation(deps(), ADA, tripId, {
      role: 'traveler',
      email: 'new@example.com',
    });
    const first = tokenOf(sent?.link ?? '');
    expect(await refusal(resendInvitation(deps(), ADA, tripId, sent?.id ?? ''))).toMatch(
      /Send it again in \d+ minutes/,
    );
    NOW += RESEND_AFTER_MS - 1;
    await refusal(resendInvitation(deps(), ADA, tripId, sent?.id ?? ''));
    NOW += 1;
    const again = await resendInvitation(deps(), ADA, tripId, sent?.id ?? '');
    const second = tokenOf(again?.link ?? '');
    expect(second).not.toBe(first);
    expect(again?.expiresAt).toBe(NOW + INVITE_TTL_MS);
    expect(await count('mail_outbox')).toBe(2);
    expect(await previewInvitation(deps(), first)).toBeUndefined();
    expect(await previewInvitation(deps(), second)).toBeDefined();
    // Not theirs, not there, not waiting.
    expect(await resendInvitation(deps(), SAM, tripId, sent?.id ?? '')).toBeUndefined();
    expect(await resendInvitation(deps(), ADA, tripId, randomUUID())).toBeUndefined();
    await revokeInvitation(deps(), ADA, tripId, sent?.id ?? '');
    NOW += RESEND_AFTER_MS;
    expect(await resendInvitation(deps(), ADA, tripId, sent?.id ?? '')).toBeUndefined();
  });

  it('forgets what was used, revoked or run out a month ago', async () => {
    const tripId = await trip();
    const one = await createInvitation(deps(), ADA, tripId, { role: 'traveler' });
    await createInvitation(deps(), ADA, tripId, { role: 'traveler' });
    await revokeInvitation(deps(), ADA, tripId, one?.id ?? '');
    expect(await pruneInvitations(database, NOW + 29 * 86_400_000)).toBe(0);
    expect(await pruneInvitations(database, NOW + 31 * 86_400_000)).toBe(1);
    expect(await count('invitation')).toBe(1);
  });
});

describe(`over HTTP (${leg})`, () => {
  const post = (body: unknown) =>
    new Request('http://localhost/api/invitations/accept', {
      method: 'POST',
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
  const open: Limiter = { take: async () => ({ ok: true }) };
  const http = () => ({ ...deps(), limiter: open });

  it('shows a link to anyone and the same 404 for every link that cannot be used, never carrying the token back', async () => {
    const tripId = await trip();
    const token = tokenOf(
      (await createInvitation(deps(), ADA, tripId, { role: 'traveler' }))?.link ?? '',
    );
    const good = await preview(token, http());
    expect(good.status).toBe(200);
    expect(good.headers.get('cache-control')).toBe('no-store');
    expect(JSON.stringify(await good.json())).not.toContain(token);
    const wrong = await preview(newToken().token, http());
    const shape = await preview('nope', http());
    expect(wrong.status).toBe(404);
    expect(await wrong.text()).toBe(await shape.text());
    expect(
      (
        await preview(token, {
          ...http(),
          limiter: { take: async () => ({ ok: false, retryAfterMs: 5 }) },
        })
      ).status,
    ).toBe(429);
  });

  it('accepts for the signed-in account, once, refuses a body that is not exactly a token, and says a full trip is full', async () => {
    const tripId = await trip();
    const token = tokenOf(
      (await createInvitation(deps(), ADA, tripId, { role: 'traveler' }))?.link ?? '',
    );
    const joined = await accept(post({ token }), HAL, http());
    expect(joined.status).toBe(200);
    expect(await joined.json()).toEqual({ status: 'joined', tripId, role: 'traveler' });
    expect((await accept(post({ token }), ZED, http())).status).toBe(404);
    for (const body of ['not json', '[]', '"x"', {}, { token: 5 }, { token, extra: 1 }])
      expect((await accept(post(body), ZED, http())).status, JSON.stringify(body)).toBe(400);
    const again = tokenOf(
      (await createInvitation(deps(), ADA, tripId, { role: 'traveler' }))?.link ?? '',
    );
    const full = await accept(post({ token: again }), ZED, {
      ...http(),
      limits: { ...DEFAULT_LIMITS, tripMembers: 3 },
    });
    expect(full.status).toBe(409);
    expect((await full.json()).sentence).toContain('as many people');
    expect(
      (
        await accept(post({ token: again }), ZED, {
          ...http(),
          limiter: { take: async () => ({ ok: false, retryAfterMs: 5 }) },
        })
      ).status,
    ).toBe(429);
  });
});
