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
});
