import { randomBytes } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeAuth, type TestAuth } from '../auth/test-support';
import { Sealer } from '../crypto/sealed';
import { ringOf } from '../crypto/keys';
import type { Database } from '../db/client';
import { dbAll, dbGet } from '../db/exec';
import { openAppBesideAuth, testTarget } from '../db/test-support';
import {
  ProfileError,
  cleanEmail,
  cleanName,
  createProfile,
  ensureProfile,
  getProfile,
  updateProfile,
} from './profile';

const { leg } = testTarget();
const ring = ringOf(randomBytes(32));
if (!ring) throw new Error('no ring');
const sealer = new Sealer(ring);

let auth: TestAuth;
let app: Database;
let closeApp: () => Promise<void>;
let accounts = 0;
const PASSWORD = 'correct horse battery';

beforeAll(async () => {
  // Sign-up makes the profile, in the app store, as the server's hook does.
  auth = await makeAuth({ signUp: 'open' }, undefined, async (account) => {
    await createProfile(
      app,
      sealer,
      { accountId: account.id, name: account.name, email: account.email },
      1_700_000_000_000,
    );
  });
  ({ database: app, close: closeApp } = await openAppBesideAuth());
});
afterAll(async () => {
  await auth.close();
  await closeApp();
});

const count = async (accountId?: string) =>
  Number(
    (
      await dbGet<{ n: number | string }>(
        app,
        accountId
          ? sql`SELECT COUNT(*) AS n FROM ${sql.raw(app.dialect === 'postgres' ? 'waymark.profile' : 'profile')} WHERE account_id = ${accountId}`
          : sql`SELECT COUNT(*) AS n FROM ${sql.raw(app.dialect === 'postgres' ? 'waymark.profile' : 'profile')}`,
      )
    )?.n,
  );

async function signUp(name = 'Ada Lovelace') {
  const email = `Person${++accounts}@Example.com`;
  const client = auth.client().from(`10.9.${accounts}.1`);
  const reply = await client.post('/api/auth/sign-up/email', { name, email, password: PASSWORD });
  expect(reply.status).toBe(200);
  return { id: String((reply.body as { user: { id: string } }).user.id), email, name };
}

describe(`a profile (${leg})`, () => {
  it('is made with the account, exactly one for each, with the name and email as given (the email in lower case)', async () => {
    const before = await count();
    const a = await signUp('Ada Lovelace');
    const b = await signUp('Grace Hopper');
    expect(await count()).toBe(before + 2);
    expect(await count(a.id)).toBe(1);
    expect(await getProfile(app, sealer, a.id)).toMatchObject({
      accountId: a.id,
      name: 'Ada Lovelace',
      email: a.email.toLowerCase(),
      units: 'km',
      weekStart: 1,
      shareDefault: 'ask',
      coreSub: null,
    });
    expect(await getProfile(app, sealer, b.id)).toMatchObject({ name: 'Grace Hopper' });
  });

  it('is made once: asking again writes nothing, and the account keeps the one it has', async () => {
    const a = await signUp();
    expect(
      await createProfile(
        app,
        sealer,
        { accountId: a.id, name: 'Someone Else', email: 'x@example.com' },
        5,
      ),
    ).toBe(false);
    expect(await count(a.id)).toBe(1);
    expect((await getProfile(app, sealer, a.id))?.name).toBe('Ada Lovelace');
  });

  it('is made when it is first read, for an account whose hook did not run', async () => {
    const id = `lacking-${Date.now()}`;
    expect(await getProfile(app, sealer, id)).toBeUndefined();
    const made = await ensureProfile(
      app,
      sealer,
      { accountId: id, name: 'Late', email: 'late@example.com' },
      9,
    );
    expect(made).toMatchObject({ accountId: id, name: 'Late' });
    expect(
      await ensureProfile(
        app,
        sealer,
        { accountId: id, name: 'Other', email: 'o@example.com' },
        10,
      ),
    ).toMatchObject({
      name: 'Late',
    });
    expect(await count(id)).toBe(1);
  });

  it('holds no name or email in plain text: a raw read of the table finds neither, and the envelope opens only as this account', async () => {
    const a = await signUp('Raw-Name-PLANTED');
    const rows = await dbAll<Record<string, unknown>>(
      app,
      sql`SELECT * FROM ${sql.raw(app.dialect === 'postgres' ? 'waymark.profile' : 'profile')} WHERE account_id = ${a.id}`,
    );
    const dump = JSON.stringify(rows, (_k, v) =>
      v instanceof ArrayBuffer
        ? Buffer.from(v).toString('latin1')
        : v?.type === 'Buffer'
          ? Buffer.from(v.data).toString('latin1')
          : v,
    );
    expect(dump).not.toContain('PLANTED');
    expect(dump.toLowerCase()).not.toContain('example.com');
    expect(Object.keys(rows[0] ?? {}).sort()).toEqual(
      [
        'account_id',
        'core_sub',
        'created_at',
        'sealed',
        'share_default',
        'units',
        'updated_at',
        'week_start',
      ].sort(),
    );
    const sealed = rows[0]?.sealed;
    const bytes = new Uint8Array(sealed instanceof ArrayBuffer ? sealed : (sealed as Buffer));
    expect(sealer.unseal('profile', a.id, bytes)).toMatchObject({ name: 'Raw-Name-PLANTED' });
    expect(() => sealer.unseal('profile', 'someone-else', bytes)).toThrow();
  });

  it('is kept in step from Settings, for this account only, and its choices are checked', async () => {
    const a = await signUp();
    const b = await signUp('Bystander');
    const changed = await updateProfile(
      app,
      sealer,
      a.id,
      {
        name: '  Ada King  ',
        email: 'Ada.King@Example.com',
        units: 'mi',
        weekStart: 0,
        shareDefault: 'on',
      },
      20,
    );
    expect(changed).toMatchObject({
      name: 'Ada King',
      email: 'ada.king@example.com',
      units: 'mi',
      weekStart: 0,
      shareDefault: 'on',
      updatedAt: 20,
    });
    // A change of one thing leaves the rest, and nothing of another account moves.
    expect(await updateProfile(app, sealer, a.id, { units: 'km' }, 21)).toMatchObject({
      name: 'Ada King',
      units: 'km',
      weekStart: 0,
    });
    expect(await getProfile(app, sealer, b.id)).toMatchObject({
      name: 'Bystander',
      units: 'km',
      updatedAt: 1_700_000_000_000,
    });
    expect(await updateProfile(app, sealer, 'nobody', { name: 'X' }, 22)).toBeUndefined();
    for (const bad of [
      { name: '' },
      { name: 'a\nb' },
      { email: 'not an address' },
      { units: 'furlongs' as never },
      { weekStart: 7 },
      { weekStart: 1.5 },
      { shareDefault: 'maybe' as never },
    ])
      await expect(updateProfile(app, sealer, a.id, bad, 23), JSON.stringify(bad)).rejects.toThrow(
        ProfileError,
      );
  });

  it('says what is wrong without saying what it was given', () => {
    for (const run of [
      () => cleanName('x'.repeat(101)),
      () => cleanEmail('PLANTED-not-an-address'),
    ]) {
      try {
        run();
        expect.unreachable();
      } catch (error) {
        expect(error).toBeInstanceOf(ProfileError);
        expect((error as Error).message).not.toContain('PLANTED');
        expect((error as Error).message).not.toContain('xxxx');
      }
    }
  });
});
