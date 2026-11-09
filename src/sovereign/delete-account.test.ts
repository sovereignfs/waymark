import { randomBytes } from 'node:crypto';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { accountRoute } from '../access/route';
import { type TwoAccounts, twoAccounts } from '../access/two-accounts';
import { ringOf } from '../crypto/keys';
import type { Database } from '../db/client';
import { dbAll } from '../db/exec';
import * as postgresAuth from '../db/schema/postgres/auth';
import * as sqliteAuth from '../db/schema/sqlite/auth';
import { openAppBesideAuth, testTarget } from '../db/test-support';
import { RateLimiter } from '../limits/rate';
import { type MediaDeps, putMedia, usageOf } from '../media/service';
import { type DeleteDeps, deleteAccount, deletionPreview } from './delete-account';

/**
 * `/api/account/delete` (DESIGN.md §23): the preview, and the deletion with the password, for the session's account and no other. A password that is not the account's
 * deletes nothing; the right one does, files included, and the session ends with the account.
 */
const { leg } = testTarget();
const PASSWORD = 'a password long enough to be one';
const ring = ringOf(randomBytes(32));
if (!ring) throw new Error('no ring');

let t: TwoAccounts;
let database: Database;
let close: () => Promise<void>;
let directory: string;
let media: MediaDeps;
beforeAll(async () => {
  t = await twoAccounts();
  ({ database, close } = await openAppBesideAuth());
  directory = mkdtempSync(path.join(tmpdir(), 'waymark-delete-'));
  media = {
    database,
    ring,
    dir: path.join(directory, 'media'),
    maxAccountBytes: 100 * 1024 * 1024,
    now: () => 1_800_000_000_000,
  };
});
afterAll(async () => {
  await t.close();
  await close();
  rmSync(directory, { recursive: true, force: true });
});

const deps = (extra: Partial<DeleteDeps> = {}): DeleteDeps => ({
  database,
  authDatabase: t.auth.database,
  media,
  limiter: { take: async () => ({ ok: true }) },
  now: () => 1_800_000_000_000,
  verify: async (request, password) => {
    try {
      return (
        (await t.auth.auth.api.verifyPassword({ body: { password }, headers: request.headers }))
          .status === true
      );
    } catch {
      return false;
    }
  },
  hasPassword: async () => true,
  fresh: async () => true,
  ...extra,
});
const routes = (extra: Partial<DeleteDeps> = {}) => ({
  preview: accountRoute(({ accountId }) => deletionPreview(accountId, deps(extra)), t.deps),
  remove: accountRoute(
    ({ request, accountId }) => deleteAccount(request, accountId, deps(extra)),
    t.deps,
  ),
});
const post = (who: typeof t.ada | null, body: unknown, headers = {}) =>
  t.request(who, '/api/account/delete', { method: 'POST', body, headers });
const users = async () =>
  (
    await dbAll<{ id: string }>(
      t.auth.database,
      sql`SELECT id FROM ${t.auth.database.dialect === 'postgres' ? postgresAuth.user : sqliteAuth.user}`,
    )
  ).map((row) => row.id);
const photo = () =>
  sharp({ create: { width: 20, height: 10, channels: 3, background: { r: 9, g: 9, b: 200 } } })
    .jpeg()
    .toBuffer();
const files = () => {
  try {
    return readdirSync(media.dir).length;
  } catch {
    return 0;
  }
};

describe(`deleting the account over HTTP (${leg})`, () => {
  it('is for someone signed in and from the app', async () => {
    const r = routes();
    expect((await r.preview(t.request(null, '/api/account/delete'))).status).toBe(401);
    expect((await r.remove(post(null, { password: PASSWORD }))).status).toBe(401);
    expect(
      (await r.remove(post(t.grace, { password: PASSWORD }, { origin: 'https://evil.example' })))
        .status,
    ).toBe(403);
    expect(await users()).toContain(t.grace.id);
  });

  it('says what it would do: whether it asks for a password, and what files go', async () => {
    const empty = await routes().preview(t.request(t.grace, '/api/account/delete'));
    expect(await empty.json()).toEqual({ password: true, files: 0, bytes: 0 });
    await putMedia(media, { accountId: t.grace.id, kind: 'photo', bytes: await photo() });
    const preview = (await (
      await routes().preview(t.request(t.grace, '/api/account/delete'))
    ).json()) as { password: boolean; files: number; bytes: number };
    // A photo and its thumbnail.
    expect(preview).toMatchObject({ password: true, files: 2 });
    expect(preview.bytes).toBe(await usageOf(database, t.grace.id));
  });

  it('refuses a wrong password and an absent one, deleting nothing, and counts the tries', async () => {
    const r = routes();
    for (const body of [
      { password: 'not the password at all' },
      {},
      { password: '' },
      { password: 5 },
      null,
    ]) {
      const response = await r.remove(post(t.grace, body));
      expect([400, 403], JSON.stringify(body)).toContain(response.status);
    }
    expect(await users()).toContain(t.grace.id);
    expect(files()).toBe(2);
    const raw = await r.remove(
      new Request(t.request(t.grace, '/x').url.replace('/x', '/api/account/delete'), {
        method: 'POST',
        headers: {
          origin: new URL(t.request(t.grace, '/x').url).origin,
          cookie: t.grace.client.cookieHeader(),
        },
        body: '{no',
      }),
    );
    expect(raw.status).toBe(400);
    const limited = routes({ limiter: new RateLimiter(database) });
    let last = 0;
    for (let n = 0; n < 7; n += 1)
      last = (await limited.remove(post(t.grace, { password: 'wrong wrong wrong' }))).status;
    expect(last).toBe(429);
    expect(await users()).toContain(t.grace.id);
    expect(files()).toBe(2);
  });

  it('deletes the account of the session with the right password and no other, files included, and the session ends with it', async () => {
    const r = routes();
    await putMedia(media, { accountId: t.ada.id, kind: 'photo', bytes: await photo() });
    expect(files()).toBe(4);
    const done = await r.remove(post(t.grace, { password: PASSWORD }));
    expect(done.status).toBe(204);
    expect(await users()).toEqual([t.ada.id]);
    expect(await usageOf(database, t.grace.id)).toBe(0);
    // Hers are gone from the disk and his are not.
    expect(files()).toBe(2);
    // Her cookies no longer make a session.
    expect((await r.preview(t.request(t.grace, '/api/account/delete'))).status).toBe(401);
    // Ada's are untouched.
    expect((await r.preview(t.request(t.ada, '/api/account/delete'))).status).toBe(200);
  });

  it('asks an account with no password for a session made just now instead, and deletes nothing for a stale one', async () => {
    const noPassword = { hasPassword: async () => false };
    // The preview says there is no password to ask for.
    const preview = await routes(noPassword).preview(t.request(t.ada, '/api/account/delete'));
    expect(await preview.json()).toMatchObject({ password: false });

    const stale = routes({ ...noPassword, fresh: async () => false });
    const refused = await stale.remove(post(t.ada, {}));
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ code: 'SESSION_NOT_FRESH' });
    // A password it does not have is not a way round.
    expect((await stale.remove(post(t.ada, { password: PASSWORD }))).status).toBe(403);
    expect(await users()).toContain(t.ada.id);

    const fresh = routes({ ...noPassword, fresh: async () => true });
    expect((await fresh.remove(post(t.ada, {}))).status).toBe(204);
    expect(await users()).not.toContain(t.ada.id);
    expect(files()).toBe(0);
  });
});
