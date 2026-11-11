import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { unzipSync } from 'fflate';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { accountRoute } from '../access/route';
import { type TwoAccounts, twoAccounts } from '../access/two-accounts';
import { type KeyRing, ringOf } from '../crypto/keys';
import { Sealer } from '../crypto/sealed';
import type { Database } from '../db/client';
import { openAppBesideAuth, testTarget } from '../db/test-support';
import { createProfile } from '../profile/profile';
import { type ExportDeps, READY_FOR_MS, workOnExports } from './export';
import { JSON_NAME } from './format';
import { deleteResponse, downloadResponse, listResponse, requestResponse } from './http';

/** The exports' routes, called as the person and as someone else, over real sessions (DESIGN.md §5.2, §22). */
const { leg } = testTarget();
const made = ringOf(randomBytes(32));
if (!made) throw new Error('no ring');
const ring: KeyRing = made;
const sealer = new Sealer(ring);

let t: TwoAccounts;
let database: Database;
let close: () => Promise<void>;
let directory: string;
let deps: ExportDeps;
let allow = true;
let NOW = 1_800_000_000_000;
beforeAll(async () => {
  t = await twoAccounts();
  ({ database, close } = await openAppBesideAuth());
  directory = mkdtempSync(path.join(tmpdir(), 'waymark-export-http-'));
  deps = {
    database,
    sealer,
    ring,
    dir: path.join(directory, 'exports'),
    media: {
      database,
      ring,
      dir: path.join(directory, 'media'),
      maxAccountBytes: 100 * 1024 * 1024,
      now: () => NOW,
    },
    now: () => NOW,
  };
  for (const [who, name] of [
    [t.ada, 'Ada Lovelace'],
    [t.grace, 'Grace Hopper'],
  ] as const)
    await createProfile(database, sealer, { accountId: who.id, name, email: who.email }, NOW);
});
afterAll(async () => {
  await t.close();
  await close();
  rmSync(directory, { recursive: true, force: true });
});

const wrapped = {
  origin: () => t.deps.origin(),
  accountOf: (headers: Headers) => t.deps.accountOf(headers),
};
const routes = {
  GET: accountRoute(({ accountId }) => listResponse(accountId, deps), wrapped),
  POST: accountRoute(
    ({ accountId }) => requestResponse(accountId, deps, async () => allow),
    wrapped,
  ),
  FILE: accountRoute(
    ({ accountId, params }) => downloadResponse(accountId, String(params.id ?? ''), deps),
    wrapped,
  ),
  DELETE: accountRoute(
    ({ accountId, params }) => deleteResponse(accountId, String(params.id ?? ''), deps),
    wrapped,
  ),
};
const get = (who: typeof t.ada | null) => routes.GET(t.request(who, '/api/exports'));
const post = (who: typeof t.ada | null, headers = {}) =>
  routes.POST(t.request(who, '/api/exports', { method: 'POST', headers }));
const file = (who: typeof t.ada | null, id: string) =>
  routes.FILE(t.request(who, `/api/exports/${id}`), { params: Promise.resolve({ id }) });
const del = (who: typeof t.ada | null, id: string, headers = {}) =>
  routes.DELETE(t.request(who, `/api/exports/${id}`, { method: 'DELETE', headers }), {
    params: Promise.resolve({ id }),
  });

describe(`Exports over HTTP (${leg})`, () => {
  let id = '';
  it('is for someone signed in and from the app', async () => {
    expect((await get(null)).status).toBe(401);
    expect((await post(null)).status).toBe(401);
    expect((await file(null, 'x')).status).toBe(401);
    expect((await del(null, 'x')).status).toBe(401);
    expect((await post(t.ada, { origin: 'https://evil.example' })).status).toBe(403);
    expect((await del(t.ada, 'x', { origin: '' })).status).toBe(403);
  });

  it('takes a request, once at a time, limited for the account, and lists it for them alone', async () => {
    allow = false;
    expect((await post(t.ada)).status).toBe(429);
    allow = true;
    const reply = await post(t.ada);
    expect(reply.status).toBe(201);
    id = (await reply.json()).id;
    const again = await post(t.ada);
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ code: 'BUSY' });
    expect((await (await get(t.ada)).json()).exports).toMatchObject([{ id, status: 'queued' }]);
    expect((await (await get(t.grace)).json()).exports).toEqual([]);
    // Not downloadable before it is built.
    expect((await file(t.ada, id)).status).toBe(404);
  });

  it('downloads as an attachment, whole, to its owner, and to no one else', async () => {
    expect(await workOnExports(deps)).toBe(true);
    const reply = await file(t.ada, id);
    expect(reply.status).toBe(200);
    expect(reply.headers.get('content-type')).toBe('application/zip');
    expect(reply.headers.get('content-disposition')).toMatch(
      /^attachment; filename="waymark-export-\d{4}-\d{2}-\d{2}\.zip"$/,
    );
    expect(reply.headers.get('cache-control')).toBe('private, no-store');
    expect(reply.headers.get('x-content-type-options')).toBe('nosniff');
    const bytes = Buffer.from(await reply.arrayBuffer());
    expect(Number(reply.headers.get('content-length'))).toBe(bytes.length);
    const zip = unzipSync(new Uint8Array(bytes));
    expect(Object.keys(zip)).toEqual([JSON_NAME]);
    expect(Buffer.from(zip[JSON_NAME] as Uint8Array).toString()).toContain('Ada Lovelace');

    expect((await file(t.grace, id)).status).toBe(404);
    for (const bad of ['not an id!', '../x', 'x'.repeat(200)])
      expect((await file(t.ada, bad)).status).toBe(404);
  });

  it('is not downloadable once the day is up', async () => {
    NOW += READY_FOR_MS + 1;
    expect((await file(t.ada, id)).status).toBe(404);
    NOW -= READY_FOR_MS + 1;
  });

  it('is deleted by its owner and not by anyone else', async () => {
    expect((await del(t.grace, id)).status).toBe(404);
    expect((await file(t.ada, id)).status).toBe(200);
    expect((await del(t.ada, id)).status).toBe(200);
    expect((await del(t.ada, id)).status).toBe(404);
    expect((await file(t.ada, id)).status).toBe(404);
  });
});
