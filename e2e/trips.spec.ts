import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { PORTS } from './ports';
import { signedIn } from './helpers';

/**
 * The trips (DESIGN.md §20.9, §20.2), in real browsers: a trip of each status is in its group with the action its status gives, a search and a chip narrow the list, and **a trip made here is in the sidebar at once**.
 * The trips are made through the same operations the dialog uses (`/api/ops`), with dates around today, so that no clock needs to be pretended.
 */
test.use({ actionTimeout: 15_000 });
expect.configure({ timeout: 15_000 });

const ORIGIN = `http://localhost:${PORTS.app}`;
const day = (offset: number) =>
  new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

async function op(page: Page, body: Record<string, unknown>) {
  const reply = await page.request.post('/api/ops', { headers: { origin: ORIGIN }, data: body });
  expect(reply.ok()).toBe(true);
  const json = (await reply.json()) as { ok: boolean; trip?: { id: string } };
  expect(json.ok).toBe(true);
  return json.trip as { id: string };
}

/** A trip with one stop in Lisbon, dated around today, and ready or not. */
async function makeTrip(
  page: Page,
  name: string,
  dates: [number, number] | undefined,
  ready: boolean,
) {
  const trip = await op(page, { op: 'trip.create', name });
  await op(page, {
    op: 'stop.add',
    tripId: trip.id,
    place: { name: 'Lisbon', lat: 38.72, lng: -9.14, tz: 'Europe/Lisbon', source: 'manual' },
    ...(dates ? { arrive: day(dates[0]), depart: day(dates[1]) } : {}),
  });
  if (ready) await op(page, { op: 'trip.ready', tripId: trip.id });
  return trip.id;
}

test('a trip of each status is in its group with its action, and a chip and a search narrow the list', async ({
  page,
}) => {
  await signedIn(page);
  const tag = randomUUID().slice(0, 8);
  const planning = await makeTrip(page, `Plan ${tag}`, undefined, false);
  const upcoming = await makeTrip(page, `Soon ${tag}`, [20, 25], true);
  const ongoing = await makeTrip(page, `Now ${tag}`, [-3, 3], true);
  const completed = await makeTrip(page, `Done ${tag}`, [-30, -25], true);

  await page.goto('/trips');
  const card = (id: string) => page.locator(`[data-trip="${id}"]`);
  await expect(card(ongoing)).toBeVisible();
  for (const [id, status, action, href] of [
    [ongoing, 'Ongoing', 'Open Trip Mode', `/t/${ongoing}/today`],
    [upcoming, 'Upcoming', 'View plan', `/t/${upcoming}?view=plan`],
    [planning, 'Planning', 'Continue planning', `/t/${planning}?view=plan`],
    [completed, 'Completed', 'Open journal', `/t/${completed}?view=journal`],
  ] as const) {
    const inGroup = page.getByRole('region', { name: status }).locator(`[data-trip="${id}"]`);
    await expect(inGroup).toBeVisible();
    await expect(inGroup.getByRole('link', { name: action })).toHaveAttribute('href', href);
    await expect(inGroup).toContainText('Lisbon');
  }

  // The groups are in the design's order.
  const headings = await page.getByRole('heading', { level: 2 }).allTextContents();
  const order = ['Ongoing', 'Upcoming', 'Planning', 'Completed'].map((h) => headings.indexOf(h));
  expect(order.every((at, i) => at >= 0 && (i === 0 || at > (order[i - 1] as number)))).toBe(true);

  // A chip narrows to its status, and is in the address.
  await page.getByRole('button', { name: /^Upcoming/ }).click();
  await expect(page).toHaveURL(/status=upcoming/);
  await expect(card(upcoming)).toBeVisible();
  await expect(card(ongoing)).toHaveCount(0);
  await page.getByRole('button', { name: /^All/ }).click();
  await expect(card(ongoing)).toBeVisible();

  // A search finds by name, and says when nothing matches.
  await page.getByLabel('Search trips').fill(`done ${tag}`);
  await expect(card(completed)).toBeVisible();
  await expect(card(planning)).toHaveCount(0);
  await page.getByLabel('Search trips').fill(`nothing like this ${tag}`);
  await expect(page.getByText('No trip matches')).toBeVisible();
});

test('a trip made in the dialog is in the sidebar and in the list at once, with its first stop', async ({
  page,
}) => {
  await signedIn(page);
  // The place search is limited per account and every test of the suite shares one, so the dialog is given a search of its own here; `e2e/checkin.spec.ts` asks the real one.
  await page.route('**/api/places?**', (route) =>
    route.fulfill({
      json: {
        status: 'ok',
        found: [
          {
            name: 'Tokyo',
            lat: 35.68,
            lng: 139.69,
            category: 'city',
            source: 'osm',
            sourceId: 'relation/1543125',
          },
        ],
      },
    }),
  );
  await page.goto('/trips?new=1');
  const dialog = page.getByRole('dialog', { name: 'New trip' });
  await expect(dialog).toBeVisible();
  const name = `Iceland ${randomUUID().slice(0, 8)}`;
  await dialog.getByLabel('Name').fill(name);
  await dialog.getByRole('radio', { name: 'Green' }).click();
  // The first stop is found by the place search and chosen.
  await dialog.getByLabel('First stop (optional)').fill('Tokyo');
  await dialog.getByRole('list', { name: 'Places found' }).getByRole('button').first().click();
  await expect(dialog.getByText('First stop:')).toBeVisible();
  await dialog.getByRole('button', { name: 'Make the trip' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page).not.toHaveURL(/new=1/);

  // Every page but Home opens the sidebar as a rail, where a trip is its dot.
  const nav = page.getByRole('navigation', { name: 'Waymark' });
  await expect(nav.getByRole('link', { name })).toBeVisible();
  await expect(
    page.locator('[data-status="planning"]').filter({ hasText: name }).filter({ hasText: 'Tokyo' }),
  ).toBeVisible();

  // Without a name the dialog says so and makes nothing.
  await page.getByRole('button', { name: 'New trip' }).first().click();
  await page
    .getByRole('dialog', { name: 'New trip' })
    .getByRole('button', { name: 'Make the trip' })
    .click();
  await expect(page.getByText('Give the trip a name.')).toBeVisible();
});

test('the sidebar names the trips and goes to the list and the dialog', async ({ page }) => {
  await signedIn(page);
  const name = `Side ${randomUUID().slice(0, 8)}`;
  const id = await makeTrip(page, name, [-1, 1], true);
  // Home opens the sidebar full: the name, the status and the two links that go further.
  await page.goto('/');
  const nav = page.getByRole('navigation', { name: 'Waymark' });
  await expect(nav.getByRole('link', { name })).toHaveAttribute('href', `/t/${id}`);
  await expect(nav.getByRole('link', { name })).toContainText('ongoing');
  await nav.getByRole('link', { name: 'All trips' }).click();
  await expect(page).toHaveURL(/\/trips$/);
  // On a page the sidebar is a rail: the trip is a dot, and the list is one icon.
  await expect(nav.getByRole('link', { name })).toHaveAttribute('href', `/t/${id}`);
  await expect(nav.getByRole('link', { name: 'All trips' })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await page.goto('/');
  await nav.getByRole('link', { name: 'New trip' }).click();
  await expect(page.getByRole('dialog', { name: 'New trip' })).toBeVisible();
});
