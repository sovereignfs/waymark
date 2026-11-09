import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { accountRoute } from '../access/route';
import { type TwoAccounts, twoAccounts } from '../access/two-accounts';
import { ringOf } from '../crypto/keys';
import { Sealer } from '../crypto/sealed';
import type { Database } from '../db/client';
import { openAppBesideAuth, testTarget } from '../db/test-support';
import { createProfile, getProfile } from '../profile/profile';
import { type SettingsDeps, changeSettings, readSettings } from './api';

/** Settings' two routes, called as the person and as someone else, over real sessions (DESIGN.md §5.2, §21). */
const { leg } = testTarget();
const ring = ringOf(randomBytes(32));
if (!ring) throw new Error('no ring');
const sealer = new Sealer(ring);

let t: TwoAccounts;
let database: Database;
let close: () => Promise<void>;
let deps: SettingsDeps;
beforeAll(async () => {
  t = await twoAccounts();
  ({ database, close } = await openAppBesideAuth());
  deps = { database, sealer, now: () => 1_800_000_000_000 };
  for (const [who, name] of [
    [t.ada, 'Ada Lovelace'],
    [t.grace, 'Grace Hopper'],
  ] as const)
    await createProfile(database, sealer, { accountId: who.id, name, email: who.email }, 1);
});
afterAll(async () => {
  await t.close();
  await close();
});

const routes = {
  GET: accountRoute(({ accountId }) => readSettings(accountId, deps), t_deps()),
  PATCH: accountRoute(
    ({ request, accountId }) => changeSettings(request, accountId, deps),
    t_deps(),
  ),
};
/** `t` is made in `beforeAll`, so the wrapper asks for its deps when it is called. */
function t_deps() {
  return {
    origin: () => t.deps.origin(),
    accountOf: (headers: Headers) => t.deps.accountOf(headers),
  };
}
const get = (who: typeof t.ada | null) => routes.GET(t.request(who, '/api/settings'));
const patch = (who: typeof t.ada | null, body: unknown, headers = {}) =>
  routes.PATCH(t.request(who, '/api/settings', { method: 'PATCH', body, headers }));

describe(`Settings over HTTP (${leg})`, () => {
  it('is for someone signed in and from the app', async () => {
    expect((await get(null)).status).toBe(401);
    expect((await patch(null, { name: 'X' })).status).toBe(401);
    expect((await patch(t.ada, { name: 'X' }, { origin: 'https://evil.example' })).status).toBe(
      403,
    );
    expect((await patch(t.ada, { name: 'X' }, { origin: '' })).status).toBe(403);
    expect((await getProfile(database, sealer, t.ada.id))?.name).toBe('Ada Lovelace');
  });

  it('reads the person’s own profile, and only that: each is given theirs', async () => {
    expect(await (await get(t.ada)).json()).toEqual({
      name: 'Ada Lovelace',
      email: t.ada.email,
      units: 'km',
      weekStart: 1,
      shareDefault: 'ask',
    });
    expect(await (await get(t.grace)).json()).toMatchObject({
      name: 'Grace Hopper',
      email: t.grace.email,
    });
  });

  it('saves a change and reads it back, for the person who made it and no one else', async () => {
    const saved = await patch(t.ada, {
      name: '  Ada King ',
      units: 'mi',
      weekStart: 0,
      shareDefault: 'on',
    });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({
      name: 'Ada King',
      units: 'mi',
      weekStart: 0,
      shareDefault: 'on',
    });
    expect(await (await get(t.ada)).json()).toMatchObject({
      name: 'Ada King',
      units: 'mi',
      weekStart: 0,
    });
    // Grace's is as it was: there is no way in this route to name another account.
    expect(await (await get(t.grace)).json()).toMatchObject({
      name: 'Grace Hopper',
      units: 'km',
      weekStart: 1,
    });
    // Asking as Grace for a change changes Grace's.
    await patch(t.grace, { name: 'Grace Murray Hopper' });
    expect((await getProfile(database, sealer, t.grace.id))?.name).toBe('Grace Murray Hopper');
    expect((await getProfile(database, sealer, t.ada.id))?.name).toBe('Ada King');
  });

  it('refuses what is not a profile change, naming nothing of what was sent, and changes nothing', async () => {
    const before = await (await get(t.ada)).json();
    for (const body of [
      { email: 'new@example.com' },
      { accountId: t.grace.id, name: 'Mallory' },
      { name: '' },
      { name: 'a\nb' },
      { name: 'x'.repeat(101) },
      { units: 'furlongs' },
      { weekStart: 9 },
      { weekStart: 'monday' },
      { shareDefault: 'maybe' },
      ['name'],
      'text',
      null,
    ]) {
      const reply = await patch(t.ada, body);
      expect(reply.status, JSON.stringify(body)).toBe(400);
      expect(await reply.json()).toEqual({ code: 'BAD_REQUEST' });
    }
    expect(await (await get(t.ada)).json()).toEqual(before);
    expect((await getProfile(database, sealer, t.grace.id))?.name).toBe('Grace Murray Hopper');
  });

  it('cuts off a body that is too large, and refuses one that is not JSON', async () => {
    expect((await patch(t.ada, { name: 'x'.repeat(5000) })).status).toBe(413);
    const bad = await routes.PATCH(
      new Request(t.request(t.ada, '/x').url.replace('/x', '/api/settings'), {
        method: 'PATCH',
        headers: {
          origin: new URL(t.request(t.ada, '/x').url).origin,
          cookie: t.ada.client.cookieHeader(),
        },
        body: '{no',
      }),
    );
    expect(bad.status).toBe(400);
  });
});
