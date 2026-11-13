import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { PORTS } from './ports';
import { mockPosition, signedIn } from './helpers';

/**
 * A check-in and its trip (DESIGN.md §11.3, §12, §20.6), in a real browser: a check-in made on a trip's day, near its stop, **falls into the trip at once** (decided on the device, suggested), can be unlinked and linked by
 * hand (and then it is the person's, and nothing automatic changes it), and has its own word about sharing with the trip's members.
 */
test.use({ actionTimeout: 15_000 });
expect.configure({ timeout: 15_000 });

const ORIGIN = `http://localhost:${PORTS.app}`;
const day = (offset: number) =>
  new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

async function op(page: Page, body: Record<string, unknown>) {
  const reply = await page.request.post('/api/ops', { headers: { origin: ORIGIN }, data: body });
  return (await reply.json()) as { ok: boolean; trip?: { id: string } };
}
async function serverCheckin(page: Page, note: string) {
  const reply = await page.request.post('/api/sync', {
    headers: { origin: ORIGIN, 'content-type': 'application/json' },
    data: { protocol: 2, outbox: [], cursor: 0, trips: {}, limit: 500 },
  });
  const rows = (await reply.json()).account.checkins as {
    id: string;
    note?: string;
    tripId?: string | null;
    linkSource?: string | null;
    share: string;
  }[];
  return rows.find((row) => row.note === note);
}

test('a check-in on a trip’s day falls into it, is unlinked and linked by hand, and says who it is shared with', async ({
  page,
  context,
}) => {
  await signedIn(page);
  const name = `Link ${randomUUID().slice(0, 6)}`;
  const { trip } = await op(page, { op: 'trip.create', name });
  await op(page, {
    op: 'stop.add',
    tripId: trip?.id,
    place: { name: 'London', lat: 51.5, lng: -0.12, tz: 'Europe/London', source: 'manual' },
    arrive: day(-1),
    depart: day(1),
  });
  // The device holds the trip once it has synced.
  await page.goto('/trips');
  await expect(page.locator(`[data-trip="${trip?.id}"]`)).toBeVisible();

  await mockPosition(context, { latitude: 51.5, longitude: -0.12 });
  await page.goto('/checkins?checkin=new');
  const sheet = page.getByRole('dialog', { name: 'Check in' });
  await expect(sheet).toBeVisible();
  await sheet.getByRole('radio', { name: /New place here/ }).check();
  await sheet.getByLabel('Name of the new place').fill(`Link Corner ${randomUUID().slice(0, 6)}`);
  const note = `linked ${randomUUID().slice(0, 6)}`;
  await sheet.getByLabel('Note').fill(note);
  await sheet.getByRole('button', { name: 'Check in' }).click();
  await expect(sheet).toHaveCount(0);

  await expect.poll(() => serverCheckin(page, note)).toBeDefined();
  const made = (await serverCheckin(page, note)) as { id: string };
  await page.goto(`/c/${made.id}`);
  const section = page.getByRole('region', { name: 'Trip' });
  // Fell into the trip, as a suggestion.
  await expect(section).toContainText(`Part of ${name}`);
  await expect(section).toContainText('Suggested');
  expect((await serverCheckin(page, note))?.tripId).toBe(trip?.id);

  // Unlinked by hand: it is the person's now.
  await section.getByRole('button', { name: 'Unlink' }).click();
  await expect(section).toContainText('Not part of a trip');
  await expect.poll(async () => (await serverCheckin(page, note))?.tripId ?? null).toBeNull();
  expect((await serverCheckin(page, note))?.linkSource).toBe('manual');

  // Linked by hand to the trip: it says so, and has a word of its own about sharing.
  await section.getByLabel('Link to a trip').selectOption({ label: name });
  await expect(section).toContainText(`Part of ${name}`);
  await expect(section).toContainText('Linked by you');
  await section.getByLabel('Sharing this check-in').selectOption('on');
  await expect(section).toContainText('Shared with the trip');
  await expect.poll(async () => (await serverCheckin(page, note))?.share).toBe('on');
  await expect.poll(async () => (await serverCheckin(page, note))?.tripId).toBe(trip?.id);

  // Handed back to the app: a suggestion again.
  await section.getByRole('button', { name: 'Let Waymark suggest' }).click();
  await expect(section).toContainText('Suggested');
});
