import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testTarget } from '../db/test-support';
import { type TestAuth, type TestClient, makeAuth } from './test-support';

/**
 * An authenticator app and backup codes (DESIGN.md §6, §19), over real requests: it is on only once a code from the app has been shown to work; sign-in then
 * asks for a code, or a backup code, which is good once; turning it off and making new codes ask for the password. Passkeys need a browser's authenticator and
 * are tried in one (`e2e/passkeys.spec.ts`).
 */
const { leg } = testTarget();
const PASSWORD = 'correct horse battery';

let t: TestAuth;
let n = 0;
beforeAll(async () => {
  t = await makeAuth({ signUp: 'open' });
});
afterAll(async () => t.close());

const visitor = (): TestClient => t.client().from(`10.7.${Math.floor(n / 250)}.${(n++ % 250) + 1}`);
import { totpFor as code } from './testing/totp';

async function account() {
  const email = `tf${++n}@example.com`;
  const client = visitor();
  await client.post('/api/auth/sign-up/email', { name: 'Ada', email, password: PASSWORD });
  return { client, email };
}

/** Enrols an authenticator and shows a code from it to work: returns the address of the secret and the backup codes. */
async function enrolled() {
  const { client, email } = await account();
  const begun = await client.post('/api/auth/two-factor/enable', { password: PASSWORD });
  expect(begun.status).toBe(200);
  const { totpURI, backupCodes } = begun.body as { totpURI: string; backupCodes: string[] };
  const verified = await client.post('/api/auth/two-factor/verify-totp', {
    code: await code(totpURI),
  });
  expect(verified.status).toBe(200);
  return { client, email, totpURI, backupCodes };
}

describe(`an authenticator app (${leg})`, () => {
  it('asks for the password to begin, gives the address of a secret and ten backup codes, and is not on until a code has worked', async () => {
    const { client, email } = await account();
    expect(
      (await client.post('/api/auth/two-factor/enable', { password: 'not my password at all' }))
        .status,
    ).toBeGreaterThanOrEqual(400);
    const begun = await client.post('/api/auth/two-factor/enable', { password: PASSWORD });
    expect(begun.status).toBe(200);
    const { totpURI, backupCodes } = begun.body as { totpURI: string; backupCodes: string[] };
    expect(totpURI).toMatch(/^otpauth:\/\/totp\//);
    expect(totpURI).toContain('issuer=Waymark');
    expect(backupCodes).toHaveLength(10);
    // Not on yet: a fresh sign-in is still by the password alone.
    const other = await visitor().post('/api/auth/sign-in/email', { email, password: PASSWORD });
    expect(other.body).not.toMatchObject({ twoFactorRedirect: true });
    // A wrong code does not turn it on; the right one does.
    expect(
      (await client.post('/api/auth/two-factor/verify-totp', { code: '000000' })).status,
    ).toBeGreaterThanOrEqual(400);
    expect(
      (await client.post('/api/auth/two-factor/verify-totp', { code: await code(totpURI) })).status,
    ).toBe(200);
    const after = await visitor().post('/api/auth/sign-in/email', { email, password: PASSWORD });
    expect(after.body).toMatchObject({ twoFactorRedirect: true });
  });

  it('asks for a code after the password, signs in with a right one, and not with a wrong one', async () => {
    const { email, totpURI } = await enrolled();
    const client = visitor();
    const first = await client.post('/api/auth/sign-in/email', { email, password: PASSWORD });
    expect(first.body).toMatchObject({ twoFactorRedirect: true });
    // The password alone is not a session.
    expect((await client.get('/api/auth/get-session')).body).toBeNull();
    expect(
      (await client.post('/api/auth/two-factor/verify-totp', { code: '123456' })).status,
    ).toBeGreaterThanOrEqual(400);
    expect((await client.get('/api/auth/get-session')).body).toBeNull();
    expect(
      (await client.post('/api/auth/two-factor/verify-totp', { code: await code(totpURI) })).status,
    ).toBe(200);
    expect((await client.get('/api/auth/get-session')).body).not.toBeNull();
  });

  it('lets a backup code stand in for the app, once', async () => {
    const { email, backupCodes } = await enrolled();
    const spend = async () => {
      const client = visitor();
      await client.post('/api/auth/sign-in/email', { email, password: PASSWORD });
      return client.post('/api/auth/two-factor/verify-backup-code', { code: backupCodes[0] });
    };
    expect((await spend()).status).toBe(200);
    // A spent code is refused, and another one still works.
    expect((await spend()).status).toBeGreaterThanOrEqual(400);
    const client = visitor();
    await client.post('/api/auth/sign-in/email', { email, password: PASSWORD });
    expect(
      (await client.post('/api/auth/two-factor/verify-backup-code', { code: backupCodes[1] }))
        .status,
    ).toBe(200);
    // A code that is not one is refused.
    const nobody = visitor();
    await nobody.post('/api/auth/sign-in/email', { email, password: PASSWORD });
    expect(
      (await nobody.post('/api/auth/two-factor/verify-backup-code', { code: 'not-a-code' })).status,
    ).toBeGreaterThanOrEqual(400);
  });

  it('makes new backup codes only for the password, and the old ones stop working', async () => {
    const { client, email, backupCodes } = await enrolled();
    expect(
      (
        await client.post('/api/auth/two-factor/generate-backup-codes', {
          password: 'not my password at all',
        })
      ).status,
    ).toBeGreaterThanOrEqual(400);
    const fresh = await client.post('/api/auth/two-factor/generate-backup-codes', {
      password: PASSWORD,
    });
    expect(fresh.status).toBe(200);
    const next = (fresh.body as { backupCodes: string[] }).backupCodes;
    expect(next).toHaveLength(10);
    expect(next.some((each) => backupCodes.includes(each))).toBe(false);
    const old = visitor();
    await old.post('/api/auth/sign-in/email', { email, password: PASSWORD });
    expect(
      (await old.post('/api/auth/two-factor/verify-backup-code', { code: backupCodes[2] })).status,
    ).toBeGreaterThanOrEqual(400);
    const good = visitor();
    await good.post('/api/auth/sign-in/email', { email, password: PASSWORD });
    expect(
      (await good.post('/api/auth/two-factor/verify-backup-code', { code: next[0] })).status,
    ).toBe(200);
  });

  it('is turned off only for the password, and then sign-in is by the password alone again', async () => {
    const { client, email } = await enrolled();
    expect(
      (await client.post('/api/auth/two-factor/disable', { password: 'not my password at all' }))
        .status,
    ).toBeGreaterThanOrEqual(400);
    expect((await client.post('/api/auth/two-factor/disable', { password: PASSWORD })).status).toBe(
      200,
    );
    const plain = visitor();
    const reply = await plain.post('/api/auth/sign-in/email', { email, password: PASSWORD });
    expect(reply.body).not.toMatchObject({ twoFactorRedirect: true });
    expect((await plain.get('/api/auth/get-session')).body).not.toBeNull();
  });

  it('keeps one account’s authenticator from another’s', async () => {
    const one = await enrolled();
    const two = await account();
    const begun = await two.client.post('/api/auth/two-factor/enable', { password: PASSWORD });
    const other = (begun.body as { totpURI: string }).totpURI;
    // A code from the first account’s app does not turn on the second’s.
    expect(
      (await two.client.post('/api/auth/two-factor/verify-totp', { code: await code(one.totpURI) }))
        .status,
    ).toBeGreaterThanOrEqual(400);
    expect(
      (await two.client.post('/api/auth/two-factor/verify-totp', { code: await code(other) }))
        .status,
    ).toBe(200);
  });

  it('refuses the second step to someone who has not done the first', async () => {
    const { totpURI } = await enrolled();
    const stranger = visitor();
    expect(
      (await stranger.post('/api/auth/two-factor/verify-totp', { code: await code(totpURI) }))
        .status,
    ).toBeGreaterThanOrEqual(400);
    expect((await stranger.get('/api/auth/get-session')).body).toBeNull();
  });
});
