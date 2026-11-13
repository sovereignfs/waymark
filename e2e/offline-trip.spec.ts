import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { PORTS } from './ports';
import { goOffline, mockPosition, signedIn } from './helpers';

/**
 * A trip with no network (DESIGN.md §14.5), in a real browser: _Download for offline_ keeps the map around the trip's stops in the service worker's cache of public map files, Trip Mode and its map then draw **with the network off**,
 * Settings says what is kept, and removing it takes it away. The tiles are the one public thing the worker keeps beyond the shell.
 */
test.use({ viewport: { width: 390, height: 844 }, actionTimeout: 20_000 });
expect.configure({ timeout: 20_000 });

const ORIGIN = `http://localhost:${PORTS.app}`;
const day = (offset: number) =>
  new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

async function op<T = Record<string, unknown>>(page: Page, body: Record<string, unknown>) {
  const reply = await page.request.post('/api/ops', { headers: { origin: ORIGIN }, data: body });
  expect(reply.ok()).toBe(true);
  return (await reply.json()) as { ok: boolean } & T;
}

async function workerKept(page: Page) {
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => true));
  await expect
    .poll(async () =>
      page.evaluate(async () => {
        for (const name of (await caches.keys()).filter((n) => n.startsWith('waymark-shell-')))
          if (await (await caches.open(name)).match('/shell')) return true;
        return false;
      }),
    )
    .toBe(true);
}

test('the map around the stops is downloaded, Trip Mode draws with no network, Settings says what is kept, and it can be removed', async ({
  page,
  context,
}) => {
  await signedIn(page);
  const name = `Offline ${randomUUID().slice(0, 6)}`;
  const { trip } = await op<{ trip: { id: string } }>(page, { op: 'trip.create', name });
  await op(page, {
    op: 'stop.add',
    tripId: trip.id,
    place: { name: 'Lisbon', lat: 38.7223, lng: -9.1393, tz: 'Europe/Lisbon', source: 'manual' },
    arrive: day(-2),
    depart: day(3),
  });
  const plan = await op<{ plan: { stops: { days: { id: string }[] }[] } }>(page, {
    op: 'trip.plan',
    tripId: trip.id,
  });
  for (const d of plan.plan.stops[0]?.days ?? [])
    await op(page, {
      op: 'item.add',
      tripId: trip.id,
      dayId: d.id,
      title: 'Sé',
      place: {
        name: 'Sé de Lisboa',
        lat: 38.7099,
        lng: -9.1329,
        tz: 'Europe/Lisbon',
        source: 'manual',
      },
    });
  await op(page, { op: 'trip.ready', tripId: trip.id });
  await mockPosition(context, { latitude: 38.7223, longitude: -9.1393 });

  await page.goto(`/t/${trip.id}`);
  await workerKept(page);
  const offline = page.getByRole('region', { name: 'Offline' });
  await expect(offline.getByRole('button', { name: 'Download for offline' })).toBeVisible();
  await offline.getByRole('button', { name: 'Download for offline' }).click();
  await expect(offline).toContainText('The map around the stops is kept on this device', {
    timeout: 60_000,
  });

  // The worker has it: the style, the glyphs and the tiles around the stop, and nothing of anyone's.
  const kept = await page.evaluate(async () => {
    const cache = await caches.open('waymark-tiles-v1');
    return (await cache.keys()).map((request) => new URL(request.url).pathname);
  });
  expect(kept).toContain('/api/map/style/light.json');
  expect(kept).toContain('/api/map/tiles/14/7776/6277');
  expect(kept.every((path) => path.startsWith('/api/map/'))).toBe(true);
  expect(kept.length).toBeLessThanOrEqual(604);

  // Settings says what is kept.
  await page.goto('/settings?section=device');
  await expect(page.getByRole('heading', { name: 'Maps kept for offline' })).toBeVisible();
  await expect(page.getByText(/map files?, /)).toBeVisible();

  // With the network off, Trip Mode and its map draw: the style and the tile around the stop come from the worker.
  await page.goto(`/t/${trip.id}/today`);
  await expect(page.getByRole('region', { name: 'Today on the map' })).toBeVisible();
  await workerKept(page);
  const tileStatuses: number[] = [];
  page.on('response', (r) => {
    if (/\/api\/map\/tiles\/\d+\/\d+\/\d+$/.test(r.url())) tileStatuses.push(r.status());
  });
  await goOffline(context);
  await page.goto(`/t/${trip.id}/today`);
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Lisbon');
  const map = page.getByRole('region', { name: 'Today on the map' });
  await expect(map).toBeVisible();
  await expect(map.getByRole('button', { name: /^1\. Sé/ })).toBeVisible();
  await expect.poll(() => tileStatuses.length).toBeGreaterThan(0);
  // Every tile the map asked for with no network came from the worker's cache (a tile that was not kept would be a 503, a gap).
  expect(tileStatuses.filter((status) => status !== 200 && status !== 204)).toEqual([]);
  await context.setOffline(false);

  // Removed: it is gone from the worker and the trip offers the download again.
  await page.goto(`/t/${trip.id}`);
  await page
    .getByRole('region', { name: 'Offline' })
    .getByRole('button', { name: 'Remove from this device' })
    .click();
  await expect(
    page
      .getByRole('region', { name: 'Offline' })
      .getByRole('button', { name: 'Download for offline' }),
  ).toBeVisible();
  await expect
    .poll(async () =>
      page.evaluate(async () => (await (await caches.open('waymark-tiles-v1')).keys()).length),
    )
    .toBe(0);
});
