/**
 * The name of the session cookie better-auth sets (`advanced.cookiePrefix` in `auth.ts`): `waymark.session_token`, and with `Secure` cookies, which is
 * when `WAYMARK_URL` is https, `__Secure-waymark.session_token`. Kept apart from `auth.ts` since the proxy reads it and **the proxy runs on the Edge**:
 * it may import no Node built-in and no database, and `auth.ts` imports both.
 */
export const SESSION_COOKIES = ['waymark.session_token', '__Secure-waymark.session_token'] as const;

/**
 * Whether a request carries a session cookie. **Only that it is there**: the proxy cannot check it and does not try, and a forged one gets the app's
 * page, which checks the session itself and sends the visitor to sign in. A proxy is never the only thing standing in the way (DESIGN.md §7).
 */
export function hasSessionCookie(cookies: {
  get(name: string): { value: string } | undefined;
}): boolean {
  return SESSION_COOKIES.some((name) => (cookies.get(name)?.value ?? '') !== '');
}
