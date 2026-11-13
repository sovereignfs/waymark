import { expect, test, type Page } from '@playwright/test';
import { goOffline, signedIn } from './helpers';

/**
 * Opening offline (DESIGN.md §20.12; 6.4), in real browsers: after one visit, with the network off, Home, Check-ins, a check-in, Map, Places and a place **open with the person's data** (the worker answers
 * them with the one shell page, which finds who is signed in on the device and reads its store), every other address says it needs a connection, and **none of the person's data is in the worker's cache**.
 */
test.use({ viewport: { width: 1280, height: 800 }, actionTimeout: 15_000 });
expect.configure({ timeout: 15_000 });

const PLACE = 'Offline Test Cafe';
const NOTE = 'Seen with no network at all';

const accountId = async (page: Page) =>
  (await (await page.request.get('/api/auth/get-session')).json()).user.id as string;

/** Puts one place and one check-in in the device's store, as a sync would have, and loads the page again so that it reads them. */
async function seed(page: Page) {
  const id = await accountId(page);
  await expect
    .poll(() =>
      page.evaluate(
        async () =>
          (await indexedDB.databases())
            .map((d) => d.name ?? '')
            .filter((n) => n.startsWith('waymark-')).length,
      ),
    )
    .toBe(1);
  await page.evaluate(
    ({ name, place, checkin }) =>
      new Promise<void>((resolve, reject) => {
        const open = indexedDB.open(name);
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result;
          const tx = db.transaction(['places', 'checkins'], 'readwrite');
          tx.objectStore('places').put(place);
          tx.objectStore('checkins').put(checkin);
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onerror = () => reject(tx.error);
        };
      }),
    {
      name: `waymark-${id}`,
      place: {
        id: 'offline-p1',
        name: PLACE,
        lat: 38.7,
        lng: -9.1,
        source: 'manual',
        tz: 'Europe/Lisbon',
        countryCode: 'PT',
        category: 'Cafe',
        version: 1,
        seq: 1,
      },
      checkin: {
        id: 'offline-c1',
        placeId: 'offline-p1',
        at: Date.UTC(2026, 3, 4, 12),
        tz: 'Europe/Lisbon',
        offsetMin: 60,
        note: NOTE,
        companions: [],
        tripId: null,
        linkSource: null,
        share: 'trip',
        source: 'live',
        version: 1,
        seq: 2,
      },
    },
  );
  await page.reload();
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

test('after one visit, with no network, each of the app’s screens opens with the person’s data, and the cache holds none of it', async ({
  page,
  context,
}) => {
  await signedIn(page);
  await page.goto('/checkins');
  await seed(page);
  // Opened by its own address: the lists may hold much else (the account is shared by the other specs), but a check-in's page is its own.
  await page.goto('/c/offline-c1');
  await expect(page.getByText(NOTE).first()).toBeVisible();
  await workerKept(page);
  // One visit to each, with the worker in control, so that everything they need is kept.
  for (const path of ['/', '/map', '/places', '/places/offline-p1', '/c/offline-c1'])
    await page.goto(path);
  // The identity is on the device, for the shell to find.
  expect(await page.evaluate(() => window.localStorage.getItem('waymark.me'))).toContain(
    'owner@example.com',
  );

  await goOffline(context);

  await page.goto('/checkins');
  await expect(page.getByRole('list', { name: 'Check-ins' })).toBeVisible();
  await page.goto('/c/offline-c1');
  await expect(page.getByText(NOTE).first()).toBeVisible();
  await expect(page.getByText(PLACE).first()).toBeVisible();
  await page.goto('/places');
  await expect(page.getByRole('list', { name: 'Places' }).first()).toBeVisible();
  await page.goto('/places/offline-p1');
  await expect(page.getByText(PLACE).first()).toBeVisible();
  await page.goto('/map');
  // The map's tiles are the server's, so with no network the list is what is there: the person's places are in it (the style may still come from the browser's cache, and the tiles do not).
  await expect(
    page.getByRole('list', { name: 'Places on the map' }).getByText(PLACE),
  ).toBeVisible();
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Home' })).toBeVisible();
  // The account menu is the person's, from the device.
  await expect(page.getByRole('button', { name: 'User menu' })).toBeVisible();

  // What needs a network says so.
  await page.goto('/settings');
  await expect(page.getByRole('heading', { name: 'This needs a connection' })).toBeVisible();
  await page.goto('/notifications');
  await expect(page.getByRole('heading', { name: 'This needs a connection' })).toBeVisible();

  // And nothing of the person is in any cache: not the place, the note, nor their address.
  const cached = await page.evaluate(async () => {
    const texts: string[] = [];
    for (const name of await caches.keys()) {
      const cache = await caches.open(name);
      for (const request of await cache.keys()) {
        const response = await cache.match(request);
        if (response)
          texts.push(new URL(request.url).pathname + '\n' + (await response.clone().text()));
      }
    }
    return texts.join('\n');
  });
  for (const secret of [PLACE, NOTE, 'owner@example.com', 'offline-c1', 'offline-p1'])
    expect(cached, secret).not.toContain(secret);
});

test('with no one signed in on the device, the shell says to sign in, which needs a connection', async ({
  page,
  context,
}) => {
  await signedIn(page);
  await page.goto('/checkins');
  await workerKept(page);
  await page.evaluate(() => window.localStorage.removeItem('waymark.me'));
  await goOffline(context);
  await page.goto('/checkins');
  await expect(page.getByText('Sign in to use Waymark')).toBeVisible();
});
