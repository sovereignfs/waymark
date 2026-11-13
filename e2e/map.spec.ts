import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { signedIn, watchOrigin } from './helpers';

/**
 * The map of everywhere (DESIGN.md §8.2, §20.7), in real browsers: the places the person has checked in at are markers, **the list is the markers**, the timeline's filters narrow both, a place chosen shows its visits and a way to
 * open it, and the map asks no address but this server's.
 */
test.use({ viewport: { width: 1280, height: 900 }, actionTimeout: 15_000 });
expect.configure({ timeout: 20_000 });

const tag = randomUUID().slice(0, 6);
type Seeded = {
  id: string;
  name: string;
  lat: number;
  lng: number;
  countryCode: string;
  category: string;
};
const PLACES: [Seeded, Seeded, Seeded] = [
  {
    id: `mp-lisbon-${tag}`,
    name: `Lisbon Café ${tag}`,
    lat: 38.72,
    lng: -9.14,
    countryCode: 'PT',
    category: 'Cafe',
  },
  {
    id: `mp-tokyo-${tag}`,
    name: `Tokyo Tower ${tag}`,
    lat: 35.66,
    lng: 139.75,
    countryCode: 'JP',
    category: 'Landmark',
  },
  {
    id: `mp-lima-${tag}`,
    name: `Lima Plaza ${tag}`,
    lat: -12.05,
    lng: -77.04,
    countryCode: 'PE',
    category: 'Landmark',
  },
];

async function seed(page: Page) {
  const account = (await (await page.request.get('/api/auth/get-session')).json()).user
    .id as string;
  const places = PLACES.map((p) => ({ ...p, source: 'manual', tz: 'UTC', version: 1, seq: 1 }));
  const visit = (id: string, placeId: string, date: string) => ({
    id: `${id}-${tag}`,
    placeId,
    at: Date.parse(`${date}T12:00:00Z`),
    tz: 'UTC',
    offsetMin: 0,
    companions: [],
    tripId: null,
    linkSource: null,
    share: 'trip',
    source: 'live',
    version: 1,
    seq: 1,
  });
  const checkins = [
    visit('v1', PLACES[0].id, '2024-05-01'),
    visit('v2', PLACES[0].id, '2025-05-01'),
    visit('v3', PLACES[0].id, '2026-05-01'),
    visit('v4', PLACES[1].id, '2025-06-01'),
    visit('v5', PLACES[2].id, '2026-06-01'),
  ];
  await expect
    .poll(() =>
      page.evaluate(
        async () =>
          (await indexedDB.databases()).filter((d) => (d.name ?? '').startsWith('waymark-')).length,
      ),
    )
    .toBe(1);
  await page.evaluate(
    ({ db, places, checkins }) =>
      new Promise<void>((resolve, reject) => {
        const open = indexedDB.open(db);
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const conn = open.result;
          const tx = conn.transaction(['places', 'checkins'], 'readwrite');
          for (const row of places) tx.objectStore('places').put(row);
          for (const row of checkins) tx.objectStore('checkins').put(row);
          tx.oncomplete = () => {
            conn.close();
            resolve();
          };
          tx.onerror = () => reject(tx.error);
        };
      }),
    { db: `waymark-${account}`, places, checkins },
  );
}

test('the places are markers and a list, the filters narrow both, and a place chosen shows its visits', async ({
  page,
}) => {
  const foreign = watchOrigin(page);
  await signedIn(page);
  await page.goto('/map');
  await seed(page);
  await page.goto('/map');

  const list = page.getByRole('list', { name: 'Places on the map' });
  const mine = list.getByRole('button').filter({ hasText: tag });
  await expect(mine).toHaveCount(3);
  // Most visited first: Lisbon has three.
  await expect(mine.first()).toContainText('Lisbon Café');
  await expect(mine.first()).toContainText('3 visits');

  // The markers are the places, each once, saying how often: three far apart are three buttons.
  const markers = page
    .getByRole('region', { name: 'Where you have been' })
    .getByRole('button')
    .filter({ hasText: '' });
  const markerLabels = () =>
    markers.evaluateAll(
      (nodes, t) => nodes.map((n) => n.getAttribute('aria-label')).filter((l) => l?.includes(t)),
      tag,
    );
  await expect.poll(async () => (await markerLabels()).length).toBe(3);
  const labels = await markerLabels();
  expect(labels).toContain(`Lisbon Café ${tag}, 3 visits`);
  expect(labels).toContain(`Tokyo Tower ${tag}, 1 visit`);

  // Choosing a row chooses the place: its visits, its first and last, and a way to open it.
  await mine.first().click();
  const chosen = page.getByRole('region', { name: 'The place chosen' });
  await expect(chosen).toContainText(`Lisbon Café ${tag}`);
  await expect(chosen).toContainText("You've been here 3 times");
  await expect(chosen.getByRole('link', { name: 'Open the place' })).toHaveAttribute(
    'href',
    `/places/${PLACES[0].id}`,
  );
  await expect(chosen.getByRole('link', { name: 'Last check-in' })).toHaveAttribute(
    'href',
    `/c/v3-${tag}`,
  );

  // The timeline's filters are here, in the address: a country leaves its place, and a year its visits.
  await page.getByLabel('Country').selectOption('JP');
  await expect(page).toHaveURL(/country=JP/);
  await expect(mine).toHaveCount(1);
  await expect(mine.first()).toContainText('Tokyo Tower');
  await expect.poll(async () => (await markerLabels()).length).toBe(1);
  await page.getByRole('button', { name: 'Clear' }).click();
  await page.getByLabel('Year').selectOption('2025');
  await expect(mine).toHaveCount(2);
  await expect(list.getByRole('button').filter({ hasText: `Lisbon Café ${tag}` })).toContainText(
    '1 visit',
  );

  // A reload keeps the filter; the map and the list asked nobody but this server.
  await page.reload();
  await expect(page.getByLabel('Year')).toHaveValue('2025');
  expect(foreign()).toEqual([]);
});
