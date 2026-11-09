import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { config, proxy } from './proxy';

const request = (path: string, base = 'https://waymark.example.com') =>
  new NextRequest(`${base}${path}`);

/** The `x-middleware-request-*` headers Next copies onto a response: what the page will see as its request's. */
const forwarded = (response: Response, name: string) =>
  response.headers.get(`x-middleware-request-${name}`);

afterEach(() => vi.unstubAllEnvs());

describe('the proxy', () => {
  it('sends a page with a Content-Security-Policy that carries the nonce the page is given', () => {
    vi.stubEnv('WAYMARK_URL', 'https://waymark.example.com');
    const response = proxy(request('/'));
    const policy = response.headers.get('content-security-policy') ?? '';
    const nonce = forwarded(response, 'x-nonce') ?? '';
    expect(nonce).not.toBe('');
    expect(policy).toContain(`'nonce-${nonce}'`);
    // The page's own copy of the request is given the same policy, which is where Next reads the nonce from.
    expect(forwarded(response, 'content-security-policy')).toBe(policy);
  });

  it('makes a new nonce for every request', () => {
    const nonces = new Set(
      Array.from({ length: 50 }, () => forwarded(proxy(request('/checkins')), 'x-nonce')),
    );
    expect(nonces.size).toBe(50);
  });

  it('puts the policy on every kind of page: the landing page, a screen, a missing route and sign-in', () => {
    for (const path of ['/', '/checkins/abc', '/no-such-page', '/sign-in', '/settings']) {
      const policy = proxy(request(path)).headers.get('content-security-policy') ?? '';
      expect(policy, path).toContain("script-src 'self' 'nonce-");
      // A test that fails if the script policy ever allows an inline script (DESIGN.md §25).
      expect(
        policy.split('; ').find((d) => d.startsWith('script-src ')),
        path,
      ).not.toContain("'unsafe-inline'");
    }
  });

  it('gives an answer of the API no policy of its own, since it is data and no page', () => {
    const response = proxy(request('/api/health'));
    expect(response.headers.get('content-security-policy')).toBeNull();
    expect(forwarded(response, 'x-nonce')).toBeNull();
  });

  it('sends Strict-Transport-Security over https and not over plain http on this machine', () => {
    vi.stubEnv('WAYMARK_URL', 'https://waymark.example.com');
    expect(proxy(request('/')).headers.get('strict-transport-security')).toContain('max-age=');
    vi.stubEnv('WAYMARK_URL', 'http://localhost:3005');
    expect(
      proxy(request('/', 'http://localhost:3005')).headers.get('strict-transport-security'),
    ).toBeNull();
  });

  it('upgrades insecure requests over https only, so that http://localhost still works', () => {
    vi.stubEnv('WAYMARK_URL', 'http://localhost:3005');
    expect(proxy(request('/')).headers.get('content-security-policy')).not.toContain(
      'upgrade-insecure-requests',
    );
  });

  it('is matched to every address but the build’s static files and prefetches', () => {
    const [matcher] = config.matcher;
    const pattern = new RegExp(`^${matcher?.source}$`);
    for (const path of ['/', '/checkins', '/trips/abc', '/api/health', '/settings'])
      expect(pattern.test(path), path).toBe(true);
    for (const path of [
      '/_next/static/chunks/a.js',
      '/icons/icon.svg',
      '/sw.js',
      '/manifest.webmanifest',
    ])
      expect(pattern.test(path), path).toBe(false);
    expect(matcher?.missing).toEqual(
      expect.arrayContaining([{ type: 'header', key: 'next-router-prefetch' }]),
    );
  });

  it('shows Home at the front address to someone with a session cookie, and the landing page to anyone else', () => {
    const rewrite = (response: Response) => response.headers.get('x-middleware-rewrite');
    const withCookie = (path: string) =>
      proxy(
        new NextRequest(`https://waymark.example.com${path}`, {
          headers: { cookie: 'waymark.session_token=x' },
        }),
      );
    expect(rewrite(withCookie('/'))).toMatch(/\/home$/);
    expect(rewrite(proxy(request('/')))).toBeNull();
    // The page it is rewritten to is not sent back, which would loop; and it still carries the policy.
    expect(forwarded(withCookie('/'), 'x-waymark-home')).toBe('1');
    expect(withCookie('/').headers.get('content-security-policy')).toContain('nonce-');
    // Home has one address: its own goes to `/` for someone with a cookie, and is left to the page for anyone else (which sends them to sign in).
    const reply = withCookie('/home');
    expect(reply.status).toBe(308);
    expect(reply.headers.get('location')).toBe('https://waymark.example.com/');
    expect(rewrite(proxy(request('/home')))).toBeNull();
    expect(proxy(request('/home')).status).toBe(200);
  });

  it('turns the sign-in pages into a page that is not found when local sign-in is off, and leaves them when it is on', () => {
    const rewrite = (response: Response) => response.headers.get('x-middleware-rewrite');
    vi.stubEnv('WAYMARK_AUTH_LOCAL', '');
    for (const path of ['/sign-in', '/sign-up', '/forgot-password', '/reset-password']) {
      expect(rewrite(proxy(request(path))), path).toMatch(/\/not-found$/);
      // Still a page with a policy: the page that is not found is sent like any other.
      expect(proxy(request(path)).headers.get('content-security-policy'), path).toContain('nonce-');
    }
    expect(rewrite(proxy(request('/')))).toBeNull();
    // Sovereign alone has the one page that takes a person there, and not the others.
    vi.stubEnv('WAYMARK_CORE_URL', 'https://core.example.com');
    expect(rewrite(proxy(request('/sign-in')))).toBeNull();
    expect(rewrite(proxy(request('/sign-up')))).toMatch(/\/not-found$/);
    vi.stubEnv('WAYMARK_AUTH_LOCAL', '1');
    for (const path of ['/sign-in', '/sign-up']) expect(rewrite(proxy(request(path)))).toBeNull();
  });
});
