import { expect, test } from '@playwright/test';
import {
  goOffline,
  goOnline,
  mockClock,
  mockPosition,
  secondContext,
  watchOrigin,
} from './helpers';

/**
 * The helpers every later browser test builds on, each shown to do what it says on the built app: a second browser with storage of its own, a network that
 * goes away, a position, a clock, and the check of where a page's requests go, which is seen to catch a request to another origin.
 */

test('a second context is another device: what one keeps, the other has not', async ({
  page,
  browser,
}) => {
  await page.goto('/');
  await page.evaluate(() => window.localStorage.setItem('probe', 'one'));
  const other = await secondContext(browser);
  const second = await other.newPage();
  await second.goto('/');
  expect(await second.evaluate(() => window.localStorage.getItem('probe'))).toBeNull();
  expect(await page.evaluate(() => window.localStorage.getItem('probe'))).toBe('one');
  await other.close();
});

test('going offline fails a request, and coming back online answers it', async ({
  page,
  context,
}) => {
  await page.goto('/');
  const get = () =>
    page.evaluate(() =>
      fetch('/api/health', { cache: 'no-store' }).then(
        (response) => response.status,
        () => 'failed',
      ),
    );
  expect(await get()).toBe(200);
  await goOffline(context);
  expect(await page.evaluate(() => navigator.onLine)).toBe(false);
  expect(await get()).toBe('failed');
  await goOnline(context);
  expect(await get()).toBe(200);
});

test('a mocked position is what the device says it is', async ({ page, context }) => {
  await mockPosition(context, { latitude: 35.6586, longitude: 139.7454 });
  await page.goto('/');
  const position = await page.evaluate(
    () =>
      new Promise<{ latitude: number; longitude: number }>((resolve, reject) =>
        navigator.geolocation.getCurrentPosition(
          (found) =>
            resolve({ latitude: found.coords.latitude, longitude: found.coords.longitude }),
          (error) => reject(new Error(error.message)),
        ),
      ),
  );
  expect(position).toEqual({ latitude: 35.6586, longitude: 139.7454 });
});

test.describe('a clock across the date line', () => {
  // One moment, two days: it is still the 31st in London and already the 1st in Auckland. The clock is the test's, and the day is the zone's.
  test.use({ timezoneId: 'Pacific/Auckland' });

  test('is the moment the test chose, in the zone the context has', async ({ page }) => {
    await mockClock(page, '2026-12-31T11:30:00Z');
    await page.goto('/');
    const here = await page.evaluate(() => ({
      iso: new Date().toISOString(),
      day: new Intl.DateTimeFormat('en-CA', { dateStyle: 'short' }).format(new Date()),
    }));
    expect(here.iso.startsWith('2026-12-31T11:30')).toBe(true);
    // 11:30 UTC is half past midnight in Auckland, on the 1st: the day is the zone's, and not the machine's.
    expect(here.day).toBe('2027-01-01');
  });
});

test('the origin check catches a request to another origin, and says which', async ({ page }) => {
  const foreign = watchOrigin(page);
  // A page at our own address, served by the test, that asks a third party for a style: the test serves it so that the policy of a real page is not what stops
  // the request. The check must see the request itself.
  await page.route('**/__planted', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<link rel="stylesheet" href="https://third-party.example/planted.css">',
    }),
  );
  await page.route('https://third-party.example/**', (route) => route.fulfill({ body: '' }));
  await page.goto('/__planted');
  await expect.poll(foreign).toEqual(['https://third-party.example/planted.css']);
});
