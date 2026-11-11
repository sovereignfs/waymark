import { randomBytes } from 'node:crypto';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFakeSovereign, type FakeSovereign } from '../auth/testing/fake-sovereign';
import { type TestAuth, makeAuth } from '../auth/test-support';
import { ringOf } from '../crypto/keys';
import { Sealer } from '../crypto/sealed';
import type { Database } from '../db/client';
import { dbAll } from '../db/exec';
import { openAppBesideAuth } from '../db/test-support';
import { testTarget } from '../db/test-support';
import type { MediaDeps } from '../media/service';
import { putMedia, readMedia } from '../media/service';
import { listPlaces, makePlace } from '../places/places';
import { createProfile, getProfile } from '../profile/profile';
import { handleAccountDeleted, handleBackChannelLogout, type NoticeDeps } from './http';
import { peopleFor } from './server';
import { sdkVerifiers, seenBy } from './verifiers';

/**
 * Core's two notices acted on for real (DESIGN.md §19.2), on real stores and a real signed-in person: a person made by signing in through a fake core, with a profile, a place and a photo on disk; the
 * notices signed by that core's key and sent to the handlers, which verify them, find the account by its `sub` in the sign-in store, and end its sessions or delete it. The verifiers are the SDK's and are
 * tested against the SDK's own fake core in `verifiers.test.ts`; what this holds is the part that is Waymark's: **logout ends every session of that person and no one else's, a deletion leaves nothing
 * (rows and files) before it answers 200, and a replay is refused across a restart**.
 */
const { leg } = testTarget();
const made = ringOf(randomBytes(32));
if (!made) throw new Error('no ring');
const ring = made;
const sealer = new Sealer(ring);
const NOW = 1_800_000_000_000;

let fake: FakeSovereign;
let t: TestAuth;
let app: { database: Database; close(): Promise<void> };
let directory: string;
let media: MediaDeps;
let addresses = 0;

beforeAll(async () => {
  fake = await startFakeSovereign();
  t = await makeAuth(
    {
      local: false,
      signUp: 'open',
      sovereign: { issuer: fake.issuer, clientId: fake.clientId, clientSecret: fake.clientSecret },
    },
    undefined,
    async (account) => {
      await createProfile(
        app.database,
        sealer,
        { accountId: account.id, name: account.name, email: account.email },
        NOW,
      );
    },
  );
  app = await openAppBesideAuth();
  directory = mkdtempSync(path.join(tmpdir(), 'waymark-notices-'));
  media = {
    database: app.database,
    ring,
    dir: path.join(directory, 'media'),
    maxAccountBytes: 100 * 1024 * 1024,
    now: () => NOW,
  };
});
afterAll(async () => {
  await t.close();
  await app.close();
  await fake.close();
  rmSync(directory, { recursive: true, force: true });
});

const authTable = (name: string) =>
  sql.raw(t.database.dialect === 'postgres' ? `"waymark_auth"."${name}"` : `"${name}"`);
const sessionsOf = async (accountId: string) =>
  Number(
    (
      await dbAll<{ n: number | string }>(
        t.database,
        sql`SELECT COUNT(*) AS n FROM ${authTable('session')} WHERE user_id = ${accountId}`,
      )
    )[0]?.n,
  );
const userExists = async (accountId: string) =>
  (await dbAll(t.database, sql`SELECT id FROM ${authTable('user')} WHERE id = ${accountId}`))
    .length > 0;

/** A person signs in through the fake core, on their own browser, and is the account that makes. */
async function signIn(sub: string, email: string, name: string) {
  const client = t.client().from(`10.8.${Math.floor(addresses / 250)}.${(addresses++ % 250) + 1}`);
  fake.signInAs({ sub, email, name });
  const start = await client.post('/api/auth/sign-in/social', {
    provider: 'sovereign',
    callbackURL: '/',
    errorCallbackURL: '/sign-in',
    newUserCallbackURL: '/',
  });
  const authorize = await fetch(start.body.url as string, { redirect: 'manual' });
  await client.follow(authorize.headers.get('location') as string);
  expect(client.has('session_token')).toBe(true);
  const rows = await dbAll<{ user_id: string }>(
    t.database,
    sql`SELECT user_id FROM ${authTable('account')} WHERE provider_id = 'sovereign' AND account_id = ${sub}`,
  );
  const accountId = rows[0]?.user_id as string;
  expect(accountId).toBeTruthy();
  return { client, accountId };
}

function world(): NoticeDeps {
  return {
    verify: sdkVerifiers({
      coreUrl: fake.issuer,
      clientId: fake.clientId,
      seen: seenBy(app.database),
    }),
    people: peopleFor({
      database: app.database,
      authDatabase: t.database,
      media: async () => media,
    }),
    log: () => undefined,
  };
}
const form = (field: string, token: string) =>
  new Request('https://waymark.example.com/api/sovereign/notice', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ [field]: token }).toString(),
  });
const picture = () =>
  sharp({ create: { width: 30, height: 20, channels: 3, background: { r: 20, g: 90, b: 40 } } })
    .jpeg()
    .toBuffer();
const files = () => {
  try {
    return readdirSync(media.dir).length;
  } catch {
    return 0;
  }
};

describe(`Sovereign’s notices to Waymark (${leg})`, () => {
  it('a logout ends every session of that person on every device, and no one else’s; the account is theirs still', async () => {
    const ada = await signIn('notice-ada', 'ada.notice@sovereign.test', 'Ada');
    const adaElsewhere = await signIn('notice-ada', 'ada.notice@sovereign.test', 'Ada');
    const grace = await signIn('notice-grace', 'grace.notice@sovereign.test', 'Grace');
    expect(adaElsewhere.accountId).toBe(ada.accountId);
    expect(await sessionsOf(ada.accountId)).toBe(2);

    const reply = await handleBackChannelLogout(
      form('logout_token', await fake.noticeToken('logout', { sub: 'notice-ada', sid: 'core-1' })),
      world(),
    );
    expect(reply.status).toBe(200);
    expect(await sessionsOf(ada.accountId)).toBe(0);
    expect(await sessionsOf(grace.accountId)).toBe(1);
    expect(await userExists(ada.accountId)).toBe(true);
    // And they sign in again as the same account.
    expect((await signIn('notice-ada', 'ada.notice@sovereign.test', 'Ada')).accountId).toBe(
      ada.accountId,
    );
  });

  it('a logout for someone who never signed in here ends nothing and is answered 200', async () => {
    const reply = await handleBackChannelLogout(
      form('logout_token', await fake.noticeToken('logout', { sub: 'notice-nobody' })),
      world(),
    );
    expect(reply.status).toBe(200);
  });

  it('an account deleted at core is deleted here, rows and files, before the answer is 200; the other person is whole', async () => {
    const ada = await signIn('delete-ada', 'ada.delete@sovereign.test', 'Ada To Delete');
    const grace = await signIn('delete-grace', 'grace.delete@sovereign.test', 'Grace To Keep');
    for (const who of [ada.accountId, grace.accountId]) {
      await makePlace({ database: app.database, sealer, now: () => NOW }, who, {
        name: 'Tokyo Tower',
        lat: 35.6586,
        lng: 139.7454,
      });
      const stored = await putMedia(media, {
        accountId: who,
        kind: 'photo',
        bytes: await picture(),
      });
      expect(stored.ok).toBe(true);
    }
    const filesBefore = files();
    expect(await getProfile(app.database, sealer, ada.accountId)).toMatchObject({
      name: 'Ada To Delete',
    });

    const token = await fake.noticeToken('account-deleted', { sub: 'delete-ada' });
    const reply = await handleAccountDeleted(form('account_deleted_token', token), world());
    expect(reply.status).toBe(200);

    // Nothing of Ada, anywhere, by the time the answer came.
    expect(await userExists(ada.accountId)).toBe(false);
    expect(await sessionsOf(ada.accountId)).toBe(0);
    expect(await getProfile(app.database, sealer, ada.accountId)).toBeUndefined();
    expect(await listPlaces({ database: app.database, sealer }, ada.accountId)).toEqual([]);
    expect(files()).toBe(filesBefore - 2);
    // Grace, whole.
    expect(await userExists(grace.accountId)).toBe(true);
    expect(await sessionsOf(grace.accountId)).toBe(1);
    expect(await getProfile(app.database, sealer, grace.accountId)).toMatchObject({
      name: 'Grace To Keep',
    });
    expect(await listPlaces({ database: app.database, sealer }, grace.accountId)).toHaveLength(1);
    expect(
      await readMedia(media, {
        accountId: grace.accountId,
        id: await firstPhotoOf(grace.accountId),
      }),
    ).toBeDefined();

    // The same token again is a replay, refused, even by a process that has just started; core's retry carries a new token and is a person nobody here knows, answered 200.
    expect((await handleAccountDeleted(form('account_deleted_token', token), world())).status).toBe(
      400,
    );
    const retry = await fake.noticeToken('account-deleted', { sub: 'delete-ada' });
    expect((await handleAccountDeleted(form('account_deleted_token', retry), world())).status).toBe(
      200,
    );
  });

  it('a notice that is wrong is refused and touches no one, and a deletion that fails is answered 500 so that core sends it again', async () => {
    const grace = await signIn('wrong-grace', 'grace.wrong@sovereign.test', 'Grace');
    for (const wrong of ['signature', 'audience', 'expired', 'type'] as const) {
      const token = await fake.noticeToken('account-deleted', { sub: 'wrong-grace' }, wrong);
      expect(
        (await handleAccountDeleted(form('account_deleted_token', token), world())).status,
        wrong,
      ).toBe(400);
    }
    expect(await userExists(grace.accountId)).toBe(true);

    const broken: NoticeDeps = {
      ...world(),
      people: {
        endSessions: async () => 0,
        deletePerson: async () => {
          throw new Error('the disk is full');
        },
      },
    };
    const token = await fake.noticeToken('account-deleted', { sub: 'wrong-grace' });
    expect((await handleAccountDeleted(form('account_deleted_token', token), broken)).status).toBe(
      500,
    );
    expect(await userExists(grace.accountId)).toBe(true);
  });
});

async function firstPhotoOf(accountId: string): Promise<string> {
  const rows = await dbAll<{ id: string }>(
    app.database,
    sql.raw(
      `SELECT id FROM ${app.database.dialect === 'postgres' ? 'waymark.media' : 'media'} WHERE account_id = '${accountId}' AND kind = 'photo'`,
    ),
  );
  return rows[0]?.id as string;
}
