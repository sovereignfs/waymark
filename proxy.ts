import { type NextRequest, NextResponse } from 'next/server';
import { hasSessionCookie } from './src/auth/cookie';
import { edgeSettings } from './src/config/edge';
import { HSTS, contentSecurityPolicy, newNonce } from './src/security/csp';

/**
 * **Every page is sent with a Content-Security-Policy** with a nonce of its own (`src/security/csp.ts`), so every page is rendered per request, the
 * landing page too. The proxy makes the nonce and puts the policy on the request, where Next reads it and puts the nonce on the scripts and styles
 * it makes, and the layout puts it on the theme script (`x-nonce`); it puts the policy on the response too, where the browser enforces it. An API's
 * answer is data, with no page to protect, so it gets only the headers every response has (`next.config.ts`).
 *
 * It keeps the Edge discipline: no Node built-ins and no database. It only looks at the request, so a session is for the page to check, and a
 * proxy is never the only thing standing in the way (DESIGN.md §5.2). Copied from Tusk.
 *
 * The service worker keeps one page, `/shell` (1.11), and answers an address with it when there is no network. It is kept with the headers it was
 * sent with, so the nonce in its policy is the nonce on its scripts: it needs no fresh one.
 */
const SIGN_IN_PAGES = new Set(['/sign-in', '/sign-up', '/forgot-password', '/reset-password']);
/** What a Sovereign-only instance has of them: the page that takes a person away to sign in there. Sign-up, and resetting a password, are local. */
const SOVEREIGN_PAGES = new Set(['/sign-in']);

/** Set on the request the proxy rewrites `/` into, so that the page it is rewritten to is not sent back to `/` (which would be a loop). */
const HOME_MARK = 'x-waymark-home';

export function proxy(request: NextRequest) {
  const { secure, development, authLocal, authSovereign } = edgeSettings();
  const page = !request.nextUrl.pathname.startsWith('/api/');
  const nonce = newNonce();
  const policy = contentSecurityPolicy({ nonce, secure, development });

  const requestHeaders = new Headers(request.headers);
  if (page) {
    requestHeaders.set('x-nonce', nonce);
    requestHeaders.set('content-security-policy', policy);
  }

  // Off means off (DESIGN.md §19.1): with local sign-in off, the sign-in pages are not there (but the one page that takes a person to Sovereign, when that is set up).
  // A page cannot say so itself: the root loading state has already sent a 200 by the time it would, so the proxy answers with the page that is not found, and its status.
  const path = request.nextUrl.pathname;
  const absent =
    !authLocal && SIGN_IN_PAGES.has(path) && !(authSovereign && SOVEREIGN_PAGES.has(path));
  // The front address is Home for someone with a session cookie, and the address stays `/` (DESIGN.md §20.3). Only the cookie is looked at: it cannot be checked here,
  // and the page checks it and sends a forged one to sign in. Home's own address, `/home`, goes to `/`, so that there is one address for it.
  const cookie = hasSessionCookie(request.cookies);
  if (cookie && path === '/home' && !request.headers.has(HOME_MARK))
    return NextResponse.redirect(new URL('/', request.url), 308);
  const signedIn = path === '/' && cookie;
  const target = absent ? '/not-found' : signedIn ? '/home' : null;
  if (signedIn && !absent) requestHeaders.set(HOME_MARK, '1');
  const response = target
    ? NextResponse.rewrite(new URL(target, request.url), { request: { headers: requestHeaders } })
    : NextResponse.next({ request: { headers: requestHeaders } });
  if (page) response.headers.set('content-security-policy', policy);
  if (secure) response.headers.set('strict-transport-security', HSTS);
  return response;
}

/** Everything but the build's own static files, which are not pages and are the same for everyone (and cannot carry a nonce), and prefetches. */
export const config = {
  matcher: [
    {
      source:
        '/((?!_next/static|_next/image|favicon.ico|icon.svg|icons/|sw.js|manifest.webmanifest).*)',
      missing: [
        { type: 'header', key: 'next-router-prefetch' },
        { type: 'header', key: 'purpose', value: 'prefetch' },
      ],
    },
  ],
};
