import { describe, expect, it } from 'vitest';
import { HSTS, SECURITY_HEADERS, contentSecurityPolicy, newNonce } from './csp';

const policy = (over: Partial<Parameters<typeof contentSecurityPolicy>[0]> = {}) =>
  contentSecurityPolicy({ nonce: 'NONCE', secure: true, development: false, ...over });

/** The sources of one directive. */
const directive = (text: string, name: string): string[] => {
  const found = text.split('; ').find((d) => d.startsWith(`${name} `) || d === name);
  return found ? found.split(' ').slice(1) : [];
};

describe('the Content-Security-Policy', () => {
  it('lets a script run only with the request’s nonce, or when a script that has it loads it', () => {
    const scripts = directive(policy(), 'script-src');
    expect(scripts).toContain("'nonce-NONCE'");
    expect(scripts).toContain("'strict-dynamic'");
    expect(scripts).not.toContain("'unsafe-inline'");
    expect(scripts).not.toContain("'unsafe-eval'");
    expect(scripts).not.toContain("'wasm-unsafe-eval'");
  });

  it('never allows an inline script, a handler or eval, in production', () => {
    expect(policy()).not.toMatch(/unsafe-inline.*script|script-src[^;]*unsafe/);
  });

  it('allows eval in development only, because React asks for it there', () => {
    expect(directive(policy({ development: true }), 'script-src')).toContain("'unsafe-eval'");
    expect(directive(policy({ development: false }), 'script-src')).not.toContain("'unsafe-eval'");
  });

  it('gives style elements the nonce in production, and allows style attributes', () => {
    expect(directive(policy(), 'style-src-elem')).toEqual(["'self'", "'nonce-NONCE'"]);
    expect(directive(policy(), 'style-src-attr')).toEqual(["'unsafe-inline'"]);
  });

  it('serves everything else from this origin, and nothing third-party', () => {
    const text = policy();
    expect(text).not.toMatch(/https?:/);
    for (const name of ['default-src', 'font-src', 'connect-src', 'manifest-src']) {
      expect(directive(text, name), name).toEqual(["'self'"]);
    }
    // The service worker, and MapLibre's worker, which the app serves as a file of its own: this origin alone, no blob.
    expect(directive(text, 'worker-src')).toEqual(["'self'"]);
    expect(directive(text, 'img-src')).toEqual(["'self'", 'data:', 'blob:']);
  });

  it('allows no frame, no plugin, no framing of a page, and no foreign form target or base', () => {
    const text = policy();
    expect(directive(text, 'frame-src')).toEqual(["'none'"]);
    expect(directive(text, 'object-src')).toEqual(["'none'"]);
    expect(directive(text, 'frame-ancestors')).toEqual(["'none'"]);
    expect(directive(text, 'form-action')).toEqual(["'self'"]);
    expect(directive(text, 'base-uri')).toEqual(["'self'"]);
  });

  it('upgrades insecure requests only where the app is served over https', () => {
    expect(policy({ secure: true })).toContain('upgrade-insecure-requests');
    expect(policy({ secure: false })).not.toContain('upgrade-insecure-requests');
  });

  it('leaves the development overlay’s inline styles allowed, and only there', () => {
    expect(directive(policy({ development: true }), 'style-src')).toEqual([
      "'self'",
      "'unsafe-inline'",
    ]);
    expect(directive(policy({ development: false }), 'style-src')).not.toContain("'unsafe-inline'");
  });
});

describe('a nonce', () => {
  it('is 128 bits of base64, and new each time', () => {
    const nonces = new Set(Array.from({ length: 200 }, newNonce));
    expect(nonces.size).toBe(200);
    for (const nonce of nonces) expect(atob(nonce)).toHaveLength(16);
  });
});

describe('the headers every response has', () => {
  const headers = Object.fromEntries(SECURITY_HEADERS.map((h) => [h.key, h.value]));

  it('forbids sniffing, framing and a referrer, and the device', () => {
    expect(headers['X-Content-Type-Options']).toBe('nosniff');
    expect(headers['X-Frame-Options']).toBe('DENY');
    expect(headers['Referrer-Policy']).toBe('no-referrer');
    expect(headers['Permissions-Policy']).toContain('camera=()');
    // Checking in here asks where the device is, and nothing else about it.
    expect(headers['Permissions-Policy']).toContain('geolocation=(self)');
    expect(headers['Permissions-Policy']).not.toContain('microphone=(self)');
    expect(headers['Cross-Origin-Opener-Policy']).toBe('same-origin');
  });

  it('has a year of HSTS for the subdomains too', () => {
    expect(HSTS).toBe('max-age=31536000; includeSubDomains');
  });
});
