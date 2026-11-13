import { expect, test, type Page } from '@playwright/test';
import { signedIn } from './helpers';

/**
 * Phase 1 at a phone's width (DESIGN.md §20.12), in real browsers: **the footer** has Home and Check-ins left of the launcher and Map and Trips right; **_Check in_ is a floating button** above it that opens the drawer; **the avatar
 * menu holds Places, Notifications, Import and Settings**; the pages are pages with a way back, and nothing is wider than the screen. The same addresses as at any other width.
 */
test.use({
  viewport: { width: 375, height: 812 },
  hasTouch: true,
  isMobile: true,
  actionTimeout: 15_000,
});
expect.configure({ timeout: 15_000 });

const fits = async (page: Page) =>
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
  ).toBeLessThanOrEqual(0);

test('the footer, the floating Check in and the avatar menu hold every place, and every page fits', async ({
  page,
}) => {
  await signedIn(page);
  await page.goto('/');
  await fits(page);

  // The footer: Home and Check-ins, the launcher, Map and Trips.
  const footer = page
    .getByRole('navigation')
    .filter({ has: page.getByRole('link', { name: 'Trips' }) })
    .last();
  for (const name of ['Home', 'Check-ins', 'Map', 'Trips'])
    await expect(footer.getByRole('link', { name })).toBeVisible();
  await expect(footer.getByRole('link', { name: 'Places' })).toHaveCount(0);

  // The floating Check in opens the drawer over the page, and closing it leaves the page as it was.
  const fab = page.locator('button[aria-label="Check in"]');
  await expect(fab).toBeVisible();
  await fab.click();
  const sheet = page.getByRole('dialog', { name: 'Check in' });
  await expect(sheet).toBeVisible();
  await expect(page).toHaveURL(/checkin=new/);
  await page.keyboard.press('Escape');
  await expect(sheet).toHaveCount(0);
  await expect(page).not.toHaveURL(/checkin=new/);

  // Each footer place goes where it says, as a page that fits.
  for (const [name, path] of [
    ['Check-ins', '/checkins'],
    ['Map', '/map'],
    ['Trips', '/trips'],
    ['Home', '/'],
  ] as const) {
    await footer.getByRole('link', { name }).click();
    await expect(page).toHaveURL(new RegExp(`${path === '/' ? '/$' : `${path}$`}`));
    await expect(footer.getByRole('link', { name })).toHaveAttribute('aria-current', 'page');
    await fits(page);
  }

  // The avatar menu: Places, Notifications, Import and Settings, each a page.
  for (const [item, path] of [
    ['Places', '/places'],
    ['Notifications', '/notifications'],
    ['Import', '/settings'],
    ['Settings', '/settings'],
  ] as const) {
    await page.getByRole('button', { name: 'User menu' }).click();
    await page.getByRole('menuitem', { name: item }).click();
    await expect(page).toHaveURL(new RegExp(path));
    await fits(page);
  }
  // Import goes to the Data section, where an import is made.
  await page.getByRole('button', { name: 'User menu' }).click();
  await page.getByRole('menuitem', { name: 'Import' }).click();
  await expect(page).toHaveURL(/section=data/);
});
