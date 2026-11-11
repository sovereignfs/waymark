import { createFakeCore } from '@sovereignfs/sdk/testing';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '../db/client';
import { dbAll } from '../db/exec';
import { runMigrations } from '../db/migrate';
import * as postgresSchema from '../db/schema/postgres';
import * as sqliteSchema from '../db/schema/sqlite';
import { freshDatabase } from '../db/test-support';
import { RateLimiter } from '../limits/rate';
import { startFakeSovereign } from '../auth/testing/fake-sovereign';
import { handleAccountDeleted, handleBackChannelLogout, type NoticeDeps } from './http';
import { SEEN_GRACE_MS, forgetSeen, sdkVerifiers, seenBy } from './verifiers';

/**
 * The verifiers are `@sovereignfs/sdk`'s, which hold the rules; what is tested here is that Waymark uses them as they are meant to be used,
 * against the SDK's own fake core (which signs notices with the key it publishes, and can sign them wrong in each way): the person each
 * notice names, the answer for each way it can be wrong, a replay counted in the database, and Sovereign being down.
 */
let database: Database;

beforeAll(async () => {
  ({ database } = await freshDatabase());
  await runMigrations(database);
});
afterAll(() => database.close());

const seenTable = () =>
  database.dialect === 'postgres' ? postgresSchema.noticeSeen : sqliteSchema.noticeSeen;

function world() {
  const core = createFakeCore();
  const limiter = new RateLimiter(database);
  const verify = sdkVerifiers({
    coreUrl: core.url,
    clientId: core.credentials.clientId,
    seen: seenBy(database),
    fetch: core.fetch,
  });
  const calls: string[] = [];
  const deps: NoticeDeps = {
    verify,
    people: {
      endSessions: async (sub) => (calls.push(`end ${sub}`), 1),
      deletePerson: async (sub) => void calls.push(`delete ${sub}`),
    },
    limiter,
    log: () => undefined,
  };
  return { core, deps, calls, limiter };
}
const form = (field: string, token: string) =>
  new Request('https://waymark.example.com/api/sovereign/notice', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ [field]: token }).toString(),
  });

describe("the SDK's verifiers, as Waymark uses them", () => {
  it('name the person a logout token is for, with or without the core session, and the person a deletion is for', async () => {
    const { core, deps } = world();
    expect(await deps.verify.logout(await core.logoutToken({ sub: 'u1', sid: 's1' }))).toEqual({
      sub: 'u1',
      sid: 's1',
    });
    expect(await deps.verify.logout(await core.logoutToken({ sub: 'u2' }))).toEqual({ sub: 'u2' });
    expect(await deps.verify.accountDeleted(await core.accountDeletedToken({ sub: 'u3' }))).toEqual(
      { sub: 'u3' },
    );
  });

  it.each([
    'signature',
    'issuer',
    'audience',
    'expired',
    'future',
    'event',
    'nonce',
    'type',
    'no-subject',
    'no-jti',
  ] as const)(
    'refuse a token that is wrong in this way: %s, with an error the handler answers 400',
    async (way) => {
      const { core, deps, calls } = world();
      const logout = await handleBackChannelLogout(
        form('logout_token', await core.logoutToken({ sub: 'u1' }, { wrong: way })),
        deps,
      );
      const deleted = await handleAccountDeleted(
        form(
          'account_deleted_token',
          await core.accountDeletedToken({ sub: 'u1' }, { wrong: way }),
        ),
        deps,
      );
      expect([logout.status, deleted.status], way).toEqual([400, 400]);
      expect(calls).toEqual([]);
    },
  );

  it('do not take one notice for the other', async () => {
    const { core, deps, calls } = world();
    expect(
      (
        await handleBackChannelLogout(
          form('logout_token', await core.accountDeletedToken({ sub: 'u1' })),
          deps,
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await handleAccountDeleted(
          form('account_deleted_token', await core.logoutToken({ sub: 'u1' })),
          deps,
        )
      ).status,
    ).toBe(400);
    expect(calls).toEqual([]);
  });
});

describe("the routes' handlers with the SDK's verifiers", () => {
  it("end a person's sessions on a good logout notice, and delete a person on a good deletion", async () => {
    const { core, deps, calls } = world();
    expect(
      (
        await handleBackChannelLogout(
          form('logout_token', await core.logoutToken({ sub: 'u1', sid: 's1' })),
          deps,
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await handleAccountDeleted(
          form('account_deleted_token', await core.accountDeletedToken({ sub: 'u2' })),
          deps,
        )
      ).status,
    ).toBe(200);
    expect(calls).toEqual(['end u1', 'delete u2']);
  });

  it("refuse a notice the second time, and take a new one for the same person, as Sovereign's retry is", async () => {
    const { core, deps, calls } = world();
    const token = await core.accountDeletedToken({ sub: 'u1' });
    expect((await handleAccountDeleted(form('account_deleted_token', token), deps)).status).toBe(
      200,
    );
    expect((await handleAccountDeleted(form('account_deleted_token', token), deps)).status).toBe(
      400,
    );
    expect(
      (
        await handleAccountDeleted(
          form('account_deleted_token', await core.accountDeletedToken({ sub: 'u1' })),
          deps,
        )
      ).status,
    ).toBe(200);
    expect(calls).toEqual(['delete u1', 'delete u1']);
  });

  it('answer 503 when Sovereign cannot be asked, and remember nothing, so that the same notice is taken when it can', async () => {
    const { core, deps, calls } = world();
    const token = await core.accountDeletedToken({ sub: 'u1' });
    core.fail({ kind: 'down' });
    expect((await handleAccountDeleted(form('account_deleted_token', token), deps)).status).toBe(
      503,
    );
    expect(calls).toEqual([]);
    core.heal();
    expect((await handleAccountDeleted(form('account_deleted_token', token), deps)).status).toBe(
      200,
    );
    expect(calls).toEqual(['delete u1']);
  });

  it('answer 500 for a deletion that failed, and then 200 for the retry, which has a new token', async () => {
    const { core, deps } = world();
    let fail = true;
    deps.people.deletePerson = async () => {
      if (fail) throw new Error('the database went away');
    };
    expect(
      (
        await handleAccountDeleted(
          form('account_deleted_token', await core.accountDeletedToken({ sub: 'u1' })),
          deps,
        )
      ).status,
    ).toBe(500);
    fail = false;
    expect(
      (
        await handleAccountDeleted(
          form('account_deleted_token', await core.accountDeletedToken({ sub: 'u1' })),
          deps,
        )
      ).status,
    ).toBe(200);
  });
});

describe('seenBy', () => {
  it('lets the first ask through and refuses every later one for the same notice, and none for another', async () => {
    const seen = seenBy(database);
    const jti = `jti-${Math.random()}`;
    expect(await seen(jti, Date.now() + 120_000)).toBe(false);
    expect(await seen(jti, Date.now() + 120_000)).toBe(true);
    expect(await seen(jti, Date.now() + 120_000)).toBe(true);
    expect(await seen(`${jti}-other`, Date.now() + 120_000)).toBe(false);
  });

  it('is kept in the database, so another process sees it, and a restart forgets nothing', async () => {
    const jti = `jti-${Math.random()}`;
    // Two workers asking at once about one notice: one is told no.
    const asked = await Promise.all(
      Array.from({ length: 6 }, () => seenBy(database)(jti, Date.now() + 120_000)),
    );
    expect(asked.filter((already) => !already)).toHaveLength(1);
    // A process that starts afterwards has no memory of its own, and still refuses it.
    expect(await seenBy(database)(jti, Date.now() + 120_000)).toBe(true);
  });

  it('forgets a notice once it could not be replayed, a little after it expires, and not before', async () => {
    const jti = `jti-${Math.random()}`;
    const expiresAt = 5_000_000;
    expect(await seenBy(database)(jti, expiresAt)).toBe(false);
    expect(await forgetSeen(database, expiresAt + SEEN_GRACE_MS)).toBe(0);
    expect(await seenBy(database)(jti, expiresAt)).toBe(true);
    expect(await forgetSeen(database, expiresAt + SEEN_GRACE_MS + 1)).toBeGreaterThanOrEqual(1);
    expect(await seenBy(database)(jti, expiresAt)).toBe(false);
    // Again, with nothing to forget.
    expect(await forgetSeen(database, expiresAt + SEEN_GRACE_MS + 1)).toBeGreaterThanOrEqual(1);
    expect(await forgetSeen(database, expiresAt + SEEN_GRACE_MS + 1)).toBe(0);
  });

  it('records nothing for a notice the SDK refuses before it asks: a forged one fills nothing', async () => {
    const { core, deps } = world();
    const before = (
      await dbAll<{ n: number | string }>(database, sql`SELECT COUNT(*) AS n FROM ${seenTable()}`)
    )[0]?.n;
    for (const wrong of ['signature', 'audience', 'expired', 'type'] as const)
      await handleBackChannelLogout(
        form('logout_token', await core.logoutToken({ sub: 'u1' }, { wrong })),
        deps,
      );
    const after = (
      await dbAll<{ n: number | string }>(database, sql`SELECT COUNT(*) AS n FROM ${seenTable()}`)
    )[0]?.n;
    expect(Number(after)).toBe(Number(before));
  });
});

describe("Waymark's own fake Sovereign, whose issuer has a path as an older Sovereign's did", () => {
  it("signs notices that the SDK's verifiers accept, and refuses the ones it signs wrong", async () => {
    const fake = await startFakeSovereign();
    try {
      const verify = sdkVerifiers({
        coreUrl: fake.issuer,
        clientId: fake.clientId,
        seen: seenBy(database),
      });
      expect(new URL(fake.issuer).pathname).toBe('/api/auth');
      expect(
        await verify.logout(await fake.noticeToken('logout', { sub: 'u1', sid: 's1' })),
      ).toEqual({ sub: 'u1', sid: 's1' });
      expect(
        await verify.accountDeleted(await fake.noticeToken('account-deleted', { sub: 'u2' })),
      ).toEqual({ sub: 'u2' });
      for (const wrong of ['signature', 'audience', 'expired', 'type'] as const) {
        await expect(
          verify.logout(await fake.noticeToken('logout', { sub: 'u1' }, wrong)),
          wrong,
        ).rejects.toMatchObject({ name: 'InvalidNoticeError' });
      }
    } finally {
      await fake.close();
    }
  });
});
