import { expect, test, type Page } from '@playwright/test';
import { signedIn } from './helpers';

/**
 * The shell's places (DESIGN.md §20.2, §20.3), in real browsers: every place is reachable with the keyboard, and the check-in sheet opens over any page, in the address, and closes back to it, by
 * Escape, by its button and by the back button, and `C` opens it from anywhere that is not a place to type.
 */
const PLACES = [
  { name: 'Home', path: '/' },
  { name: 'Check-ins', path: '/checkins' },
  { name: 'Map', path: '/map' },
  { name: 'Places', path: '/places' },
];

const sheet = (page: Page) => page.getByRole('dialog', { name: 'Check in' });
const url = (page: Page) => {
  const u = new URL(page.url());
  return `${u.pathname}${u.search}`;
};

test('every place of the sidebar is reachable with the keyboard alone, in order, and the current one is marked', async ({
  page,
  browserName,
}) => {
  await signedIn(page);
  await page.goto('/checkins');
  const nav = page.getByRole('navigation', { name: 'Waymark' });
  await expect(nav.getByRole('link', { name: 'Check-ins' })).toHaveAttribute(
    'aria-current',
    'page',
  );
  const checkIn = nav.getByRole('link', { name: /^Check in\b/ });
  await checkIn.focus();
  // Safari does not Tab to links unless the person has asked it to (it is Option-Tab there), so the order of Tab is asked of the browsers that do; what each link does by Enter is asked of all.
  if (browserName !== 'webkit') {
    const reached: string[] = [];
    for (let i = 0; i < PLACES.length + 1; i++) {
      reached.push(
        (
          await page.evaluate(() => {
            const el = document.activeElement;
            return el?.getAttribute('aria-label') || el?.textContent || '';
          })
        )
          .replace(/\s+/g, ' ')
          .trim(),
      );
      await page.keyboard.press('Tab');
    }
    // Check in first, then the four places in the order the design gives.
    expect(reached.map((text) => text.replace(/ ?C$/, '').trim())).toEqual([
      'Check in',
      'Home',
      'Check-ins',
      'Map',
      'Places',
    ]);
  }
  // Each is a link that goes where it says, by Enter.
  for (const place of PLACES) {
    await nav.getByRole('link', { name: place.name, exact: true }).focus();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(new RegExp(`${place.path === '/' ? '/$' : `${place.path}$`}`));
    await expect(nav.getByRole('link', { name: place.name, exact: true })).toHaveAttribute(
      'aria-current',
      'page',
    );
  }
});

for (const place of [...PLACES, { name: 'Settings', path: '/settings' }]) {
  test(`the check-in sheet opens over ${place.name} and closes back to it, by Escape, by its button and by the back button`, async ({
    page,
  }) => {
    await signedIn(page);
    await page.goto(place.path);
    const here = url(page);
    const nav = page.getByRole('navigation', { name: 'Waymark' });
    const checkIn = nav.getByRole('link', { name: /^Check in\b/ });

    // By the keyboard on the link; it is in the address, over the same page.
    await checkIn.focus();
    await page.keyboard.press('Enter');
    await expect(sheet(page)).toBeVisible();
    expect(url(page)).toBe(`${here}${here.includes('?') ? '&' : '?'}checkin=new`);
    await expect(sheet(page).getByText('Check in', { exact: true }).first()).toBeVisible();

    // Escape closes it, and the address and the page are as they were.
    await page.keyboard.press('Escape');
    await expect(sheet(page)).toHaveCount(0);
    expect(url(page)).toBe(here);

    // Its own button closes it too.
    await checkIn.click();
    await expect(sheet(page)).toBeVisible();
    await sheet(page).getByRole('button', { name: /close/i }).click();
    await expect(sheet(page)).toHaveCount(0);
    expect(url(page)).toBe(here);

    // And the back button: the sheet was a step in the history.
    await checkIn.click();
    await expect(sheet(page)).toBeVisible();
    await page.goBack();
    await expect(sheet(page)).toHaveCount(0);
    expect(url(page)).toBe(here);
  });
}

test('the C key opens the sheet from anywhere that is not a place to type, and does nothing in one', async ({
  page,
}) => {
  await signedIn(page);
  await page.goto('/places');
  await page.locator('body').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('c');
  await expect(sheet(page)).toBeVisible();
  expect(url(page)).toBe('/places?checkin=new');
  // With it open, C is not another request.
  await page.keyboard.press('Escape');
  await expect(sheet(page)).toHaveCount(0);
  // Not with a modifier: that is the browser's.
  await page.keyboard.press('Control+c');
  await expect(sheet(page)).toHaveCount(0);
  // Not while typing: a field on a page that has one (the sign-in's email, on the page a signed-out visitor sees).
  await page.goto('/settings');
  const name = page.getByLabel('Name').first();
  await name.focus();
  await page.keyboard.press('c');
  await expect(sheet(page)).toHaveCount(0);
  expect(url(page)).toBe('/settings');
  await expect(name).toHaveValue(/c/);
});

test('an address with checkin=new opens the sheet on load, over its page, and a query that is anything else does not', async ({
  page,
}) => {
  await signedIn(page);
  await page.goto('/checkins?year=2026&checkin=new');
  await expect(sheet(page)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(sheet(page)).toHaveCount(0);
  expect(url(page)).toBe('/checkins?year=2026');
  for (const query of ['?checkin', '?checkin=old', '?checkin=NEW']) {
    await page.goto(`/map${query}`);
    await expect(page.getByRole('heading', { name: 'Map' })).toBeVisible();
    await expect(sheet(page)).toHaveCount(0);
  }
});

test('at a phone’s width the same sheet is a drawer, with the same content, and closes the same way', async ({
  page,
}) => {
  await signedIn(page);
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto('/map?checkin=new');
  await expect(sheet(page)).toBeVisible();
  await expect(sheet(page).getByText('Close this to go back to where you were.')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(sheet(page)).toHaveCount(0);
  expect(url(page)).toBe('/map');
});
