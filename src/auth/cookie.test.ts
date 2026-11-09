import { describe, expect, it } from 'vitest';
import { COOKIE_PREFIX } from './auth';
import { SESSION_COOKIES, hasSessionCookie } from './cookie';

const jar = (values: Record<string, string>) => ({
  get: (name: string) => (name in values ? { value: values[name] ?? '' } : undefined),
});

describe('the session cookie', () => {
  it('is named as better-auth names it, with and without the Secure prefix, so the proxy and the server agree', () => {
    expect([...SESSION_COOKIES]).toEqual([
      `${COOKIE_PREFIX}.session_token`,
      `__Secure-${COOKIE_PREFIX}.session_token`,
    ]);
  });

  it('is found when it is there with a value, either name, and only then', () => {
    expect(hasSessionCookie(jar({ 'waymark.session_token': 'x' }))).toBe(true);
    expect(hasSessionCookie(jar({ '__Secure-waymark.session_token': 'x' }))).toBe(true);
    expect(hasSessionCookie(jar({ 'waymark.session_token': '' }))).toBe(false);
    expect(
      hasSessionCookie(
        jar({ session_token: 'x', 'waymark.session_data': 'y', 'fjord.session_token': 'z' }),
      ),
    ).toBe(false);
    expect(hasSessionCookie(jar({}))).toBe(false);
  });
});
