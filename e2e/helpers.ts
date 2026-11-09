import { expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
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

/**
 * What the browser tests that need a signed-in person share. The instance is closed to sign-up, so the first account is the only one there will be, and it
 * is made by whichever test gets here first: both browsers share the instance, so every test starts by making sure there is one.
 */
export const EMAIL = 'owner@example.com';
export const PASSWORD = 'correct horse battery';

export async function ensureAccount(page: Page) {
  await page.goto('/sign-up');
  const create = page.getByRole('heading', { name: 'Create your account' });
  if (!(await create.isVisible())) return;
  await page.getByLabel('Name').fill('Ada');
  await page.getByLabel('Email').fill(EMAIL);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('button', { name: 'User menu' })).toBeVisible();
  await signOut(page);
}

/**
 * Opens the sign-in page. Right after the page has signed itself out it is already on its way to `/sign-in`, and WebKit then refuses a second navigation to the
 * same address ("interrupted by another navigation"). That one is not a failure: the page is going where we asked, so let it arrive, and only ask again if it did not.
 */
async function gotoSignIn(page: Page) {
  try {
    await page.goto('/sign-in');
  } catch (error) {
    if (!/interrupted by another navigation/.test(String(error))) throw error;
    await page.waitForLoadState('load');
    if (new URL(page.url()).pathname !== '/sign-in') await page.goto('/sign-in');
  }
}

/**
 * Fills the sign-in form and submits it. Sign-in is rate-limited per address (three attempts in ten seconds), and both browsers reach this instance from the
 * same one, so an attempt can be told to wait: it then does, once the window has passed, as a person would.
 */
export async function trySignIn(page: Page, email: string, password: string) {
  await gotoSignIn(page);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  const submit = page.getByRole('button', { name: 'Sign in' });
  await submit.click();
  const limited = page.getByText(/Too many tries/);
  const outcome = page
    .getByText(/do not match/)
    .or(page.getByRole('button', { name: 'User menu' }));
  await expect(limited.or(outcome)).toBeVisible();
  if (await limited.isVisible()) {
    await page.waitForTimeout(10_500);
    await submit.click();
  }
}

export async function signOut(page: Page) {
  await page.getByRole('button', { name: 'User menu' }).click();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
  await expect(page.getByRole('button', { name: 'User menu' })).toHaveCount(0);
}

/** The account is there and this page is signed in to it, on Home. */
export async function signedIn(page: Page) {
  await ensureAccount(page);
  await trySignIn(page, EMAIL, PASSWORD);
  await expect(page.getByRole('button', { name: 'User menu' })).toBeVisible();
}
