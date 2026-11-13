import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { PORTS } from './ports';
import { signedIn } from './helpers';

/**
 * Phase 2 at a phone's width (DESIGN.md §20.12), in a real browser: every journey of the trips works at 375 px with touch, **on the same addresses** as at any other width. The footer has Trips; a trip has a way back to the list;
 * its views are tabs; the plan is **one day at a time with the stops above**; an item, a stop and an invitation open as full-screen sheets; and **no page is wider than the screen**. (WebKit, which this was meant to be run in too, is
 * not installed on this machine: see the epic.)
 */
test.use({
  viewport: { width: 375, height: 812 },
  hasTouch: true,
  isMobile: true,
  actionTimeout: 15_000,
});
expect.configure({ timeout: 15_000 });

const ORIGIN = `http://localhost:${PORTS.app}`;
const day = (offset: number) =>
  new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
const place = (name: string, lat: number, lng: number) => ({
  name,
  lat,
  lng,
  tz: 'Europe/Lisbon',
  source: 'manual',
});

async function op<T = Record<string, unknown>>(page: Page, body: Record<string, unknown>) {
  const reply = await page.request.post('/api/ops', { headers: { origin: ORIGIN }, data: body });
  expect(reply.ok()).toBe(true);
  const json = (await reply.json()) as { ok: boolean } & T;
  expect(json.ok).toBe(true);
  return json;
}

/** Nothing is wider than the screen: no horizontal scroll of the page. */
async function fits(page: Page) {
  const wider = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(wider, 'the page is wider than the screen').toBeLessThanOrEqual(0);
}

test('the footer has Trips, a trip has a way back, and the views are tabs that fit', async ({
  page,
}) => {
  await signedIn(page);
  const name = `Phone ${randomUUID().slice(0, 6)}`;
  const { trip } = await op<{ trip: { id: string } }>(page, { op: 'trip.create', name });
  await op(page, {
    op: 'stop.add',
    tripId: trip.id,
    place: place('Lisbon', 38.72, -9.14),
    arrive: day(5),
    depart: day(7),
  });

  // The footer: Trips is there, goes to the list, and is the current place.
  await page.goto('/');
  const footer = page
    .getByRole('navigation')
    .filter({ has: page.getByRole('link', { name: 'Trips' }) })
    .last();
  await expect(footer.getByRole('link', { name: 'Map' })).toBeVisible();
  await footer.getByRole('link', { name: 'Trips' }).click();
  await expect(page).toHaveURL(/\/trips$/);
  await expect(footer.getByRole('link', { name: 'Trips' })).toHaveAttribute('aria-current', 'page');
  await fits(page);

  // The list: a card, and the New trip dialog as a sheet.
  await expect(page.locator('[data-status]').filter({ hasText: name })).toBeVisible();
  await page.getByRole('button', { name: 'New trip' }).first().click();
  const sheet = page.getByRole('dialog', { name: 'New trip' });
  await expect(sheet).toBeVisible();
  await sheet.getByRole('button', { name: 'Cancel' }).click();
  await expect(sheet).toHaveCount(0);

  // Into the trip, the way back to the list, and then each view by its tab.
  await page.locator('[data-status]').filter({ hasText: name }).getByRole('link', { name }).click();
  await expect(page.getByRole('heading', { level: 1, name })).toBeVisible();
  await fits(page);
  const tabs = page.getByRole('navigation', { name: 'Views of the trip' });
  for (const view of ['Plan', 'Map', 'Journal', 'Files', 'People', 'Overview']) {
    await tabs.getByRole('link', { name: view }).click();
    await expect(tabs.getByRole('link', { name: view })).toHaveAttribute('aria-current', 'page');
    await fits(page);
  }
  await page
    .getByRole('link', { name: 'Trips' })
    .filter({ hasText: /^\s*Trips\s*$/ })
    .first()
    .click();
  await expect(page).toHaveURL(/\/trips$/);
});

test('the plan is one day at a time with the stops above, and an item is made and moved in a sheet', async ({
  page,
}) => {
  await signedIn(page);
  const { trip } = await op<{ trip: { id: string } }>(page, {
    op: 'trip.create',
    name: `Plan ${randomUUID().slice(0, 6)}`,
  });
  await op(page, {
    op: 'stop.add',
    tripId: trip.id,
    place: place('Lisbon', 38.72, -9.14),
    arrive: day(5),
    depart: day(8),
  });
  await op(page, {
    op: 'stop.add',
    tripId: trip.id,
    place: place('Sintra', 38.8, -9.38),
    arrive: day(8),
    depart: day(9),
  });
  const plan = await op<{
    plan: { stops: { place: { name: string }; days: { id: string; date: string }[] }[] };
  }>(page, { op: 'trip.plan', tripId: trip.id });
  const days = plan.plan.stops.find((s) => s.place.name === 'Lisbon')?.days ?? [];
  await op(page, { op: 'item.add', tripId: trip.id, dayId: days[1]?.id, title: 'Alfama walk' });
  await page.goto(`/t/${trip.id}?view=plan`);

  // The stops are above; one day is drawn, and the chips choose which.
  await expect(page.getByRole('button', { name: /^Lisbon/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Sintra/ })).toBeVisible();
  const chips = page.getByRole('navigation', { name: 'Days of the stop' });
  await expect(chips.getByRole('button')).toHaveCount(4);
  await expect(page.locator('[data-day]:visible')).toHaveCount(1);
  await expect(page.locator(`[data-day="${days[0]?.id}"]`)).toBeVisible();
  await chips.getByRole('button').nth(1).click();
  await expect(page).toHaveURL(new RegExp(`day=${days[1]?.id}`));
  await expect(page.locator('[data-day]:visible')).toHaveCount(1);
  await expect(page.locator(`[data-day="${days[1]?.id}"]`)).toContainText('Alfama walk');
  await fits(page);

  // An item is made in a sheet, and moved with the buttons (no drag is needed on a phone).
  await page
    .locator(`[data-day="${days[1]?.id}"]`)
    .getByRole('button', { name: 'Add an item' })
    .click();
  const sheet = page.getByRole('dialog', { name: 'Add an item' });
  await sheet.getByLabel('Title').fill('Pastelaria');
  await sheet.getByRole('button', { name: 'Add' }).click();
  await expect(sheet).toHaveCount(0);
  const rows = page.locator(`[data-day="${days[1]?.id}"]`).getByRole('listitem');
  await expect(rows).toHaveText([/Alfama walk/, /Pastelaria/]);
  await page.getByRole('button', { name: 'Move Pastelaria up' }).click();
  await expect(rows).toHaveText([/Pastelaria/, /Alfama walk/]);
  await fits(page);

  // Another stop is another set of days, and the chosen day goes with the stop.
  await page.getByRole('button', { name: /^Sintra/ }).click();
  await expect(page.locator('[data-day]:visible')).toHaveCount(1);
  await expect(page.locator(`[data-day="${days[1]?.id}"]`)).toHaveCount(0);

  // A stop is added in a sheet.
  await page.getByRole('button', { name: 'Add a stop' }).click();
  await expect(page.getByRole('dialog', { name: 'Add a stop' })).toBeVisible();
  await page
    .getByRole('dialog', { name: 'Add a stop' })
    .getByRole('button', { name: 'Cancel' })
    .click();
});

test('the map, the journal, the files and the people work at a phone’s width, and an invitation can be made', async ({
  page,
}) => {
  await signedIn(page);
  const { trip } = await op<{ trip: { id: string } }>(page, {
    op: 'trip.create',
    name: `Views ${randomUUID().slice(0, 6)}`,
  });
  await op(page, {
    op: 'stop.add',
    tripId: trip.id,
    place: place('Lisbon', 38.72, -9.14),
    arrive: day(-3),
    depart: day(-1),
  });
  const plan = await op<{ plan: { stops: { days: { id: string }[] }[] } }>(page, {
    op: 'trip.plan',
    tripId: trip.id,
  });
  await op(page, {
    op: 'item.add',
    tripId: trip.id,
    dayId: plan.plan.stops[0]?.days[0]?.id,
    title: 'Castelo',
    place: place('Castelo', 38.7139, -9.1335),
  });

  // The map: its list is there, and a row can be chosen.
  await page.goto(`/t/${trip.id}?view=map`);
  await expect(
    page.getByRole('list', { name: 'On the map' }).getByRole('button').first(),
  ).toBeVisible();
  await page.getByRole('list', { name: 'On the map' }).getByRole('button').first().click();
  await expect(
    page.getByRole('list', { name: 'On the map' }).getByRole('button').first(),
  ).toHaveAttribute('aria-pressed', 'true');
  await fits(page);

  // The journal reads a day that has passed.
  await page.goto(`/t/${trip.id}?view=journal`);
  await expect(page.locator('[data-sentence]').first()).toContainText('planned');
  await fits(page);

  // The files: a file is added by choosing it.
  await page.goto(`/t/${trip.id}?view=files`);
  await page.locator('input[type="file"]').setInputFiles({
    name: 'ticket.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n'),
  });
  await page
    .getByRole('form', { name: 'Add a file' })
    .getByRole('button', { name: 'Add the file' })
    .click();
  await expect(page.locator('[data-file]').filter({ hasText: 'ticket' })).toBeVisible();
  await fits(page);

  // The people: an invitation is made in a sheet, with its link and its QR code, and then it is waiting.
  await page.goto(`/t/${trip.id}?view=people`);
  await page.getByRole('button', { name: 'Invite' }).click();
  const invite = page.getByRole('dialog', { name: 'Invite someone' });
  await invite.getByRole('button', { name: 'Make the invitation' }).click();
  const made = page.getByRole('dialog', { name: 'Invitation made' });
  const link = await made.getByLabel('The invitation link').inputValue();
  await expect(made.getByRole('img', { name: 'The invitation link as a QR code' })).toBeVisible();
  await made.getByRole('button', { name: 'Done' }).click();
  await expect(page.getByRole('region', { name: 'Waiting to join' })).toContainText(
    'Anyone with the link',
  );
  await fits(page);

  // The page of the invitation is a page at this width too.
  await page.goto(new URL(link).pathname);
  await expect(page.getByRole('button', { name: 'Join the trip' })).toBeVisible();
  await fits(page);
});
