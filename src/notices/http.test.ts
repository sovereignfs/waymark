import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { accountRoute } from '../access/route';
import { type TwoAccounts, twoAccounts } from '../access/two-accounts';
import { ringOf } from '../crypto/keys';
import { Sealer } from '../crypto/sealed';
import type { Database } from '../db/client';
import { openAppBesideAuth, testTarget } from '../db/test-support';
import { changeNotices, readNotices } from './http';
import { type NoticeDeps, raiseNotice, unreadCount } from './notices';

/** The notices' two routes, called as the person and as someone else, over real sessions (DESIGN.md §5.2, §17.1). */
const { leg } = testTarget();
const ring = ringOf(randomBytes(32));
if (!ring) throw new Error('no ring');
const sealer = new Sealer(ring);

let t: TwoAccounts;
let database: Database;
let close: () => Promise<void>;
let deps: NoticeDeps;
beforeAll(async () => {
  t = await twoAccounts();
  ({ database, close } = await openAppBesideAuth());
  deps = { database, sealer, now: () => 1_800_000_000_000 };
});
afterAll(async () => {
  await t.close();
  await close();
});

const wrapped = {
  origin: () => t.deps.origin(),
  accountOf: (headers: Headers) => t.deps.accountOf(headers),
};
const routes = {
  GET: accountRoute(({ accountId }) => readNotices(accountId, deps), wrapped),
  POST: accountRoute(({ request, accountId }) => changeNotices(request, accountId, deps), wrapped),
};
const get = (who: typeof t.ada | null) => routes.GET(t.request(who, '/api/notices'));
const post = (who: typeof t.ada | null, body: unknown, headers = {}) =>
  routes.POST(t.request(who, '/api/notices', { method: 'POST', body, headers }));
const raise = (to: string, title: string) =>
  raiseNotice(database, sealer, 1_800_000_000_000, {
    to,
    by: 'someone-else',
    kind: 'import_finished',
    content: { title, href: '/checkins' },
  });

describe(`Notices over HTTP (${leg})`, () => {
  it('is for someone signed in, and from the app for a change', async () => {
    expect((await get(null)).status).toBe(401);
    expect((await post(null, { all: true })).status).toBe(401);
    expect((await post(t.ada, { all: true }, { origin: 'https://evil.example' })).status).toBe(403);
    expect((await post(t.ada, { all: true }, { origin: '' })).status).toBe(403);
  });

  it('lists the person’s own and counts the unread; marking one read survives asking again', async () => {
    const mine = await raise(t.ada.id, 'Ada’s import finished');
    await raise(t.grace.id, 'Grace’s import finished');
    const reply = await get(t.ada);
    expect(reply.headers.get('cache-control')).toBe('no-store');
    const body = await reply.json();
    expect(body.unread).toBe(1);
    expect(body.notices).toEqual([
      {
        id: mine,
        kind: 'import_finished',
        at: 1_800_000_000_000,
        read: false,
        title: 'Ada’s import finished',
        href: '/checkins',
      },
    ]);
    expect(JSON.stringify(body)).not.toContain('Grace');
    expect(await (await post(t.ada, { ids: [mine] })).json()).toEqual({ marked: 1 });
    const again = await (await get(t.ada)).json();
    expect(again.unread).toBe(0);
    expect(again.notices[0].read).toBe(true);
  });

  it('does not let a second person mark the first’s notices read', async () => {
    const mine = await raise(t.ada.id, 'Ada again');
    expect(await (await post(t.grace, { ids: [mine] })).json()).toEqual({ marked: 0 });
    expect(await (await post(t.grace, { all: true })).json()).toMatchObject({
      marked: expect.any(Number),
    });
    expect(await unreadCount(deps, t.ada.id)).toBeGreaterThanOrEqual(1);
    expect(await (await post(t.ada, { all: true })).json()).toMatchObject({ marked: 1 });
  });

  it('refuses what is not a change, naming nothing of what was sent', async () => {
    for (const body of [
      {},
      { all: false },
      { ids: 'x' },
      { ids: ['not an id!'] },
      { ids: [1] },
      { ids: Array.from({ length: 101 }, (_, i) => `id${i}`) },
      { all: true, ids: [] },
      { everything: true },
      ['x'],
      'text',
      null,
    ]) {
      const reply = await post(t.ada, body);
      expect(reply.status, JSON.stringify(body)).toBe(400);
      expect(await reply.json()).toEqual({ code: 'BAD_REQUEST' });
    }
    expect((await post(t.ada, { ids: ['x'.repeat(9000)] })).status).toBe(413);
  });
});
