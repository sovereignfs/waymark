import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testTarget } from '../db/test-support';
import { MemoryMailer } from '../mail/memory';
import { needsMail } from './mail-routes';
import { type TestAuth, type TestClient, makeAuth } from './test-support';

/**
 * Sign-in with mail (DESIGN.md §6), over real requests through `auth.handler` with a mailer a test can read. An address is verified before its first sign-in
 * and the link signs the person in; a forgotten password is reset by a link that is good once, and using it ends every other session. No reply says whether an
 * address has an account. Without mail none of it exists.
 */
const { leg } = testTarget();
const PASSWORD = 'correct horse battery';
const NEW_PASSWORD = 'another long password here';

let t: TestAuth;
let mailer: MemoryMailer;
let addresses = 0;
let accounts = 0;
beforeAll(async () => {
  mailer = new MemoryMailer();
  t = await makeAuth({ signUp: 'open' }, mailer);
});
afterAll(async () => t.close());

const visitor = (): TestClient =>
  t.client().from(`10.9.${Math.floor(addresses / 250)}.${(addresses++ % 250) + 1}`);
const email = () => `mail${++accounts}@example.com`;
/** The path and query of a link, as the browser would ask for it. */
const pathOf = (link: string | undefined): string => {
  if (!link) throw new Error('no link was sent');
  const url = new URL(link);
  return `${url.pathname}${url.search}`;
};

async function signedUp(address = email()) {
  const client = visitor();
  const reply = await client.post('/api/auth/sign-up/email', {
    name: 'Ada',
    email: address,
    password: PASSWORD,
  });
  return { client, address, reply };
}

describe(`verifying an address (${leg})`, () => {
  it('makes the account but does not sign the person in, and sends one link', async () => {
    const { client, address, reply } = await signedUp();
    expect(reply.status).toBe(200);
    expect(client.has('session_token')).toBe(false);
    expect(mailer.sent.filter((m) => m.to === address)).toHaveLength(1);
    expect(mailer.sent.at(-1)?.subject).toContain('Confirm your address');
  });

  it('refuses a sign-in before the address is confirmed, and says to open the link', async () => {
    const { client, address } = await signedUp();
    const reply = await client.post('/api/auth/sign-in/email', {
      email: address,
      password: PASSWORD,
    });
    expect(reply.status).toBe(403);
    expect(reply.body).toMatchObject({ code: 'EMAIL_NOT_VERIFIED' });
    expect(client.has('session_token')).toBe(false);
  });

  it('signs the person in when the link is opened, and the account then signs in with its password', async () => {
    const { client, address } = await signedUp();
    const opened = await client.get(pathOf(mailer.linkTo(address)));
    expect([200, 302]).toContain(opened.status);
    expect(client.has('session_token')).toBe(true);
    const again = visitor();
    const reply = await again.post('/api/auth/sign-in/email', {
      email: address,
      password: PASSWORD,
    });
    expect(reply.status).toBe(200);
  });

  it('does not sign anyone in on a link that is not good', async () => {
    const { client, address } = await signedUp();
    const link = pathOf(mailer.linkTo(address));
    const spoiled = link.replace(/token=[^&]+/, 'token=not-a-token');
    const reply = await client.get(spoiled);
    expect(client.has('session_token')).toBe(false);
    expect(reply.status).not.toBe(200);
  });

  it('sends a new link to someone who signs in unconfirmed, and says the same of an address that has no account', async () => {
    const { client, address } = await signedUp();
    const before = mailer.sent.length;
    await client.post('/api/auth/sign-in/email', { email: address, password: PASSWORD });
    expect(mailer.sent.length).toBe(before + 1);
    const stranger = await visitor().post('/api/auth/sign-in/email', {
      email: 'nobody@example.com',
      password: PASSWORD,
    });
    expect(stranger.body).toMatchObject({ code: 'INVALID_EMAIL_OR_PASSWORD' });
  });
});

describe(`resetting a password (${leg})`, () => {
  async function confirmed() {
    const made = await signedUp();
    await made.client.get(pathOf(mailer.linkTo(made.address)));
    return made;
  }
  const tokenOf = async (client: TestClient, link: string | undefined): Promise<string> => {
    // The link goes to better-auth, which redirects to the page with the token; the token is what the page gives back.
    const reply = await client.get(pathOf(link));
    const location = reply.headers.get('location') ?? '';
    const token = new URL(location, 'http://localhost:3000').searchParams.get('token');
    if (!token) throw new Error(`the link gave no token: ${reply.status} ${location}`);
    return token;
  };

  it('is asked for by address, answered the same whether or not there is an account, and sends a link only to one that has', async () => {
    const { address } = await confirmed();
    const before = mailer.sent.length;
    const known = await visitor().post('/api/auth/request-password-reset', {
      email: address,
      redirectTo: '/reset-password',
    });
    const unknown = await visitor().post('/api/auth/request-password-reset', {
      email: 'nobody-at-all@example.com',
      redirectTo: '/reset-password',
    });
    expect(known.status).toBe(200);
    expect(unknown.status).toBe(200);
    expect(JSON.stringify(known.body)).toBe(JSON.stringify(unknown.body));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(mailer.sent.length).toBe(before + 1);
    expect(mailer.sent.at(-1)?.subject).toContain('Reset your');
  });

  it('chooses a new password with the link, once, and the old password no longer works', async () => {
    const { address } = await confirmed();
    const client = visitor();
    await client.post('/api/auth/request-password-reset', {
      email: address,
      redirectTo: '/reset-password',
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const token = await tokenOf(client, mailer.linkTo(address));
    const done = await client.post('/api/auth/reset-password', {
      newPassword: NEW_PASSWORD,
      token,
    });
    expect(done.status).toBe(200);
    expect(
      (await visitor().post('/api/auth/sign-in/email', { email: address, password: PASSWORD }))
        .status,
    ).toBe(401);
    expect(
      (await visitor().post('/api/auth/sign-in/email', { email: address, password: NEW_PASSWORD }))
        .status,
    ).toBe(200);
    // Used twice: refused, and the password is not changed again.
    const again = await client.post('/api/auth/reset-password', {
      newPassword: 'a third long password',
      token,
    });
    expect(again.status).toBeGreaterThanOrEqual(400);
    expect(
      (await visitor().post('/api/auth/sign-in/email', { email: address, password: NEW_PASSWORD }))
        .status,
    ).toBe(200);
  });

  it('ends every other session when it is used', async () => {
    const { address, client: first } = await confirmed();
    const second = visitor();
    await second.post('/api/auth/sign-in/email', { email: address, password: PASSWORD });
    expect((await first.get('/api/auth/get-session')).body).not.toBeNull();
    expect((await second.get('/api/auth/get-session')).body).not.toBeNull();
    const asker = visitor();
    await asker.post('/api/auth/request-password-reset', {
      email: address,
      redirectTo: '/reset-password',
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const token = await tokenOf(asker, mailer.linkTo(address));
    await asker.post('/api/auth/reset-password', { newPassword: NEW_PASSWORD, token });
    expect((await first.get('/api/auth/get-session')).body).toBeNull();
    expect((await second.get('/api/auth/get-session')).body).toBeNull();
  });

  it('refuses a token that is not one, and a password that is too short', async () => {
    const { address } = await confirmed();
    const client = visitor();
    expect(
      (
        await client.post('/api/auth/reset-password', {
          newPassword: NEW_PASSWORD,
          token: 'nonsense',
        })
      ).status,
    ).toBeGreaterThanOrEqual(400);
    await client.post('/api/auth/request-password-reset', {
      email: address,
      redirectTo: '/reset-password',
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const token = await tokenOf(client, mailer.linkTo(address));
    expect(
      (await client.post('/api/auth/reset-password', { newPassword: 'short', token })).status,
    ).toBeGreaterThanOrEqual(400);
    // A short password did not spend the link.
    expect(
      (await client.post('/api/auth/reset-password', { newPassword: NEW_PASSWORD, token })).status,
    ).toBe(200);
  });

  it('does not fail, or answer differently, when the mail server does not take the message', async () => {
    const { address } = await confirmed();
    mailer.failNext = 1;
    const reply = await visitor().post('/api/auth/request-password-reset', {
      email: address,
      redirectTo: '/reset-password',
    });
    expect(reply.status).toBe(200);
  });
});

describe(`without mail (${leg})`, () => {
  let plain: TestAuth;
  beforeAll(async () => {
    plain = await makeAuth({ signUp: 'open' });
  });
  afterAll(async () => plain.close());

  it('signs a new account in at once and sends nothing, as before', async () => {
    const client = plain.client().from('10.8.0.1');
    const reply = await client.post('/api/auth/sign-up/email', {
      name: 'Ada',
      email: 'ada@example.com',
      password: PASSWORD,
    });
    expect(reply.status).toBe(200);
    expect(client.has('session_token')).toBe(true);
  });

  it('has no reset to ask for, and the routes that would are named so that the server answers 404 for them', () => {
    for (const path of [
      '/api/auth/request-password-reset',
      '/api/auth/reset-password',
      '/api/auth/reset-password/abc123',
      '/api/auth/send-verification-email',
      '/api/auth/verify-email',
      '/api/auth/verify-email/',
    ])
      expect(needsMail(path), path).toBe(true);
    for (const path of [
      '/api/auth/sign-in/email',
      '/api/auth/sign-up/email',
      '/api/auth/get-session',
      '/api/auth/sign-out',
      '/api/auth/reset-password-not',
    ])
      expect(needsMail(path), path).toBe(false);
  });
});
