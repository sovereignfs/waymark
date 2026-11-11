import { describe, expect, it } from 'vitest';
import type { Limiter } from '../limits/rate';
import {
  MAX_BODY_BYTES,
  NOTICE_RATE,
  handleAccountDeleted,
  handleBackChannelLogout,
  type NoticeDeps,
  type NoticeVerifiers,
  type PeopleActions,
} from './http';

/** An error as the SDK's are: a class of its own, known by its name. */
const named = (name: string, message = 'details that must not be logged') =>
  Object.assign(new Error(message), { name });

function world(
  change: {
    logout?: NoticeVerifiers['logout'];
    accountDeleted?: NoticeVerifiers['accountDeleted'];
    people?: Partial<PeopleActions>;
    limiter?: Limiter;
  } = {},
) {
  const calls: string[] = [];
  const logged: string[] = [];
  const deps: NoticeDeps = {
    verify: {
      logout: change.logout ?? (async () => ({ sub: 'sub-1', sid: 'sid-1' })),
      accountDeleted: change.accountDeleted ?? (async () => ({ sub: 'sub-1' })),
    },
    people: {
      endSessions: change.people?.endSessions ?? (async (sub) => (calls.push(`end ${sub}`), 2)),
      deletePerson:
        change.people?.deletePerson ?? (async (sub) => void calls.push(`delete ${sub}`)),
    },
    ...(change.limiter ? { limiter: change.limiter } : {}),
    log: (line) => logged.push(line),
  };
  return { deps, calls, logged };
}
/** What Sovereign's server posts: a form with one field. */
const notice = (field: string, token = 'a.signed.token') =>
  new Request('https://waymark.example.com/api/sovereign/notice', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ [field]: token }).toString(),
  });
/** A request can be read once, so each use makes its own. */
const request = () => notice('logout_token');
const deletion = () => notice('account_deleted_token');
const body = async (response: Response) =>
  response.headers.get('content-type') ? await response.json() : null;

describe('a back-channel logout', () => {
  it('ends the sessions of the person it names, and answers 200 with nothing cached', async () => {
    const { deps, calls } = world();
    const response = await handleBackChannelLogout(request(), deps);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(calls).toEqual(['end sub-1']);
  });

  it("accepts a token that names only a core session, and ends nothing, since it does not know core's sessions", async () => {
    const { deps, calls } = world({ logout: async () => ({ sid: 'sid-1' }) });
    expect((await handleBackChannelLogout(request(), deps)).status).toBe(200);
    expect(calls).toEqual([]);
  });

  it('refuses a notice the verifier refuses with 400 and invalid_request, and acts on nothing', async () => {
    const { deps, calls, logged } = world({
      logout: async () => Promise.reject(named('InvalidNoticeError')),
    });
    const response = await handleBackChannelLogout(request(), deps);
    expect(response.status).toBe(400);
    expect(await body(response)).toEqual({ error: 'invalid_request' });
    expect(calls).toEqual([]);
    // A forged notice is not an event worth a line.
    expect(logged).toEqual([]);
  });

  it('is 503 when core could not be asked, and says the kind of failure and nothing of what it said', async () => {
    const { deps, calls, logged } = world({
      logout: async () =>
        Promise.reject(named('CoreUnavailableError', 'connect ECONNREFUSED 10.0.0.5:443')),
    });
    const response = await handleBackChannelLogout(request(), deps);
    expect(response.status).toBe(503);
    expect(await body(response)).toEqual({ error: 'temporarily_unavailable' });
    expect(calls).toEqual([]);
    expect(logged).toEqual([
      '[waymark] sovereign: a logout notice could not be checked (CoreUnavailableError)',
    ]);
    expect(logged.join()).not.toContain('10.0.0.5');
  });

  it('is 500 for any other failure of the check, and for a failure to end the sessions, without the message', async () => {
    for (const logout of [
      async () => Promise.reject(named('ConfigurationError', 'WAYMARK_CORE_URL is secret-ish')),
      async () => Promise.reject(new TypeError('boom')),
    ]) {
      const { deps, logged } = world({ logout });
      expect((await handleBackChannelLogout(request(), deps)).status).toBe(500);
      expect(logged.join()).not.toMatch(/secret-ish|boom/);
    }
    const { deps, logged } = world({
      people: {
        endSessions: async () =>
          Promise.reject(new Error('password=hunter2 in the connection string')),
      },
    });
    const response = await handleBackChannelLogout(request(), deps);
    expect(response.status).toBe(500);
    expect(await body(response)).toEqual({ error: 'server_error' });
    expect(logged).toEqual(['[waymark] sovereign: a logout notice could not be acted on (Error)']);
  });
});

describe('what is handed to the verifier', () => {
  it('is the token of the form, and nothing else', async () => {
    const seen: string[] = [];
    const { deps } = world({
      logout: async (token) => (seen.push(token), { sub: 's' }),
      accountDeleted: async (token) => (seen.push(token), { sub: 's' }),
    });
    await handleBackChannelLogout(notice('logout_token', 'aaa.bbb.ccc'), deps);
    await handleAccountDeleted(notice('account_deleted_token', 'ddd.eee.fff'), deps);
    expect(seen).toEqual(['aaa.bbb.ccc', 'ddd.eee.fff']);
  });

  const rejected: [string, () => Request][] = [
    [
      'no token',
      () =>
        new Request('https://f.test/n', {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: '',
        }),
    ],
    ['an empty token', () => notice('logout_token', '')],
    ["the other notice's field", () => notice('account_deleted_token')],
    [
      'a body that is not a form',
      () =>
        new Request('https://f.test/n', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ logout_token: 'a.b.c' }),
        }),
    ],
    [
      'no content type',
      () => new Request('https://f.test/n', { method: 'POST', body: 'logout_token=a.b.c' }),
    ],
    ['a body bigger than a notice', () => notice('logout_token', 'x'.repeat(MAX_BODY_BYTES))],
    [
      'a declared size bigger than a notice',
      () =>
        new Request('https://f.test/n', {
          method: 'POST',
          headers: {
            'content-type': 'application/x-www-form-urlencoded',
            'content-length': String(MAX_BODY_BYTES + 1),
          },
          body: 'logout_token=a.b.c',
        }),
    ],
  ];
  it.each(rejected)(
    'is not asked for %s: the answer is 400, and Sovereign is not contacted',
    async (_name, make) => {
      const asked: string[] = [];
      const { deps, calls } = world({ logout: async (t) => (asked.push(t), { sub: 's' }) });
      const response = await handleBackChannelLogout(make(), deps);
      expect(response.status).toBe(400);
      expect(await body(response)).toEqual({ error: 'invalid_request' });
      expect(asked).toEqual([]);
      expect(calls).toEqual([]);
    },
  );

  it('is read no further than the limit, even when the sender does not stop', async () => {
    let pulled = 0;
    const chunk = new TextEncoder().encode(`logout_token=${'y'.repeat(4096)}`);
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(chunk);
        if (pulled > 1000) controller.close();
      },
    });
    const { deps } = world();
    const response = await handleBackChannelLogout(
      new Request('https://f.test/n', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body,
        duplex: 'half',
      } as RequestInit),
      deps,
    );
    expect(response.status).toBe(400);
    expect(pulled).toBeLessThan(20);
  });
});

describe('the number of requests', () => {
  const limiterOf = (allowed: number): Limiter & { keys: string[] } => {
    const keys: string[] = [];
    let taken = 0;
    return {
      keys,
      take: async (key, rule) => (
        keys.push(`${key}:${rule.limit}:${rule.windowMs}`),
        ++taken <= allowed ? { ok: true } : { ok: false, retryAfterMs: 2500 }
      ),
    };
  };

  it('is counted against one limit for every caller and both routes, of NOTICE_RATE', async () => {
    const limiter = limiterOf(10);
    const { deps } = world({ limiter });
    await handleBackChannelLogout(request(), deps);
    await handleAccountDeleted(deletion(), deps);
    expect(limiter.keys).toEqual([
      `sovereign-notice:${NOTICE_RATE.limit}:${NOTICE_RATE.windowMs}`,
      `sovereign-notice:${NOTICE_RATE.limit}:${NOTICE_RATE.windowMs}`,
    ]);
  });

  it('is refused with 429 and when to ask again, before the token is read or anything is asked of Sovereign, and acts on nothing', async () => {
    const limiter = limiterOf(0);
    const asked: string[] = [];
    const { deps, calls } = world({
      limiter,
      logout: async (t) => (asked.push(t), { sub: 's' }),
      accountDeleted: async (t) => (asked.push(t), { sub: 's' }),
    });
    for (const response of [
      await handleBackChannelLogout(request(), deps),
      await handleAccountDeleted(deletion(), deps),
    ]) {
      expect(response.status).toBe(429);
      expect(response.headers.get('retry-after')).toBe('3');
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(await body(response)).toEqual({ error: 'rate_limited' });
    }
    expect(asked).toEqual([]);
    expect(calls).toEqual([]);
  });
});

describe('every answer', () => {
  it('is kept out of any cache, whether it succeeds or not', async () => {
    for (const failure of ['InvalidNoticeError', 'CoreUnavailableError', 'SomethingElse']) {
      const { deps } = world({
        logout: async () => Promise.reject(named(failure)),
        accountDeleted: async () => Promise.reject(named(failure)),
      });
      expect(
        (await handleBackChannelLogout(request(), deps)).headers.get('cache-control'),
        failure,
      ).toBe('no-store');
      expect(
        (await handleAccountDeleted(deletion(), deps)).headers.get('cache-control'),
        failure,
      ).toBe('no-store');
    }
  });
});

describe('an account-deleted notice', () => {
  it('deletes the person it names, and answers 200 only after it has been done', async () => {
    let finish!: () => void;
    const done = new Promise<void>((resolve) => (finish = resolve));
    const { deps, calls } = world({
      people: {
        deletePerson: async (sub) => (
          calls.push(`start ${sub}`),
          await done,
          void calls.push(`finish ${sub}`)
        ),
      },
    });
    let answered = false;
    const pending = handleAccountDeleted(deletion(), deps).then(
      (response) => ((answered = true), response),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls).toEqual(['start sub-1']);
    expect(answered).toBe(false);
    finish();
    const response = await pending;
    expect(response.status).toBe(200);
    expect(calls).toEqual(['start sub-1', 'finish sub-1']);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('answers 500 when deleting fails, so that Sovereign sends it again, without saying why', async () => {
    const { deps, logged } = world({
      people: {
        deletePerson: async () =>
          Promise.reject(new Error('deadlock on connection 12 for user alice@example.com')),
      },
    });
    const response = await handleAccountDeleted(deletion(), deps);
    expect(response.status).toBe(500);
    expect(await body(response)).toEqual({ error: 'server_error' });
    expect(logged).toEqual([
      '[waymark] sovereign: an account-deleted notice could not be acted on (Error)',
    ]);
    expect(logged.join()).not.toContain('alice');
  });

  it('refuses a notice the verifier refuses with 400, and deletes nothing', async () => {
    const { deps, calls } = world({
      accountDeleted: async () => Promise.reject(named('InvalidNoticeError')),
    });
    const response = await handleAccountDeleted(deletion(), deps);
    expect(response.status).toBe(400);
    expect(await body(response)).toEqual({ error: 'invalid_request' });
    expect(calls).toEqual([]);
  });

  it('is 503 when core could not be asked, and deletes nothing', async () => {
    const { deps, calls } = world({
      accountDeleted: async () => Promise.reject(named('CoreUnavailableError')),
    });
    expect((await handleAccountDeleted(deletion(), deps)).status).toBe(503);
    expect(calls).toEqual([]);
  });

  it('does not take a logout notice for a deletion: it asks the verifier for a deletion', async () => {
    const asked: string[] = [];
    const { deps } = world({
      logout: async () => (asked.push('logout'), { sub: 'x' }),
      accountDeleted: async () => (asked.push('accountDeleted'), { sub: 'sub-1' }),
    });
    await handleAccountDeleted(deletion(), deps);
    await handleBackChannelLogout(request(), deps);
    expect(asked).toEqual(['accountDeleted', 'logout']);
  });
});
