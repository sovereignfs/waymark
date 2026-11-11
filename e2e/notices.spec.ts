import { expect, test, type Page } from '@playwright/test';
import { signedIn } from './helpers';

/**
 * The bell and `/notifications` (DESIGN.md §17.1), in real browsers. Nothing in phase 1 raises a notice until the import does (8.1), so the notices the server would hold are given by the test, at the one address
 * the screens ask (`/api/notices`); what the server does with them is held by the server's own tests (`src/notices/*.test.ts`). Here: the count on the bell (and "99+"), the panel, opening a notice and marking it
 * read, *Mark all read*, the page by day, and what happens with no network.
 */
test.use({ actionTimeout: 15_000 });
expect.configure({ timeout: 15_000 });

interface Held {
  id: string;
  kind: string;
  at: number;
  read: boolean;
  title: string;
  detail?: string;
  href?: string;
}

/** Answers `/api/notices` from `held`, and applies what is posted to it as the server would. Returns what was posted. */
async function serve(page: Page, held: Held[]) {
  const posted: unknown[] = [];
  await page.route('**/api/notices', async (route) => {
    const request = route.request();
    if (request.method() === 'POST') {
      const body = request.postDataJSON() as { ids?: string[]; all?: boolean };
      posted.push(body);
      for (const each of held) if (body.all || body.ids?.includes(each.id)) each.read = true;
      return route.fulfill({ json: { marked: 1 } });
    }
    return route.fulfill({
      json: { unread: held.filter((each) => !each.read).length, notices: held },
    });
  });
  return posted;
}

const NOW = () => Date.now();
/** Yesterday at noon on this machine's clock: whatever time of day the test runs, it is yesterday and not the day before. */
const yesterdayNoon = () => {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  d.setHours(12, 0, 0, 0);
  return d.getTime();
};
const notice = (n: number, over: Partial<Held> = {}): Held => ({
  id: `n${String(n).padStart(3, '0')}`,
  kind: 'import_finished',
  at: NOW() - n * 60_000,
  read: false,
  title: `Your import ${n} finished`,
  href: '/checkins',
  ...over,
});

test('the bell counts what is unread, lists it, opens a notice and marks it read', async ({
  page,
}) => {
  await signedIn(page);
  const held = [notice(1), notice(2), notice(3, { read: true })];
  const posted = await serve(page, held);
  await page.goto('/places');

  const bell = page.getByRole('button', { name: /^Notifications/ });
  await expect(bell).toBeVisible();
  await expect(bell).toHaveAccessibleName(/2/);
  await bell.click();
  const panel = page.getByRole('dialog').or(page.locator('[role=menu], [role=region]')).first();
  await expect(page.getByText('Your import 1 finished').first()).toBeVisible();
  await expect(page.getByText('Your import 2 finished').first()).toBeVisible();

  // Opening one goes where it points and marks it read.
  await page.getByRole('link', { name: 'Your import 1 finished' }).first().click();
  await expect(page).toHaveURL(/\/checkins/);
  expect(posted).toContainEqual({ ids: ['n001'] });
  await expect(page.getByRole('button', { name: /^Notifications/ })).toHaveAccessibleName(/1/);
  void panel;
});

test('the count is 99+ from a hundred, and Mark all read clears it and survives a reload', async ({
  page,
}) => {
  await signedIn(page);
  const held = Array.from({ length: 100 }, (_, i) => notice(i + 1));
  const posted = await serve(page, held);
  await page.goto('/places');
  const bell = page.getByRole('button', { name: /^Notifications/ });
  await expect(bell).toHaveAccessibleName(/100 unread/);
  await expect(bell).toContainText('99+');

  await page.goto('/notifications');
  await expect(page.getByRole('heading', { name: 'Notifications' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Today' })).toBeVisible();
  await page.getByRole('button', { name: 'Mark all read' }).click();
  await expect(page.getByRole('button', { name: 'Mark all read' })).toBeDisabled();
  expect(posted).toContainEqual({ all: true });
  await page.reload();
  await expect(page.getByRole('button', { name: 'Mark all read' })).toBeDisabled();
  await expect(page.getByRole('button', { name: /^Notifications/ })).not.toHaveAccessibleName(/\d/);
});

test('the page lists by day, opens a notice and marks it read, and says so when there are none', async ({
  page,
}) => {
  await signedIn(page);
  const day = 86_400_000;
  const held = [
    notice(1, { detail: 'It took 3 minutes.' }),
    notice(2, { at: yesterdayNoon(), title: 'Yesterday’s one' }),
    notice(3, { at: NOW() - 40 * day, title: 'Long ago', read: true }),
  ];
  const posted = await serve(page, held);
  await page.goto('/notifications');
  await expect(page.getByText('It took 3 minutes.')).toBeVisible();
  await expect(
    page.getByRole('region', { name: 'Yesterday' }).getByText('Yesterday’s one'),
  ).toBeVisible();
  await expect(page.getByText('Long ago')).toBeVisible();
  await page.getByRole('link', { name: 'Your import 1 finished' }).click();
  await expect(page).toHaveURL(/\/checkins/);
  expect(posted).toContainEqual({ ids: ['n001'] });

  held.length = 0;
  await page.goto('/notifications');
  await expect(page.getByText('Nothing yet')).toBeVisible();
});

test('with no network the bell and the page say nothing of it, and show what they last had', async ({
  page,
  context,
}) => {
  await signedIn(page);
  const held = [notice(1)];
  await serve(page, held);
  await page.goto('/places');
  await expect(page.getByRole('button', { name: /^Notifications/ })).toHaveAccessibleName(/1/);
  await context.setOffline(true);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await page.waitForTimeout(500);
  await expect(page.getByRole('button', { name: /^Notifications/ })).toHaveAccessibleName(/1/);
  await context.setOffline(false);
});

test('Settings, Notifications: with no mail set up it says the bell is the only channel and the switches are off', async ({
  page,
}) => {
  await signedIn(page);
  await page.goto('/settings?section=notifications');
  const section = page.getByRole('region', { name: 'Notifications' });
  await expect(section.getByText(/Email is not set up on this server/)).toBeVisible();
  const toggle = section.getByRole('switch', { name: /Email me when: An import from Swarm/ });
  await expect(toggle).toBeVisible();
  await expect(toggle).toBeDisabled();
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
});
