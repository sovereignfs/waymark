import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { testTarget } from '../db/test-support';
import { type AccessDeps, accountRoute, authorize } from './route';
import { type TwoAccounts, twoAccounts } from './two-accounts';

/**
 * The wrapper every route for an account goes through (DESIGN.md §7), tried every way it can say no, and with two real accounts so that
 * "called as the wrong one" is a thing the tests do and not a thing they imagine.
 */
const { leg } = testTarget();

describe(`accountRoute (${leg})`, () => {
  let t: TwoAccounts;
  beforeAll(async () => {
    t = await twoAccounts();
  });
  afterAll(async () => t.close());

  const seen = vi.fn();
  const route = () =>
    accountRoute(async ({ accountId, params, request }) => {
      seen({ accountId, params, method: request.method });
      return Response.json({ accountId });
    }, t.deps);

  it('hands the handler the account the cookies belong to, and nothing the request says about who it is', async () => {
    seen.mockClear();
    const handler = route();
    for (const [person, other] of [
      [t.ada, t.grace],
      [t.grace, t.ada],
    ] as const) {
      const reply = await handler(
        t.request(person, '/api/x?accountId=' + other.id, {
          method: 'POST',
          body: { accountId: other.id, ownerId: other.id },
          headers: { 'x-account-id': other.id },
        }),
      );
      expect(reply.status).toBe(200);
      expect(await reply.json()).toEqual({ accountId: person.id });
    }
    expect(t.ada.id).not.toBe(t.grace.id);
  });

  it('gives the handler the route’s dynamic segments, already awaited', async () => {
    seen.mockClear();
    await route()(t.request(t.ada, '/api/lists/abc'), { params: Promise.resolve({ id: 'abc' }) });
    expect(seen).toHaveBeenCalledWith(expect.objectContaining({ params: { id: 'abc' } }));
  });

  it('answers 401 with no session, and never runs the handler', async () => {
    seen.mockClear();
    const reply = await route()(t.request(null, '/api/x', { method: 'POST', body: {} }));
    expect(reply.status).toBe(401);
    expect((await reply.json()).code).toBe('UNAUTHORIZED');
    expect(seen).not.toHaveBeenCalled();
  });

  it('answers 401 with a cookie that is not a session, and after sign-out', async () => {
    seen.mockClear();
    const handler = route();
    const forged = t.request(null, '/api/x', {
      headers: { cookie: 'waymark.session_token=forged.value' },
    });
    expect((await handler(forged)).status).toBe(401);

    const leaving = t.auth.client().from('198.51.100.9');
    await leaving.post('/api/auth/sign-in/email', {
      email: t.ada.email,
      password: 'a password long enough to be one',
    });
    const before = { id: t.ada.id, email: t.ada.email, client: leaving };
    expect((await handler(t.request(before, '/api/x'))).status).toBe(200);
    await leaving.post('/api/auth/sign-out', {});
    const ended = t.request(null, '/api/x', { headers: { cookie: before.client.cookieHeader() } });
    expect((await handler(ended)).status).toBe(401);
    expect(seen).toHaveBeenCalledTimes(1);
  });

  describe('a request that changes something', () => {
    it.each(['POST', 'PUT', 'PATCH', 'DELETE'])(
      '%s is refused with 403 from another site, and with no Origin, and the handler does not run',
      async (method) => {
        seen.mockClear();
        const handler = route();
        for (const origin of [
          'https://evil.example.com',
          '',
          'null',
          t.auth.settings.url + '.evil.example.com',
        ]) {
          const reply = await handler(
            t.request(t.ada, '/api/x', { method, body: {}, headers: { origin } }),
          );
          expect(reply.status, `${method} from "${origin}"`).toBe(403);
          expect((await reply.json()).code).toBe('FORBIDDEN_ORIGIN');
        }
        expect(seen).not.toHaveBeenCalled();
        expect((await handler(t.request(t.ada, '/api/x', { method, body: {} }))).status).toBe(200);
      },
    );

    it('is refused for a method nobody listed, as a write is', async () => {
      const reply = await route()(
        t.request(t.ada, '/api/x', {
          method: 'PURGE',
          headers: { origin: 'https://evil.example.com' },
        }),
      );
      expect(reply.status).toBe(403);
    });

    it('asks for a session before it asks for an Origin', async () => {
      const reply = await route()(
        t.request(null, '/api/x', {
          method: 'POST',
          body: {},
          headers: { origin: 'https://evil.example.com' },
        }),
      );
      expect(reply.status).toBe(401);
    });
  });

  it('lets a read through whatever Origin it has, since a read changes nothing', async () => {
    const handler = route();
    expect(
      (
        await handler(
          t.request(t.ada, '/api/x', { headers: { origin: 'https://evil.example.com' } }),
        )
      ).status,
    ).toBe(200);
    expect((await handler(t.request(t.ada, '/api/x', { headers: { origin: '' } }))).status).toBe(
      200,
    );
  });

  it('answers 404, and says nothing, when sign-in is off', async () => {
    seen.mockClear();
    const off: AccessDeps = { ...t.deps, origin: () => undefined };
    const reply = await accountRoute(
      async () => Response.json({}),
      off,
    )(t.request(t.ada, '/api/x'));
    expect(reply.status).toBe(404);
    expect(await reply.text()).toBe('');
    expect(await authorize(t.request(t.ada, '/api/x'), off)).toBeInstanceOf(Response);
  });
});
