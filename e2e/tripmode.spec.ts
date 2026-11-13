import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { PORTS } from './ports';
import { mockClock, mockPosition, signedIn } from './helpers';

/**
 * Trip Mode (DESIGN.md §14.2), in a real browser **on a mocked clock and position**: on the second day of a trip in Lisbon at ten in the morning, the screen shows the right day, the next item with its countdown, the day's items on a
 * map and in a list, _Directions_, _Done_, and _Check in_ filled in with the next item's place and the trip, after which the item is done in the journal and the next one is next. And what it says when the trip is not on, or the person is
 * not going.
 */
test.use({
  viewport: { width: 390, height: 844 },
  timezoneId: 'Europe/Lisbon',
  actionTimeout: 15_000,
});
expect.configure({ timeout: 20_000 });

const ORIGIN = `http://localhost:${PORTS.app}`;
// 10:00 in Lisbon on the 11th of June (UTC+1).
const NOW = '2026-06-11T09:00:00Z';

async function op<T = Record<string, unknown>>(page: Page, body: Record<string, unknown>) {
  const reply = await page.request.post('/api/ops', { headers: { origin: ORIGIN }, data: body });
  expect(reply.ok()).toBe(true);
  return (await reply.json()) as { ok: boolean } & T;
}
const place = (name: string, lat: number, lng: number) => ({
  name,
  lat,
  lng,
  tz: 'Europe/Lisbon',
  source: 'manual',
});

async function makeTrip(page: Page, name: string, arrive: string, depart: string, ready = true) {
  const { trip } = await op<{ trip: { id: string } }>(page, { op: 'trip.create', name });
  await op(page, {
    op: 'stop.add',
    tripId: trip.id,
    place: place('Lisbon', 38.72, -9.14),
    arrive,
    depart,
  });
  if (ready) await op(page, { op: 'trip.ready', tripId: trip.id });
  return trip.id;
}

test('on the second day at ten: the right day, the next item and its countdown, Directions, Done, and a check-in that links to the trip and makes the item done', async ({
  page,
  context,
}) => {
  await signedIn(page);
  const tag = randomUUID().slice(0, 6);
  const name = `Lisbon ${tag}`;
  const tripId = await makeTrip(page, name, '2026-06-10', '2026-06-12');
  const plan = await op<{ plan: { stops: { days: { id: string; date: string }[] }[] } }>(page, {
    op: 'trip.plan',
    tripId,
  });
  const second = plan.plan.stops[0]?.days.find((d) => d.date === '2026-06-11')?.id;
  await op(page, {
    op: 'item.add',
    tripId,
    dayId: second,
    title: 'Breakfast',
    start: '09:30',
    place: place(`Pastelaria ${tag}`, 38.716, -9.139),
  });
  await op(page, {
    op: 'item.add',
    tripId,
    dayId: second,
    title: 'Tram 28',
    start: '14:00',
    place: place(`Elétrico ${tag}`, 38.713, -9.134),
  });
  await op(page, {
    op: 'item.add',
    tripId,
    dayId: second,
    title: 'Dinner',
    start: '19:00',
    fixed: true,
    place: place(`Tasca ${tag}`, 38.711, -9.13),
  });

  await mockClock(page, NOW);
  await mockPosition(context, { latitude: 38.715, longitude: -9.137 });
  await page.goto('/trips');
  await expect(page.locator(`[data-trip="${tripId}"]`)).toBeVisible();
  await page.goto(`/t/${tripId}/today`);

  // The right day, and the map with the day's items numbered and the person's position.
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Lisbon · day 2');
  const map = page.getByRole('region', { name: 'Today on the map' });
  await expect(map).toBeVisible();
  await expect(map.getByRole('button', { name: /^1\. Breakfast/ })).toBeVisible();
  await expect(map.getByRole('button', { name: /^2\. Tram 28/ })).toBeVisible();
  await expect(map.getByRole('button', { name: /^3\. Dinner/ })).toBeVisible();
  await expect(map.getByLabel('Your position')).toBeVisible();

  // Next: the first item not done that starts after now (Breakfast, at 09:30, has passed and was not done), with its countdown.
  const next = page.getByRole('region', { name: 'Next' });
  await expect(next).toContainText('Tram 28');
  await expect(next).toContainText('in 4 h');
  // Directions: the device's own maps (here a desktop browser's, so OpenStreetMap), at the item's point.
  await expect(next.getByRole('link', { name: 'Directions' })).toHaveAttribute(
    'href',
    /^https:\/\/www\.openstreetmap\.org\/directions\?route=/,
  );

  // The items in plan order, and Done on one, which the person's mark makes done without a check-in.
  await expect(page.locator('[data-item]')).toHaveCount(3);
  const breakfast = page.locator('[data-item]').filter({ hasText: 'Breakfast' });
  await expect(breakfast).toHaveAttribute('data-done', 'false');
  await breakfast.getByRole('button', { name: 'Done: Breakfast' }).click();
  await expect(breakfast).toHaveAttribute('data-done', 'true');
  await breakfast.getByRole('button', { name: 'Not done: Breakfast' }).click();
  await expect(breakfast).toHaveAttribute('data-done', 'false');

  // Check in from Next: the item's place is on offer, first and chosen, and the trip is the item's.
  await next.getByRole('button', { name: 'Check in' }).click();
  const sheet = page.getByRole('dialog', { name: 'Check in' });
  await expect(sheet).toBeVisible();
  const chosen = sheet.getByRole('radio', { name: new RegExp(`Elétrico ${tag}`) });
  await expect(chosen).toBeChecked();
  await expect(sheet.getByText('from the plan')).toBeVisible();
  const note = `tram ${tag}`;
  await sheet.getByLabel('Note').fill(note);
  await sheet.getByRole('button', { name: 'Check in' }).click();
  await expect(sheet).toHaveCount(0);

  // The check-in is of the trip, and the item is done in the journal: it says so, and the next one is next.
  const tram = page.locator('[data-item]').filter({ hasText: 'Tram 28' });
  await expect(tram).toHaveAttribute('data-done', 'true');
  await expect(tram).toContainText('Checked in');
  await expect(next).toContainText('Dinner');
  await expect(next).toContainText('in 9 h');
  await expect
    .poll(async () => {
      const reply = await page.request.post('/api/sync', {
        headers: { origin: ORIGIN, 'content-type': 'application/json' },
        data: { protocol: 2, outbox: [], cursor: 0, trips: {}, limit: 500 },
      });
      const rows = (await reply.json()).account.checkins as {
        note?: string;
        tripId?: string | null;
      }[];
      return rows.find((r) => r.note === note)?.tripId;
    })
    .toBe(tripId);
});

test('when the trip is not on, or is not ready, it says so, with a way to the plan', async ({
  page,
}) => {
  await signedIn(page);
  await mockClock(page, NOW);
  const before = await makeTrip(
    page,
    `Later ${randomUUID().slice(0, 6)}`,
    '2026-07-01',
    '2026-07-03',
  );
  const after = await makeTrip(
    page,
    `Over ${randomUUID().slice(0, 6)}`,
    '2026-05-01',
    '2026-05-03',
  );
  const planning = await makeTrip(
    page,
    `Planning ${randomUUID().slice(0, 6)}`,
    '2026-06-10',
    '2026-06-12',
    false,
  );
  await page.goto('/trips');
  await expect(page.locator(`[data-trip="${planning}"]`)).toBeVisible();

  await page.goto(`/t/${before}/today`);
  await expect(page.getByRole('heading', { name: 'The trip starts on 1 July 2026' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Open the plan' })).toHaveAttribute(
    'href',
    `/t/${before}?view=plan`,
  );
  await page.goto(`/t/${after}/today`);
  await expect(page.getByRole('heading', { name: 'The trip ended on 3 May 2026' })).toBeVisible();
  await page.goto(`/t/${planning}/today`);
  await expect(
    page.getByRole('heading', { name: 'Trip Mode needs a trip that is ready' }),
  ).toBeVisible();
  await page.goto(`/t/${'nope'}/today`);
  await expect(page.getByRole('heading', { name: 'This trip is not here' })).toBeVisible();
});
