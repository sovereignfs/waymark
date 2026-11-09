import { expect, test } from '@playwright/test';
import { recordViolations, signedIn, watchOrigin } from './helpers';

/**
 * The first browser test: the built app is up on its database, its page is the frame it should be, the browser enforces the policy it is sent, and the
 * page asked nobody but its own server for anything. It is small on purpose: the point of this task is that there is a way to test what only a browser can
 * show, and that it fails when the page is broken.
 */

test('the app is up on its database, and says which', async ({ request }) => {
  const response = await request.get('/api/health');
  expect(response.ok()).toBe(true);
  const body = await response.json();
  expect(body.status).toBe('ok');
  expect(['sqlite', 'postgres']).toContain(body.database);
});

test('the page is the shell: a header with the app’s wordmark, a sidebar and the main area', async ({
  page,
}) => {
  await signedIn(page);
  const violations = await recordViolations(page);
  const foreign = watchOrigin(page);
  const errors: string[] = [];
  page.on('console', (message) => message.type() === 'error' && errors.push(message.text()));
  await page.goto('/');

  await expect(page).toHaveTitle('Home · Waymark');
  const header = page.getByRole('banner');
  // The wordmark, drawn lowercase and silent, since the link says the name.
  await expect(header.getByRole('link', { name: 'Waymark' })).toBeVisible();
  await expect(header.getByText('waymark.')).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Waymark' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Home' })).toBeVisible();
  expect(await violations()).toEqual([]);
  expect(errors.filter((text) => !/favicon|Failed to load resource/.test(text))).toEqual([]);
  expect(foreign()).toEqual([]);
});

test('the browser refuses an inline event handler, which the policy does not allow', async ({
  page,
}) => {
  const violations = await recordViolations(page);
  await page.goto('/');
  await page.evaluate(() => {
    document.body.insertAdjacentHTML(
      'beforeend',
      '<img src="data:," onerror="window.__ran = true">',
    );
  });
  await expect.poll(violations).toContain('script-src-attr inline');
  expect(
    await page.evaluate(() => (window as unknown as { __ran?: boolean }).__ran),
  ).toBeUndefined();
});

test('a page that is not there is a page, with a way back', async ({ page }) => {
  await signedIn(page);
  const response = await page.goto('/no-such-page');
  expect(response?.status()).toBe(404);
  await expect(page.getByRole('heading', { name: 'That is not here' })).toBeVisible();
  await page.getByRole('link', { name: 'Go back to Waymark' }).click();
  await expect(page).toHaveURL('/');
});

test.describe('in dark mode', () => {
  test.use({ colorScheme: 'dark' });

  test('the page is dark from the first paint, with no flash of light', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    const background = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    expect(background).toBe('rgb(9, 9, 11)');
  });
});

test.describe('at a phone’s width', () => {
  test.use({ viewport: { width: 375, height: 812 } });

  test('the header, the footer and the page fit, with nothing to scroll sideways', async ({
    page,
  }) => {
    await signedIn(page);
    await page.goto('/');
    await expect(page.getByRole('banner')).toBeVisible();
    await expect(page.getByRole('contentinfo')).toBeVisible();
    // The sidebar is the footer's and the drawer's on a phone, not drawn beside the page.
    await expect(page.getByRole('navigation', { name: 'Waymark' })).toHaveCount(0);
    const overflows = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
    );
    expect(overflows).toBe(false);
  });
});

test('the typeface is the design system’s, served from this origin', async ({ page }) => {
  const foreign = watchOrigin(page);
  await page.goto('/sign-in');
  const family = await page.evaluate(() => getComputedStyle(document.body).fontFamily);
  expect(family).toContain('Hanken Grotesk');
  expect(foreign()).toEqual([]);
});
