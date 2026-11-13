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
import type { Limiter } from '../limits/rate';
import { listNotices } from '../notices/notices';
import { createProfile } from '../profile/profile';
import type { Found, Resolved } from '../sovereign/directory';
import { TripError } from '../trips/format';
import { createTrip } from '../trips/trips';
import { previewInvitation } from './service';
import {
  type InviteDeps,
  type InviteDirectory,
  claimInvitations,
  createInvitation,
  listInvitations,
  resendInvitation,
  revokeInvitation,
  searchDirectory,
} from './service';
import { RESEND_AFTER_MS } from './token';

/**
 * Inviting from core's directory (DESIGN.md §11.2), on whichever database the leg runs on. **A person is looked up again by the server as the Organizer and never taken on a browser's word**; one with an account here is told
 * by a notice, one without by core's bell, **and their first sign-in through core takes the invitation by their `sub`** (never by an email). Where there is no directory, or core cannot be reached, nothing else changes.
 */
const { leg } = testTarget();
const ring = ringOf(randomBytes(32));
if (!ring) throw new Error('no ring');
const sealer = new Sealer(ring);
const [ADA, SAM, NOOR, GRACE, ZED, NIA] = ['ada', 'sam', 'noor', 'grace', 'zed', 'nia'];
let NOW = Date.parse('2026-09-01T12:00:00Z');
let database: Database;
let close: () => Promise<void>;
const t = (name: string) => tableOf(database, name);
const BASE = 'https://waymark.example';

/** What core's directory knows: Grace has an account here, Nia will make hers by signing in, Hal is one nobody here has met. */
const PEOPLE: Record<string, string> = {
  'sub-grace': 'Grace Hopper',
  'sub-nia': 'Nia Newcomer',
  'sub-hal': 'Hal Smith',
  'sub-sam': 'Sam Traveler',
};
const ACCOUNTS: Record<string, string> = { 'sub-grace': GRACE, 'sub-sam': SAM };
const asked: { search: string[]; resolve: string[] } = { search: [], resolve: [] };
let mode: 'on' | 'unavailable' | 'failed' = 'on';
let gone = new Set<string>();

const directory: InviteDirectory = {
  async search(accountId, query): Promise<Found> {
    asked.search.push(`${accountId}:${query}`);
    if (mode !== 'on') return { outcome: mode };
    return {
      outcome: 'found',
      people: Object.entries(PEOPLE)
        .filter(([, name]) => name.toLowerCase().includes(query.toLowerCase()))
        .map(([sub, name]) => ({ sub, name })),
    };
  },
  async resolve(accountId, sub): Promise<Resolved> {
    asked.resolve.push(`${accountId}:${sub}`);
    if (mode !== 'on') return { outcome: mode };
    const name = PEOPLE[sub];
    return name && !gone.has(sub)
      ? { outcome: 'found', person: { sub, name } }
      : { outcome: 'gone' };
  },
  async accountOfSub(sub) {
    return ACCOUNTS[sub];
  },
};

const deps = (over: Partial<InviteDeps> = {}): InviteDeps => ({
  database,
  sealer,
  now: () => NOW,
  limits: DEFAULT_LIMITS,
  url: BASE,
  delivery: () => ({ mail: { app: 'Waymark', url: BASE } }),
  coreDirectory: directory,
  ...over,
});
const tokenOf = (link: string) => link.slice(link.lastIndexOf('/') + 1);
const member = (tripId: string, who: string, role: string) =>
  dbAll(
    database,
    sql`INSERT INTO ${t('trip_member')} (trip_id, account_id, role, going, share_checkins, joined_at, left_at, seq) VALUES (${tripId}, ${who}, ${role}, ${role !== 'follower'}, 'ask', ${NOW}, NULL, 1) RETURNING trip_id`,
  );
async function trip() {
  const made = await createTrip(deps(), ADA, { name: 'Iberia' });
  await member(made.id, SAM, 'traveler');
  await member(made.id, NOOR, 'follower');
  return made.id;
}
const rolesOf = async (tripId: string) =>
  Object.fromEntries(
    (
      await dbAll<{ id: string; role: string }>(
        database,
        sql`SELECT account_id AS id, role FROM ${t('trip_member')} WHERE trip_id = ${tripId} AND left_at IS NULL`,
      )
    ).map((m) => [m.id, m.role]),
  );
const calls = () =>
  dbAll<{ id: string; kind: string; accountId: string | null }>(
    database,
    sql`SELECT id, kind, account_id AS "accountId" FROM ${t('core_outbox')} ORDER BY created_at, id`,
  );
/** What a queued call to core says (sealed while it waits), as the job opens it. */
const contentOf = async (id: string) => {
  const row = await dbGet<{ sealed: Uint8Array | ArrayBuffer }>(
    database,
    sql`SELECT sealed FROM ${t('core_outbox')} WHERE id = ${id}`,
  );
  const bytes = row?.sealed instanceof Uint8Array ? row.sealed : new Uint8Array(row?.sealed ?? []);
  return sealer.unseal('core_outbox', id, bytes).content as {
    title: string;
    body?: string;
    path?: string;
    sub?: string;
    key: string;
  };
};
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
    [NIA, 'Nia Newcomer'],
  ] as const)
    await createProfile(database, sealer, { accountId: id, name, email: `${id}@example.com` }, NOW);
});
afterAll(async () => close());
beforeEach(async () => {
  NOW += 1000;
  mode = 'on';
  gone = new Set();
  asked.search = [];
  asked.resolve = [];
  for (const table of [
    'invitation',
    'mail_outbox',
    'core_outbox',
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

describe(`inviting a person of the directory (${leg})`, () => {
  it('is looked up by the server as the Organizer, kept with the name core gave and the sub, and told by core’s bell with the link, when they have no account here', async () => {
    const tripId = await trip();
    const sent = await createInvitation(deps(), ADA, tripId, { role: 'traveler', sub: 'sub-nia' });
    expect(sent).toMatchObject({ via: 'directory', role: 'traveler', name: 'Nia Newcomer' });
    expect(asked.resolve).toEqual([`${ADA}:sub-nia`]);
    // The row names the sub, no account, and only the hash of the token.
    const row = await dbGet<{ via: string; target: string | null; sub: string | null }>(
      database,
      sql`SELECT via, target_account_id AS target, target_sub AS sub FROM ${t('invitation')} WHERE id = ${sent?.id ?? ''}`,
    );
    expect(row).toEqual({ via: 'directory', target: null, sub: 'sub-nia' });
    // One call to core's bell, addressed by the sub (there is no account), whose link is the invitation's; nothing by Waymark's mail, no notice.
    const queued = await calls();
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ kind: 'notification', accountId: null });
    const content = await contentOf(queued[0]?.id ?? '');
    expect(content).toMatchObject({ sub: 'sub-nia', path: `/invite/${tokenOf(sent?.link ?? '')}` });
    expect(content.title).toBe('Ada Lovelace invited you to “Iberia”');
    expect(
      Number(
        (await dbGet<{ n: number }>(database, sql`SELECT COUNT(*) AS n FROM ${t('mail_outbox')}`))
          ?.n,
      ),
    ).toBe(0);
    // The waiting list says who it is for, by the name core gave.
    expect((await listInvitations(deps(), ADA, tripId))?.[0]).toMatchObject({
      via: 'directory',
      name: 'Nia Newcomer',
    });
  });

  it('is told by a notice, as any account is, when the person has signed in here: the invitation is theirs by the account', async () => {
    const tripId = await trip();
    const sent = await createInvitation(deps(), ADA, tripId, {
      role: 'follower',
      sub: 'sub-grace',
    });
    expect(sent?.via).toBe('directory');
    const notice = (await listNotices({ database, sealer }, GRACE, 10))[0];
    expect(notice).toMatchObject({ kind: 'invited' });
    expect(notice?.href).toBe(`/invite/${tokenOf(sent?.link ?? '')}`);
    // Not also asked of core's bell by sub: the notice carries the bell (to core too, where it is on), with the account.
    expect((await calls()).every((call) => call.accountId === GRACE)).toBe(true);
    const row = await dbGet<{ target: string | null; sub: string | null }>(
      database,
      sql`SELECT target_account_id AS target, target_sub AS sub FROM ${t('invitation')} WHERE id = ${sent?.id ?? ''}`,
    );
    // It is the account's, to accept: nothing waits for a sign-in to take it.
    expect(row).toEqual({ target: GRACE, sub: null });
    expect(await claimInvitations(deps(), GRACE, 'sub-grace')).toEqual([]);
    expect(await listInvitations(deps(), ADA, tripId)).toHaveLength(1);
  });

  it('is never taken on the browser’s word: a sub the directory does not know, a person who is gone, and a core that cannot be reached are each refused in words, and nothing is made', async () => {
    const tripId = await trip();
    expect(
      await refusal(createInvitation(deps(), ADA, tripId, { role: 'traveler', sub: 'sub-nobody' })),
    ).toMatch(/not in the directory/);
    gone = new Set(['sub-hal']);
    expect(
      await refusal(createInvitation(deps(), ADA, tripId, { role: 'traveler', sub: 'sub-hal' })),
    ).toMatch(/not in the directory/);
    mode = 'failed';
    expect(
      await refusal(createInvitation(deps(), ADA, tripId, { role: 'traveler', sub: 'sub-hal' })),
    ).toMatch(/cannot be reached/);
    mode = 'unavailable';
    expect(
      await refusal(createInvitation(deps(), ADA, tripId, { role: 'traveler', sub: 'sub-hal' })),
    ).toMatch(/cannot be reached/);
    expect(
      await refusal(
        createInvitation(deps({ coreDirectory: undefined }), ADA, tripId, {
          role: 'traveler',
          sub: 'sub-hal',
        }),
      ),
    ).toMatch(/no directory/);
    expect(await listInvitations(deps(), ADA, tripId)).toEqual([]);
    expect(await calls()).toEqual([]);
  });

  it('is for a person or an address, not both; for an Organizer; and not twice for the same person while one is waiting, nor for one already in the trip', async () => {
    const tripId = await trip();
    await refusal(
      createInvitation(deps(), ADA, tripId, {
        role: 'traveler',
        sub: 'sub-nia',
        email: 'x@example.com',
      }),
    );
    await refusal(
      createInvitation(deps(), ADA, tripId, { role: 'traveler', sub: 'sub-nia', accountId: GRACE }),
    );
    await refusal(createInvitation(deps(), ADA, tripId, { role: 'traveler', sub: 42 }));
    // A Traveler, a Follower and a stranger are told the trip is not there; nothing is asked of core for them.
    for (const who of [SAM, NOOR, ZED])
      expect(
        await createInvitation(deps(), who, tripId, { role: 'traveler', sub: 'sub-nia' }),
      ).toBeUndefined();
    expect(asked.resolve).toEqual([]);
    await createInvitation(deps(), ADA, tripId, { role: 'traveler', sub: 'sub-nia' });
    expect(
      await refusal(createInvitation(deps(), ADA, tripId, { role: 'follower', sub: 'sub-nia' })),
    ).toMatch(/already invited/);
    // Sam signed in here with that sub and is in the trip.
    expect(
      await refusal(createInvitation(deps(), ADA, tripId, { role: 'traveler', sub: 'sub-sam' })),
    ).toMatch(/already in this trip/);
    expect(await listInvitations(deps(), ADA, tripId)).toHaveLength(1);
  });

  it('is sent again with a new link and a new call to core under a new key, and revoked so that the sign-in no longer takes it', async () => {
    const tripId = await trip();
    const first = await createInvitation(deps(), ADA, tripId, { role: 'traveler', sub: 'sub-nia' });
    NOW += RESEND_AFTER_MS + 1;
    const again = await resendInvitation(deps(), ADA, tripId, first?.id ?? '');
    expect(again?.link).not.toBe(first?.link);
    const queued = await calls();
    expect(queued).toHaveLength(2);
    const keys = await Promise.all(queued.map(async (call) => (await contentOf(call.id)).key));
    expect(new Set(keys).size).toBe(2);
    expect(await contentOf(queued[1]?.id ?? '')).toMatchObject({
      sub: 'sub-nia',
      path: `/invite/${tokenOf(again?.link ?? '')}`,
    });
    expect(await revokeInvitation(deps(), ADA, tripId, first?.id ?? '')).toBe(true);
    expect(await claimInvitations(deps(), NIA, 'sub-nia')).toEqual([]);
  });
});

describe(`the first sign-in through core takes the invitation (${leg})`, () => {
  it('puts the person in the trip with the role invited, once, and tells the inviter who joined; the link is then spent', async () => {
    const tripId = await trip();
    const sent = await createInvitation(deps(), ADA, tripId, { role: 'traveler', sub: 'sub-nia' });
    expect(await claimInvitations(deps(), NIA, 'sub-nia')).toEqual([tripId]);
    expect((await rolesOf(tripId))[NIA]).toBe('traveler');
    const told = (await listNotices({ database, sealer }, ADA, 10)).find(
      (n) => n.kind === 'invite_accepted',
    );
    expect(told?.title).toBe('Nia Newcomer joined “Iberia”');
    expect(await previewInvitation(deps(), tokenOf(sent?.link ?? ''))).toBeUndefined();
    // Signing in again takes nothing twice.
    expect(await claimInvitations(deps(), NIA, 'sub-nia')).toEqual([]);
    expect(await listInvitations(deps(), ADA, tripId)).toEqual([]);
  });

  it('is by the sub core vouched for and by nothing else: not another person’s sub, not an address, and not one that has run out', async () => {
    const tripId = await trip();
    await createInvitation(deps(), ADA, tripId, { role: 'traveler', sub: 'sub-nia' });
    // Another person signing in is taken by their own sub, which names nothing here; an account whose address is the invited one is no reason.
    expect(await claimInvitations(deps(), ZED, 'sub-zed')).toEqual([]);
    expect(await claimInvitations(deps(), ZED, 'sub-hal')).toEqual([]);
    expect((await rolesOf(tripId))[ZED]).toBeUndefined();
    NOW += 15 * 24 * 3_600_000;
    expect(await claimInvitations(deps(), NIA, 'sub-nia')).toEqual([]);
    expect((await rolesOf(tripId))[NIA]).toBeUndefined();
  });

  it('takes each trip’s invitation on its own: one that cannot be taken (a full trip) stays waiting, with its link, and the others are', async () => {
    const full = await trip();
    const other = await createTrip(deps(), ADA, { name: 'Elsewhere' });
    await createInvitation(deps(), ADA, full, { role: 'traveler', sub: 'sub-nia' });
    await createInvitation(deps(), ADA, other.id, { role: 'follower', sub: 'sub-nia' });
    const small = { ...deps(), limits: { ...DEFAULT_LIMITS, tripMembers: 3 } };
    // `full` has three members already (Ada, Sam, Noor): no room.
    expect(await claimInvitations(small, NIA, 'sub-nia')).toEqual([other.id]);
    expect((await rolesOf(full))[NIA]).toBeUndefined();
    expect(await listInvitations(deps(), ADA, full)).toHaveLength(1);
  });
});

describe(`searching the directory to invite (${leg})`, () => {
  it('is an Organizer’s alone: a trip that is not theirs is not there, and nothing is asked of core for it', async () => {
    const tripId = await trip();
    for (const who of [SAM, NOOR, ZED])
      expect(await searchDirectory(deps(), who, tripId, 'nia')).toBeUndefined();
    expect(asked.search).toEqual([]);
    expect(await searchDirectory(deps(), ADA, 'not-a-trip', 'nia')).toBeUndefined();
  });

  it('offers the people core names who are not already in the trip, by name, and nothing of who has an account here', async () => {
    const tripId = await trip();
    expect(await searchDirectory(deps(), ADA, tripId, 'a')).toEqual({
      directory: 'on',
      people: [
        // Sam is in the trip (he signed in here with `sub-sam`): left out. Grace is not, and has an account, which is not said.
        { sub: 'sub-grace', name: 'Grace Hopper' },
        { sub: 'sub-nia', name: 'Nia Newcomer' },
        { sub: 'sub-hal', name: 'Hal Smith' },
      ],
    });
    expect(await searchDirectory(deps(), ADA, tripId, '  ')).toEqual({
      directory: 'on',
      people: [],
    });
    expect(await searchDirectory(deps(), ADA, tripId, 'x'.repeat(101))).toEqual({
      directory: 'on',
      people: [],
    });
    expect(await searchDirectory(deps(), ADA, tripId, 7)).toEqual({ directory: 'on', people: [] });
  });

  it('says "off" where there is no directory for this person, and "failed" when core did not answer: inviting by address or link is then all there is', async () => {
    const tripId = await trip();
    expect(await searchDirectory(deps({ coreDirectory: undefined }), ADA, tripId, 'nia')).toEqual({
      directory: 'off',
      people: [],
    });
    mode = 'unavailable';
    expect(await searchDirectory(deps(), ADA, tripId, 'nia')).toEqual({
      directory: 'off',
      people: [],
    });
    mode = 'failed';
    expect(await searchDirectory(deps(), ADA, tripId, 'nia')).toEqual({
      directory: 'failed',
      people: [],
    });
  });

  it('is limited, in words', async () => {
    const tripId = await trip();
    const counts: Record<string, number> = {};
    const limiter: Limiter = {
      take: async (key, rule) => {
        counts[key] = (counts[key] ?? 0) + 1;
        return counts[key] <= rule.limit ? { ok: true } : { ok: false, retryAfterMs: 1 };
      },
    };
    for (let n = 0; n < 100; n++)
      expect((await searchDirectory(deps({ limiter }), ADA, tripId, 'nia'))?.directory).toBe('on');
    await refusal(searchDirectory(deps({ limiter }), ADA, tripId, 'nia'));
  });
});
