import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { accountRoute } from '../access/route';
import { type TwoAccounts, twoAccounts } from '../access/two-accounts';
import { type KeyRing, ringOf } from '../crypto/keys';
import { Sealer } from '../crypto/sealed';
import type { Database } from '../db/client';
import { openAppBesideAuth, testTarget } from '../db/test-support';
import { hasImport } from './files';
import { cancelResponse, listResponse, uploadResponse } from './http';
import type { ImportDeps, ImportReader } from './job';

/** The imports' routes, called as the person and as someone else, over real sessions (DESIGN.md §5.2, §16). */
const { leg } = testTarget();
const made = ringOf(randomBytes(32));
if (!made) throw new Error('no ring');
const ring: KeyRing = made;
const sealer = new Sealer(ring);
const reader: ImportReader = {
  source: 'swarm',
  open: async () => ({
    checkins: async () => ({ items: [], cursor: 0, done: true }),
    close: async () => undefined,
  }),
};

let t: TwoAccounts;
let database: Database;
let close: () => Promise<void>;
let directory: string;
let deps: ImportDeps;
let allow = true;
beforeAll(async () => {
  t = await twoAccounts();
  ({ database, close } = await openAppBesideAuth());
  directory = mkdtempSync(path.join(tmpdir(), 'waymark-import-http-'));
  deps = {
    database,
    sealer,
    ring,
    dir: path.join(directory, 'imports'),
    workDir: path.join(directory, 'work'),
    now: () => 1_800_000_000_000,
    readers: { swarm: reader },
  };
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
    ({ request, accountId }) => uploadResponse(request, accountId, deps, async () => allow),
    wrapped,
  ),
  DELETE: accountRoute(
    ({ accountId, params }) => cancelResponse(accountId, String(params.id ?? ''), deps),
    wrapped,
  ),
};
const get = (who: typeof t.ada | null) => routes.GET(t.request(who, '/api/imports'));
const post = (who: typeof t.ada | null, body: string, query = '', headers = {}) =>
  routes.POST(t.request(who, `/api/imports${query}`, { method: 'POST', body, headers }));
const del = (who: typeof t.ada | null, id: string, headers = {}) =>
  routes.DELETE(t.request(who, `/api/imports/${id}`, { method: 'DELETE', headers }), {
    params: Promise.resolve({ id }),
  });

describe(`Imports over HTTP (${leg})`, () => {
  it('is for someone signed in and from the app', async () => {
    expect((await get(null)).status).toBe(401);
    expect((await post(null, 'x')).status).toBe(401);
    expect((await post(t.ada, 'x', '', { origin: 'https://evil.example' })).status).toBe(403);
    expect((await post(t.ada, 'x', '', { origin: '' })).status).toBe(403);
    expect((await del(null, 'x')).status).toBe(401);
    expect((await del(t.ada, 'x', { origin: 'https://evil.example' })).status).toBe(403);
  });

  it('takes a file as it arrives, queues it for the person, and lists it for them alone', async () => {
    const reply = await post(t.ada, JSON.stringify([{ some: 'export' }]));
    expect(reply.status).toBe(201);
    const { id } = await reply.json();
    expect(await hasImport(deps.dir, id)).toBe(true);
    const mine = await (await get(t.ada)).json();
    expect(mine.available).toEqual(['swarm']);
    expect(mine.imports).toMatchObject([
      { id, status: 'queued', source: 'swarm', checkinsDone: 0 },
    ]);
    expect(JSON.stringify(mine)).not.toContain('some');
    expect((await (await get(t.grace)).json()).imports).toEqual([]);
  });

  it('refuses a second while one is waiting, with a sentence that says what to do; the other person is not held up', async () => {
    const again = await post(t.ada, 'second');
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({
      code: 'BUSY',
      message: expect.stringContaining('cancel'),
    });
    expect((await post(t.grace, 'hers')).status).toBe(201);
  });

  it('refuses a service that is not one, a file that is too big or empty, and an upload past the limit, storing nothing', async () => {
    const before = (await (await get(t.grace)).json()).imports.length;
    expect((await post(t.grace, 'x', '?source=evernote')).status).toBe(400);
    allow = false;
    expect((await post(t.grace, 'x')).status).toBe(429);
    allow = true;
    const big = await post(t.grace, 'x', '', { 'content-length': String(201 * 1024 * 1024) });
    expect(big.status).toBe(413);
    expect((await (await get(t.grace)).json()).imports).toHaveLength(before);
  });

  it('is cancelled by the person alone, once, and its file goes', async () => {
    const hers = (await (await get(t.grace)).json()).imports[0].id as string;
    expect((await del(t.ada, hers)).status).toBe(404);
    expect(await hasImport(deps.dir, hers)).toBe(true);
    expect((await del(t.grace, hers)).status).toBe(200);
    expect((await del(t.grace, hers)).status).toBe(404);
    expect(await hasImport(deps.dir, hers)).toBe(false);
    expect((await (await get(t.grace)).json()).imports[0].status).toBe('cancelled');
    for (const bad of ['not an id!', '../x', 'x'.repeat(200)])
      expect((await del(t.ada, bad)).status).toBe(404);
  });

  it('says it is not available when this build has no reader for the service, and stores nothing', async () => {
    const without: ImportDeps = { ...deps, readers: {} };
    const route = accountRoute(
      ({ request, accountId }) => uploadResponse(request, accountId, without, async () => true),
      wrapped,
    );
    const reply = await route(t.request(t.grace, '/api/imports', { method: 'POST', body: 'x' }));
    expect(reply.status).toBe(404);
    expect(await reply.json()).toMatchObject({ code: 'UNAVAILABLE' });
    expect(
      (await (await get(t.grace)).json()).imports.filter(
        (each: { status: string }) => each.status === 'queued',
      ),
    ).toEqual([]);
  });
});
