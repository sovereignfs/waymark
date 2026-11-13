import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { PORTS } from './ports';
import { signedIn } from './helpers';

/**
 * A trip's Files and links (DESIGN.md §10.6, §10.7, §20.10), in real browsers: a file is added by choosing it, kept by day and kind, opened from its own address, renamed, moved to a day and deleted after asking; and the trip's links
 * are added (Expenses in Tally first), changed and taken away from the Overview, `https` only. The Follower, who has no Files, is in `e2e/trip.spec.ts`.
 */
test.use({ viewport: { width: 1280, height: 900 }, actionTimeout: 15_000 });
expect.configure({ timeout: 15_000 });

const ORIGIN = `http://localhost:${PORTS.app}`;
const day = (offset: number) =>
  new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

async function op<T = Record<string, unknown>>(page: Page, body: Record<string, unknown>) {
  const reply = await page.request.post('/api/ops', { headers: { origin: ORIGIN }, data: body });
  expect(reply.ok()).toBe(true);
  const json = (await reply.json()) as { ok: boolean } & T;
  expect(json.ok).toBe(true);
  return json;
}

async function makeTrip(page: Page, prefix: string) {
  const { trip } = await op<{ trip: { id: string } }>(page, {
    op: 'trip.create',
    name: `${prefix} ${randomUUID().slice(0, 6)}`,
  });
  await op(page, {
    op: 'stop.add',
    tripId: trip.id,
    place: { name: 'Lisbon', lat: 38.72, lng: -9.14, tz: 'Europe/Lisbon', source: 'manual' },
    arrive: day(5),
    depart: day(6),
  });
  return trip.id;
}

const PDF = Buffer.from(
  '%PDF-1.4\n1 0 obj<<>>endobj\nBOOKING REFERENCE ABC123\ntrailer<<>>\n%%EOF\n',
);
// A 1x1 PNG.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

test('a file is added, opened, renamed, moved to a day and deleted after asking', async ({
  page,
}) => {
  await signedIn(page);
  const tripId = await makeTrip(page, 'Files');
  await page.goto(`/t/${tripId}?view=files`);
  await expect(page.getByRole('heading', { name: 'No files yet' })).toBeVisible();

  // Choosing a file starts the form with its name as the title.
  await page
    .locator('input[type="file"]')
    .setInputFiles({ name: 'flight-booking.pdf', mimeType: 'application/pdf', buffer: PDF });
  const form = page.getByRole('form', { name: 'Add a file' });
  await expect(form.getByLabel('Title')).toHaveValue('flight-booking');
  await form.getByLabel('Title').fill('Flight to Lisbon');
  await form.getByLabel('Kind').selectOption('booking');
  await form.getByRole('button', { name: 'Add the file' }).click();

  const row = page.locator('[data-file]').filter({ hasText: 'Flight to Lisbon' });
  await expect(row).toBeVisible();
  await expect(row).toContainText('Booking');
  await expect(row).toContainText('PDF');
  await expect(page.getByRole('region', { name: 'On the trip' })).toContainText('Flight to Lisbon');

  // It opens from its own address, as a PDF, and is not a page.
  const href = (await row
    .getByRole('link', { name: 'Open Flight to Lisbon' })
    .getAttribute('href')) as string;
  expect(href).toMatch(/^\/api\/media\//);
  await expect(row.getByRole('link', { name: 'Open Flight to Lisbon' })).toHaveAttribute(
    'target',
    '_blank',
  );
  const served = await page.request.get(href);
  expect(served.status()).toBe(200);
  expect(served.headers()['content-type']).toBe('application/pdf');
  expect(served.headers()['content-security-policy']).toContain('sandbox');
  expect((await served.body()).toString()).toContain('BOOKING REFERENCE ABC123');

  // An image has a thumbnail.
  await page
    .locator('input[type="file"]')
    .setInputFiles({ name: 'ticket.png', mimeType: 'image/png', buffer: PNG });
  await form.getByLabel('Kind').selectOption('ticket');
  await form.getByRole('button', { name: 'Add the file' }).click();
  const image = page.locator('[data-file]').filter({ hasText: 'ticket' });
  await expect(image).toContainText('Image');
  await expect(image.locator('img')).toHaveAttribute('src', /\/api\/media\//);

  // Renamed and put on a day: the group changes with it.
  await row.getByRole('button', { name: 'Edit Flight to Lisbon' }).click();
  const edit = page.getByRole('dialog', { name: 'Change the file' });
  await edit.getByLabel('Title').fill('Flight home');
  await edit.getByLabel('On').selectOption({ index: 1 });
  await edit.getByRole('button', { name: 'Save' }).click();
  const moved = page.locator('[data-file]').filter({ hasText: 'Flight home' });
  await expect(moved).toBeVisible();
  await expect(
    page
      .getByRole('region', { name: /Lisbon/ })
      .locator('[data-file]')
      .filter({ hasText: 'Flight home' }),
  ).toBeVisible();

  // Deleting asks first; keeping it keeps it; deleting takes the file away.
  await moved.getByRole('button', { name: 'Delete Flight home' }).click();
  await page
    .getByRole('dialog', { name: 'Delete this file?' })
    .getByRole('button', { name: 'Keep it' })
    .click();
  await expect(moved).toBeVisible();
  await moved.getByRole('button', { name: 'Delete Flight home' }).click();
  await page.getByRole('button', { name: 'Delete the file' }).click();
  await expect(page.locator('[data-file]').filter({ hasText: 'Flight home' })).toHaveCount(0);
  expect((await page.request.get(href)).status()).toBe(404);
});

test('a file that is not a PDF or a picture is refused with a sentence, and nothing is added', async ({
  page,
}) => {
  await signedIn(page);
  const tripId = await makeTrip(page, 'Refuse');
  await page.goto(`/t/${tripId}?view=files`);
  await page.locator('input[type="file"]').setInputFiles({
    name: 'notes.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from('<html><script>alert(1)</script></html>'),
  });
  const form = page.getByRole('form', { name: 'Add a file' });
  await form.getByRole('button', { name: 'Add the file' }).click();
  await expect(form.getByRole('alert')).toBeVisible();
  await expect(page.locator('[data-file]')).toHaveCount(0);
});

test('links are added with Expenses in Tally first, changed and taken away; only https is taken', async ({
  page,
}) => {
  await signedIn(page);
  const tripId = await makeTrip(page, 'Links');
  await page.goto(`/t/${tripId}`);
  const links = page.getByRole('region', { name: 'Links' });

  await links.getByRole('button', { name: 'Add a link' }).click();
  const dialog = page.getByRole('dialog', { name: 'Add a link' });
  await dialog.getByLabel('Kind').selectOption('other');
  await dialog.getByLabel('Address').fill('http://insecure.example.org/x');
  await dialog.getByLabel('Title').fill('Booking');
  await dialog.getByRole('button', { name: 'Add the link' }).click();
  await expect(dialog.getByRole('alert')).toContainText('https');
  await dialog.getByLabel('Address').fill('https://booking.example.org/trip');
  await dialog.getByRole('button', { name: 'Add the link' }).click();
  await expect(dialog).toHaveCount(0);

  // Tally is offered first, and with no title it is called what it is.
  await links.getByRole('button', { name: 'Add Expenses in Tally' }).click();
  const tally = page.getByRole('dialog', { name: 'Add a link' });
  await expect(tally.getByLabel('Kind')).toHaveValue('tally');
  await tally.getByLabel('Address').fill('https://tally.example.org/groups/42');
  await tally.getByRole('button', { name: 'Add the link' }).click();
  await expect(tally).toHaveCount(0);
  const anchors = links.getByRole('link');
  await expect(anchors.first()).toHaveText('Expenses in Tally');
  await expect(anchors.first()).toHaveAttribute('href', 'https://tally.example.org/groups/42');
  await expect(anchors.nth(1)).toHaveText('Booking');
  // Once there is one, it is not offered again.
  await expect(links.getByRole('button', { name: 'Add Expenses in Tally' })).toHaveCount(0);

  // Changed, then taken away after asking.
  await links.getByRole('button', { name: 'Change Booking' }).click();
  const change = page.getByRole('dialog', { name: 'Change the link' });
  await change.getByLabel('Title').fill('Hotel booking');
  await change.getByRole('button', { name: 'Save' }).click();
  await expect(links.getByRole('link', { name: 'Hotel booking' })).toBeVisible();
  await links.getByRole('button', { name: 'Remove Hotel booking' }).click();
  await page
    .getByRole('dialog', { name: 'Remove this link?' })
    .getByRole('button', { name: 'Keep it' })
    .click();
  await expect(links.getByRole('link', { name: 'Hotel booking' })).toBeVisible();
  await links.getByRole('button', { name: 'Remove Hotel booking' }).click();
  await page.getByRole('button', { name: 'Remove the link' }).click();
  await expect(links.getByRole('link', { name: 'Hotel booking' })).toHaveCount(0);
  await expect(links.getByRole('link', { name: 'Expenses in Tally' })).toBeVisible();
});
