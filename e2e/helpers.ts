import type { Browser, BrowserContext, Page } from '@playwright/test';
import { PORTS } from './ports';

/**
 * What the browser tests share: a second person's browser, a network that goes away, a position, a clock, and a check that a page asked nobody but its
 * own server for anything. Each takes the context or page it is for, so that a test says what it changes.
 */

/** A second browser context, which has storage of its own: a second device, or a second person. `use` carries what the test's own context was given. */
export async function secondContext(
  browser: Browser,
  options: Parameters<Browser['newContext']>[0] = {},
): Promise<BrowserContext> {
  return browser.newContext({ baseURL: `http://localhost:${PORTS.app}`, ...options });
}

/** The network goes away, and comes back: a page's requests fail as they do with no connection, and `online` and `offline` events fire. */
export async function goOffline(context: BrowserContext): Promise<void> {
  await context.setOffline(true);
}
export async function goOnline(context: BrowserContext): Promise<void> {
  await context.setOffline(false);
}

/** The device is at a place: the permission is granted to every page of the context, and the position is what `navigator.geolocation` answers. */
export async function mockPosition(
  context: BrowserContext,
  position: { latitude: number; longitude: number; accuracy?: number },
): Promise<void> {
  await context.grantPermissions(['geolocation']);
  await context.setGeolocation({ accuracy: 10, ...position });
}

/**
 * The page's clock is a moment of the test's choosing and runs on from there (`Date`, timers). Install it before the page loads anything, and give the zone
 * with the context's `timezoneId` (Trip Mode's day is the trip's, and a date line is crossed by a clock and a zone together, DESIGN.md §14.1).
 */
export async function mockClock(page: Page, iso: string): Promise<void> {
  await page.clock.install({ time: new Date(iso) });
}

/**
 * Records every request the page makes to anything but its own server (`data:` and `blob:` are the page's own), and returns what was recorded so far. A page
 * of Waymark asks nobody else for anything: the map's style, tiles, glyphs and sprites come from `/api/map`, place search from `/api/places`, the typeface from the
 * app (DESIGN.md §25 Security). Call it before the page is opened.
 */
export function watchOrigin(page: Page): () => string[] {
  const own = new URL(`http://localhost:${PORTS.app}`).origin;
  const foreign: string[] = [];
  page.on('request', (request) => {
    const url = request.url();
    if (url.startsWith('data:') || url.startsWith('blob:') || url === 'about:blank') return;
    if (new URL(url).origin !== own) foreign.push(url);
  });
  return () => [...foreign];
}

/** Records every Content-Security-Policy violation the page raises, from before it runs anything. */
export async function recordViolations(page: Page): Promise<() => Promise<string[]>> {
  await page.addInitScript(() => {
    const w = window as unknown as { __violations: string[] };
    w.__violations = [];
    document.addEventListener('securitypolicyviolation', (event) => {
      w.__violations.push(`${event.violatedDirective} ${event.blockedURI}`);
    });
  });
  return () => page.evaluate(() => (window as unknown as { __violations: string[] }).__violations);
}
