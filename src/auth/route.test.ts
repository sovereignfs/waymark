import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Who may call `/api/auth`: anyone who can reach the server, when local sign-in is on, and **nobody when it is off**: not a refusal that says
 * sign-in exists but is disabled, but a 404, as if the route were not there (DESIGN.md §6).
 */
afterEach(() => {
  vi.resetModules();
  vi.doUnmock('@/src/auth/server');
});

async function route(auth: unknown, mail = false) {
  vi.doMock('@/src/auth/server', () => ({ getAuth: async () => auth, mailAvailable: () => mail }));
  return import('../../app/api/auth/[...all]/route');
}

describe('/api/auth', () => {
  it('answers 404 to every method when sign-in is off', async () => {
    const { GET, POST } = await route(null);
    const request = new Request('http://localhost:3000/api/auth/get-session');
    expect((await GET(request)).status).toBe(404);
    expect((await POST(request)).status).toBe(404);
  });

  it('hands the request to better-auth when sign-in is on', async () => {
    const handler = vi.fn(async () => new Response('{"ok":true}', { status: 200 }));
    const { GET } = await route({ handler });
    const reply = await GET(new Request('http://localhost:3000/api/auth/get-session'));
    expect(reply.status).toBe(200);
    expect(handler).toHaveBeenCalledOnce();
  });

  it('answers 404, as a route that is not there, to the reset and verification routes when there is no mail, and hands them on when there is', async () => {
    const handler = vi.fn(async () => new Response('{"ok":true}', { status: 200 }));
    const without = await route({ handler }, false);
    for (const path of [
      'request-password-reset',
      'reset-password',
      'reset-password/abc',
      'send-verification-email',
      'verify-email',
    ]) {
      const request = new Request(`http://localhost:3000/api/auth/${path}`);
      expect((await without.GET(request)).status, path).toBe(404);
      expect((await without.POST(request)).status, path).toBe(404);
    }
    expect(handler).not.toHaveBeenCalled();
    // The rest of sign-in is there either way.
    expect(
      (await without.GET(new Request('http://localhost:3000/api/auth/get-session'))).status,
    ).toBe(200);
    vi.resetModules();
    const withMail = await route({ handler }, true);
    expect(
      (await withMail.POST(new Request('http://localhost:3000/api/auth/request-password-reset')))
        .status,
    ).toBe(200);
  });
});
