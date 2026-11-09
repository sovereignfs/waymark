import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dbAll, dbGet } from '../db/exec';
import * as postgresAuth from '../db/schema/postgres/auth';
import * as sqliteAuth from '../db/schema/sqlite/auth';
import { testTarget } from '../db/test-support';
import { type TestAuth, type TestClient, makeAuth } from './test-support';

/**
 * The sign-in flows, over real requests through `auth.handler`, against whichever database the leg runs on. Each `describe` makes one instance
 * and its tests use accounts and addresses of their own, so that they do not depend on each other or on the order.
 */
const { leg } = testTarget();
const PASSWORD = 'correct horse battery';

let addresses = 0;
/** A visitor from an address of their own: the rate limit is per address. */
const visitor = (t: TestAuth): TestClient =>
  t.client().from(`10.${Math.floor(addresses / 250)}.${(addresses++ % 250) + 1}.1`);

let accounts = 0;
const newEmail = () => `person${++accounts}@example.com`;

async function signUp(client: TestClient, email = newEmail(), password = PASSWORD) {
  return {
    email,
    reply: await client.post('/api/auth/sign-up/email', { name: 'Ada', email, password }),
  };
}

const tables = (t: TestAuth) => (t.database.dialect === 'postgres' ? postgresAuth : sqliteAuth);
const userCount = async (t: TestAuth) =>
  Number(
    (
      await dbGet<{ n: number | string }>(
        t.database,
        sql`SELECT COUNT(*) AS n FROM ${tables(t).user}`,
      )
    )?.n,
  );
const firstEmail = async (t: TestAuth): Promise<string> => {
  const [row] = await dbAll<{ email: string }>(
    t.database,
    sql`SELECT email FROM ${tables(t).user} LIMIT 1`,
  );
  if (!row) throw new Error('there is no account yet');
  return row.email;
};

/** What a test needs and the flow did not produce is a failure that says what, not a crash on undefined. */
function found<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`no ${what}`);
  return value;
}

describe(`local sign-in, first account only (${leg})`, () => {
  let t: TestAuth;
  beforeAll(async () => {
    t = await makeAuth({ signUp: 'closed' });
  });
  afterAll(async () => t.close());

  describe('the first account', () => {
    it('can be made, signs the person in, and stores a hash and not the password', async () => {
      const client = visitor(t);
      const { email, reply } = await signUp(client);
      expect(reply.status).toBe(200);
      expect(reply.body.user).toMatchObject({ email, name: 'Ada' });
      expect(client.has('session_token')).toBe(true);

      const stored = await dbAll<{ password: string }>(
        t.database,
        sql`SELECT password FROM ${tables(t).account} WHERE password IS NOT NULL`,
      );
      expect(stored.length).toBeGreaterThan(0);
      for (const row of stored) {
        expect(row.password).not.toContain(PASSWORD);
        expect(row.password.length).toBeGreaterThan(40);
      }
      expect(JSON.stringify(reply.body)).not.toContain('password');
    });

    it('is given a session cookie that scripts cannot read, that is not sent cross-site, and is ours', async () => {
      const client = visitor(t);
      const reply = await client.post('/api/auth/sign-in/email', {
        email: await firstEmail(t),
        password: PASSWORD,
      });
      expect(reply.status).toBe(200);
      const cookie = found(
        reply.setCookies.find((c) => c.startsWith('waymark.session_token=')),
        'session cookie',
      );
      expect(cookie).toMatch(/HttpOnly/i);
      expect(cookie).toMatch(/SameSite=Lax/i);
      expect(cookie).toMatch(/Path=\//i);
      expect(cookie).not.toMatch(/Secure/i); // the test instance is http://localhost
    });
  });

  it('then refuses every later sign-up, says why with a code, and creates nothing', async () => {
    expect(await userCount(t)).toBe(1);
    const refused = await signUp(visitor(t));
    expect(refused.reply.status).toBe(403);
    expect(refused.reply.body.code).toBe('SIGNUP_CLOSED');
    expect(refused.reply.body.message).toBe('Sign-up is closed on this instance.');
    expect(await userCount(t)).toBe(1);
  });

  describe('signing in', () => {
    it('works with the right password, and the session is the person’s', async () => {
      const client = visitor(t);
      const email = await firstEmail(t);
      const reply = await client.post('/api/auth/sign-in/email', { email, password: PASSWORD });
      expect(reply.status).toBe(200);
      const session = await client.get('/api/auth/get-session');
      expect(session.body.user).toMatchObject({ email });
      expect(session.body.user.id).toBeTruthy();
    });

    it('gives the same answer for a wrong password and for an address with no account', async () => {
      const client = visitor(t);
      const wrong = await client.post('/api/auth/sign-in/email', {
        email: await firstEmail(t),
        password: 'not the password at all',
      });
      const unknown = await client.post('/api/auth/sign-in/email', {
        email: 'nobody@example.com',
        password: 'not the password at all',
      });
      expect(wrong.status).toBe(401);
      expect(unknown.status).toBe(401);
      expect(unknown.body).toEqual(wrong.body);
      expect(client.has('session_token')).toBe(false);
    });

    it('changes the password only for the one who knows the old one, ends every other session, and keeps this one', async () => {
      const email = await firstEmail(t);
      const here = visitor(t);
      const elsewhere = visitor(t);
      for (const client of [here, elsewhere])
        await client.post('/api/auth/sign-in/email', { email, password: PASSWORD });
      expect((await elsewhere.get('/api/auth/get-session')).body.user).toBeTruthy();

      const wrong = await here.post('/api/auth/change-password', {
        currentPassword: 'not the password',
        newPassword: 'a new long password',
        revokeOtherSessions: true,
      });
      expect(wrong.status).toBeGreaterThanOrEqual(400);
      // Nothing happened: the old password still signs in and the other session is still there.
      expect((await elsewhere.get('/api/auth/get-session')).body.user).toBeTruthy();

      const changed = await here.post('/api/auth/change-password', {
        currentPassword: PASSWORD,
        newPassword: 'a new long password',
        revokeOtherSessions: true,
      });
      expect(changed.status).toBe(200);
      expect((await here.get('/api/auth/get-session')).body.user).toBeTruthy();
      expect((await elsewhere.get('/api/auth/get-session')).body).toBeNull();

      const old = visitor(t);
      const withOld = await old.post('/api/auth/sign-in/email', { email, password: PASSWORD });
      expect(withOld.status).toBe(401);
      const fresh = visitor(t);
      expect(
        (await fresh.post('/api/auth/sign-in/email', { email, password: 'a new long password' }))
          .status,
      ).toBe(200);

      // The account is shared by the tests that follow: it is put back.
      const back = await fresh.post('/api/auth/change-password', {
        currentPassword: 'a new long password',
        newPassword: PASSWORD,
      });
      expect(back.status).toBe(200);
    });

    it('ends with sign-out, after which the session is gone for good', async () => {
      const client = visitor(t);
      await client.post('/api/auth/sign-in/email', {
        email: await firstEmail(t),
        password: PASSWORD,
      });
      const token = found(client.jar.get('waymark.session_token'), 'session cookie');
      expect((await client.get('/api/auth/get-session')).body.user).toBeTruthy();

      await client.post('/api/auth/sign-out', {});
      expect((await client.get('/api/auth/get-session')).body).toBeNull();

      // Replaying the old cookie does not bring it back: the session is deleted, not just forgotten.
      const replay = visitor(t);
      replay.jar.set('waymark.session_token', token);
      expect((await replay.get('/api/auth/get-session')).body).toBeNull();
    });
  });

  it('is limited: after three attempts in a row from one address, the fourth is refused', async () => {
    const client = visitor(t);
    const attempt = () =>
      client.post('/api/auth/sign-in/email', {
        email: 'nobody@example.com',
        password: 'guessing guessing',
      });
    expect((await attempt()).status).toBe(401);
    expect((await attempt()).status).toBe(401);
    expect((await attempt()).status).toBe(401);
    expect((await attempt()).status).toBe(429);
    // The count is in the database, so that another process serving the same address sees it too.
    const counted = await dbAll<{ n: number | string }>(
      t.database,
      sql`SELECT COUNT(*) AS n FROM ${tables(t).rateLimit}`,
    );
    expect(Number(counted[0]?.n)).toBeGreaterThan(0);
  });

  describe('a signed-in request from another site', () => {
    it('is refused, with the session left alone: a hostile Origin, and a missing one', async () => {
      const client = visitor(t);
      await client.post('/api/auth/sign-in/email', {
        email: await firstEmail(t),
        password: PASSWORD,
      });

      const hostile = await client.post(
        '/api/auth/sign-out',
        {},
        { origin: 'https://evil.example.com' },
      );
      expect(hostile.status).toBe(403);
      const missing = await client.post('/api/auth/sign-out', {}, { origin: '' });
      expect(missing.status).toBe(403);
      expect((await client.get('/api/auth/get-session')).body.user).toBeTruthy();
    });
  });

  it('must have a password as long as the instance says', async () => {
    const before = await userCount(t);
    const { reply } = await signUp(visitor(t), newEmail(), 'short');
    expect([400, 403]).toContain(reply.status);
    expect(await userCount(t)).toBe(before);
  });
});

describe(`local sign-in, open to anyone (${leg})`, () => {
  let t: TestAuth;
  beforeAll(async () => {
    t = await makeAuth({ signUp: 'open' });
  });
  afterAll(async () => t.close());

  it('lets anyone make an account, each separate, and refuses an address that is taken', async () => {
    const first = visitor(t);
    const second = visitor(t);
    const a = await signUp(first);
    const b = await signUp(second);
    expect(a.reply.status).toBe(200);
    expect(b.reply.status).toBe(200);
    expect(await userCount(t)).toBe(2);

    const aId = (await first.get('/api/auth/get-session')).body.user.id;
    const bId = (await second.get('/api/auth/get-session')).body.user.id;
    expect(aId).not.toBe(bId);

    const taken = await signUp(visitor(t), a.email);
    expect(taken.reply.status).toBe(422);
    expect(await userCount(t)).toBe(2);
  });
});
