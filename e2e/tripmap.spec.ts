import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { PORTS } from './ports';
import { signedIn, watchOrigin } from './helpers';

/**
 * A trip's map (DESIGN.md §8.2, §20.10), in real browsers: the whole trip is its stops in order, a day is its items in plan order and numbered, **the list is the markers**, the map asks nobody but this server for anything, and the
 * map can stand beside the plan.
 */
test.use({ viewport: { width: 1280, height: 900 }, actionTimeout: 15_000 });
expect.configure({ timeout: 20_000 });

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
const place = (name: string, lat: number, lng: number) => ({
  name,
  lat,
  lng,
  tz: 'Europe/Lisbon',
  source: 'manual',
});

async function makeTrip(page: Page) {
  const { trip } = await op<{ trip: { id: string } }>(page, {
    op: 'trip.create',
    name: `Map ${randomUUID().slice(0, 6)}`,
  });
  await op(page, {
    op: 'stop.add',
    tripId: trip.id,
    place: place('Lisbon', 38.72, -9.14),
    arrive: day(5),
    depart: day(7),
  });
  await op(page, {
    op: 'stop.add',
    tripId: trip.id,
    place: place('Sintra', 38.8, -9.38),
    arrive: day(7),
    depart: day(8),
  });
  const plan = await op<{ plan: { stops: { place: { name: string }; days: { id: string }[] }[] } }>(
    page,
    { op: 'trip.plan', tripId: trip.id },
  );
  const lisbonDay = plan.plan.stops.find((s) => s.place.name === 'Lisbon')?.days[0]?.id as string;
  // Added in an order that is not the order they are shown in: the timed one goes first by its time.
  await op(page, {
    op: 'item.add',
    tripId: trip.id,
    dayId: lisbonDay,
    title: 'Dinner',
    start: '19:30',
    place: place('Bairro Alto', 38.713, -9.145),
  });
  await op(page, {
    op: 'item.add',
    tripId: trip.id,
    dayId: lisbonDay,
    title: 'Wander',
    place: place('Alfama', 38.711, -9.13),
  });
  await op(page, {
    op: 'item.add',
    tripId: trip.id,
    dayId: lisbonDay,
    title: 'Breakfast',
    start: '08:30',
    place: place('Pastelaria', 38.716, -9.139),
  });
  await op(page, { op: 'item.add', tripId: trip.id, dayId: lisbonDay, title: 'Call home' });
  return { tripId: trip.id, lisbonDay };
}

test('the whole trip is its stops in order, a day is its items in plan order, and the list is the markers', async ({
  page,
}) => {
  const foreign = watchOrigin(page);
  await signedIn(page);
  const { tripId, lisbonDay } = await makeTrip(page);
  await page.goto(`/t/${tripId}?view=map`);

  const markers = page.getByRole('region', { name: 'The trip on the map' }).getByRole('button');
  const list = page.getByRole('list', { name: 'On the map' }).getByRole('button');
  // The stops in order, numbered; the list says the same.
  await expect(markers).toHaveCount(2);
  await expect(list).toHaveText([/1\. Lisbon/, /2\. Sintra/]);
  await expect(markers.nth(0)).toHaveAttribute('aria-label', '1. Lisbon');
  await expect(markers.nth(1)).toHaveAttribute('aria-label', '2. Sintra');

  // One day: its items, numbered, in plan order (the timed ones by their time), and the one without a place only in the list.
  await page.getByLabel('Show').selectOption(lisbonDay);
  await expect(page).toHaveURL(new RegExp(`day=${lisbonDay}`));
  const dayMarkers = page.getByRole('region', { name: 'The day on the map' }).getByRole('button');
  await expect(dayMarkers).toHaveCount(3);
  const labels = await dayMarkers.evaluateAll((nodes) =>
    nodes.map((n) => n.getAttribute('aria-label')),
  );
  expect(labels).toEqual(['1. Breakfast', '2. Wander', '3. Dinner']);
  await expect(list).toHaveText([/1\. Breakfast/, /2\. Wander/, /3\. Dinner/, /Call home/]);
  await expect(list.last()).toContainText('not on the map');
  // The list is the markers: the numbered rows say exactly what the markers say, in the same order.
  const numbered = await list.evaluateAll((nodes) =>
    nodes
      .map((n) => n.querySelector('span')?.textContent?.trim() ?? '')
      .filter((t) => /^\d\. /.test(t)),
  );
  expect(numbered).toEqual(labels);

  // Choosing a row selects it.
  await list.nth(1).click();
  await expect(list.nth(1)).toHaveAttribute('aria-pressed', 'true');

  // A reload keeps the day; the map asked nobody but this server.
  await page.reload();
  await expect(page.getByLabel('Show')).toHaveValue(lisbonDay);
  await expect(dayMarkers).toHaveCount(3);
  expect(foreign()).toEqual([]);
});

test('the map can stand beside the plan, and the address keeps it', async ({ page }) => {
  await signedIn(page);
  const { tripId } = await makeTrip(page);
  await page.goto(`/t/${tripId}?view=plan`);
  const toggle = page.getByRole('button', { name: 'Map beside the plan' });
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByRole('list', { name: 'On the map' })).toHaveCount(0);
  await toggle.click();
  await expect(page).toHaveURL(/beside=map/);
  await expect(page.getByRole('list', { name: 'On the map' })).toBeVisible();
  await expect(page.getByRole('heading', { level: 2, name: 'Lisbon' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('list', { name: 'On the map' })).toBeVisible();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await toggle.click();
  await expect(page.getByRole('list', { name: 'On the map' })).toHaveCount(0);
});
