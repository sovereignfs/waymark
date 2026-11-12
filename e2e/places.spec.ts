import { randomUUID } from 'node:crypto';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { PORTS } from './ports';
import { goOffline, goOnline, mockPosition, signedIn } from './helpers';

/**
 * The places (DESIGN.md §20.8), in real browsers: the person's places by how often, a search, a place opening beside the list on a wide screen and as a page on a narrow one at the same address, and **rename, merge and delete
 * that work with no network** and reach the server when it is back.
 */
test.use({ actionTimeout: 15_000 });
expect.configure({ timeout: 15_000 });

const ORIGIN = `http://localhost:${PORTS.app}`;
const accountId = async (page: Page) =>
  (await (await page.request.get('/api/auth/get-session')).json()).user.id as string;

/** Puts places and check-ins in the app's store as the server's rows, as a sync would have. */
async function seed(page: Page, rows: { places: unknown[]; checkins: unknown[] }) {
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
    ({ name, rows }) =>
      new Promise<void>((resolve, reject) => {
        const open = indexedDB.open(name);
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result;
          const tx = db.transaction(['places', 'checkins'], 'readwrite');
          for (const place of rows.places) tx.objectStore('places').put(place);
          for (const checkin of rows.checkins) tx.objectStore('checkins').put(checkin);
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onerror = () => reject(tx.error);
        };
      }),
    { name: `waymark-${id}`, rows },
  );
}

const place = (id: string, name: string, over: Record<string, unknown> = {}) => ({
  id,
  name,
  lat: 10,
  lng: 10,
  source: 'manual',
  tz: 'Europe/Lisbon',
  countryCode: 'PT',
  version: 1,
  seq: 1,
  ...over,
});
const visit = (id: string, placeId: string, at: number) => ({
  id,
  placeId,
  at,
  tz: 'Europe/Lisbon',
  offsetMin: 60,
  companions: [],
  tripId: null,
  linkSource: null,
  share: 'trip',
  source: 'live',
  version: 1,
  seq: 1,
});

const serverPlaces = async (page: Page) =>
  (
    await (
      await page.request.post('/api/sync', {
        headers: { origin: ORIGIN, 'content-type': 'application/json' },
        data: { protocol: 2, outbox: [], cursor: 0, trips: {}, limit: 500 },
      })
    ).json()
  ).account.places as { id: string; name: string; category?: string }[];

/** Checks in at a new place of this name, through the sheet, and waits for the sheet to close. */
async function checkInAt(page: Page, context: BrowserContext, name: string, note = '') {
  await mockPosition(context, { latitude: 51.5, longitude: -0.12 });
  await page.goto('/places?checkin=new');
  const sheet = page.getByRole('dialog', { name: 'Check in' });
  await expect(sheet).toBeVisible();
  await sheet.getByRole('radio', { name: /New place here/ }).check();
  await sheet.getByLabel('Name of the new place').fill(name);
  if (note) await sheet.getByLabel('Note').fill(note);
  await sheet.getByRole('button', { name: 'Check in' }).click();
  await expect(sheet).toHaveCount(0);
}

test('the places by how often, a search, and a place that opens beside the list, at its own address, and as a page on a phone', async ({
  page,
}) => {
  await signedIn(page);
  const tag = `Zq${randomUUID().slice(0, 6)}`;
  const day = 86_400_000;
  const base = Date.UTC(2024, 5, 1, 12);
  await seed(page, {
    places: [
      place('pl-' + tag + 'c', `${tag} Gamma Park`),
      place('pl-' + tag + 'b', `${tag} Beta Bar`, { category: 'Bar' }),
      place('pl-' + tag + 'a', `${tag} Alpha Cafe`, {
        category: 'Cafe',
        address: { city: 'Lisbon', country: 'Portugal' },
      }),
    ],
    checkins: [
      visit(tag + '1', 'pl-' + tag + 'a', base),
      visit(tag + '2', 'pl-' + tag + 'a', base + 10 * day),
      visit(tag + '3', 'pl-' + tag + 'a', base + 20 * day),
      visit(tag + '4', 'pl-' + tag + 'b', base + 5 * day),
    ],
  });
  await page.goto('/places');
  await page.getByRole('searchbox', { name: 'Search' }).fill(tag);
  const list = page.getByRole('list', { name: 'Places' });
  // Most visited first, the one never visited last, with the counts.
  await expect(list.getByRole('link')).toHaveCount(3);
  await expect(list.getByRole('link').nth(0)).toContainText(`${tag} Alpha Cafe`);
  await expect(list.getByRole('link').nth(0)).toContainText('3 visits');
  await expect(list.getByRole('link').nth(1)).toContainText(`${tag} Beta Bar`);
  await expect(list.getByRole('link').nth(1)).toContainText('1 visit');
  await expect(list.getByRole('link').nth(2)).toContainText('0 visits');
  await expect(page.getByRole('status').filter({ hasText: /3 of \d+ places/ })).toBeVisible();

  // The search finds by category and by address too, and says when nothing matches.
  await page.getByRole('searchbox', { name: 'Search' }).fill(`${tag} lisbon`);
  await expect(list.getByRole('link')).toHaveCount(1);
  await page.getByRole('searchbox', { name: 'Search' }).fill(`${tag} nowhere at all`);
  await expect(page.getByText('Nothing matches')).toBeVisible();
  await page.getByRole('searchbox', { name: 'Search' }).fill(tag);

  // A place opens beside the list, keeps the search, and a reload keeps it.
  await list.getByRole('link').nth(0).click();
  await expect(page).toHaveURL(new RegExp(`/places/pl-${tag}a\\?q=${tag}`));
  const article = page.getByRole('article', { name: 'Place' });
  await expect(article.getByRole('heading', { name: `${tag} Alpha Cafe` })).toBeVisible();
  await expect(article.getByText("You've been here 3 times")).toBeVisible();
  await expect(article.getByText(/First on 1 Jun 2024, last on 21 Jun 2024/)).toBeVisible();
  await expect(list.getByRole('link').nth(0)).toHaveAttribute('aria-current', 'page');
  await expect(article.getByRole('button', { name: 'Delete' })).toBeDisabled();
  await expect(article.getByRole('link')).toHaveCount(3);
  await page.reload();
  await expect(page.getByRole('article', { name: 'Place' })).toBeVisible();

  // A check-in of the place opens, and the check-in's page links back to the place.
  await article.getByRole('link').first().click();
  await expect(page).toHaveURL(/\/c\//);
  await page.getByRole('link', { name: `${tag} Alpha Cafe` }).click();
  await expect(page).toHaveURL(new RegExp(`/places/pl-${tag}a`));

  // On a phone it is a page of its own at the same address, with a way back.
  await page.setViewportSize({ width: 375, height: 800 });
  await page.goto(`/places/pl-${tag}a?q=${tag}`);
  await expect(page.getByRole('article', { name: 'Place' })).toBeVisible();
  await expect(page.getByRole('list', { name: 'Places' })).toHaveCount(0);
  await page.getByRole('button', { name: '← Places' }).click();
  await expect(page).toHaveURL(new RegExp(`/places\\?q=${tag}`));
  await expect(page.getByRole('list', { name: 'Places' })).toBeVisible();
});

test('a place that is not here is a page that says so, with a way back', async ({ page }) => {
  await signedIn(page);
  await page.goto('/places/not-a-place-we-hold');
  await expect(page.getByText('That place is not here')).toBeVisible();
  await page.getByRole('button', { name: 'Back to your places' }).click();
  await expect(page).toHaveURL(/\/places$/);
});

test('renaming a place with the network off changes it at once, and the server has the change when the network is back', async ({
  page,
  context,
}) => {
  await signedIn(page);
  const tag = randomUUID().slice(0, 6);
  const before = `Rename Corner ${tag}`;
  const after = `Renamed Corner ${tag}`;
  await checkInAt(page, context, before);
  await expect
    .poll(async () => (await serverPlaces(page)).some((p) => p.name === before))
    .toBe(true);

  await page.getByRole('searchbox', { name: 'Search' }).fill(before);
  await page.getByRole('list', { name: 'Places' }).getByRole('link').first().click();
  await goOffline(context);
  await page.getByRole('button', { name: 'Edit' }).click();
  const dialog = page.getByRole('dialog', { name: 'Edit this place' });
  // Saving nothing says so.
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog.getByRole('alert')).toHaveText('Nothing was changed.');
  await dialog.getByLabel('Name').fill(after);
  await dialog.getByLabel('Category').fill('Corner shop');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(
    page.getByRole('article', { name: 'Place' }).getByRole('heading', { level: 1 }),
  ).toHaveText(after);
  await expect(page.getByRole('article', { name: 'Place' })).toContainText('Corner shop');
  expect((await serverPlaces(page)).some((p) => p.name === after)).toBe(false);

  await goOnline(context);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect
    .poll(async () => (await serverPlaces(page)).find((p) => p.name === after)?.category)
    .toBe('Corner shop');
});

test('merging a place into another moves its check-ins and the count adds up; with the network off, and the server has it when the network is back', async ({
  page,
  context,
}) => {
  await signedIn(page);
  const tag = randomUUID().slice(0, 6);
  const from = `Merge From ${tag}`;
  const into = `Merge Into ${tag}`;
  await checkInAt(page, context, from, `one ${tag}`);
  await checkInAt(page, context, from, `two ${tag}`);
  await checkInAt(page, context, into, `three ${tag}`);
  await expect
    .poll(async () => {
      const places = await serverPlaces(page);
      return [from, into].every((name) => places.some((p) => p.name === name));
    })
    .toBe(true);
  const fromId = (await serverPlaces(page)).find((p) => p.name === from)?.id;

  await page.goto('/places');
  await page.getByRole('searchbox', { name: 'Search' }).fill(tag);
  const list = page.getByRole('list', { name: 'Places' });
  await expect(list.getByRole('link').nth(0)).toContainText(`${from}`);
  await expect(list.getByRole('link').nth(0)).toContainText('2 visits');
  await expect(list.getByRole('link').nth(1)).toContainText('1 visit');
  await list.getByRole('link').nth(0).click();

  await goOffline(context);
  await page.getByRole('button', { name: 'Merge into…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Merge into another place' });
  await expect(dialog.getByRole('button', { name: 'Merge', exact: true })).toBeDisabled();
  await dialog.getByRole('button', { name: 'The place to merge into' }).click();
  await page.getByRole('option', { name: new RegExp(into) }).click();
  await dialog.getByRole('button', { name: 'Merge', exact: true }).click();

  // The page is the other place now, with the three check-ins, and the first is gone from the list.
  const article = page.getByRole('article', { name: 'Place' });
  await expect(article.getByRole('heading', { name: into })).toBeVisible();
  await expect(article.getByText("You've been here 3 times")).toBeVisible();
  await expect(list.getByRole('link')).toHaveCount(1);
  expect((await serverPlaces(page)).some((p) => p.id === fromId)).toBe(true);

  await goOnline(context);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect
    .poll(async () => (await serverPlaces(page)).some((p) => p.id === fromId))
    .toBe(false);
  // A reload from the server's rows says the same.
  await page.reload();
  await expect(
    page.getByRole('article', { name: 'Place' }).getByText("You've been here 3 times"),
  ).toBeVisible();
});

test('a place with no check-in is deleted, asked about first, with the network off', async ({
  page,
  context,
}) => {
  await signedIn(page);
  const tag = randomUUID().slice(0, 6);
  const name = `Delete Corner ${tag}`;
  await checkInAt(page, context, name, `gone ${tag}`);
  await page.goto('/checkins');
  await page.getByRole('searchbox', { name: 'Search' }).fill(`gone ${tag}`);
  await page.getByRole('list', { name: 'Check-ins' }).getByRole('link').first().click();
  await page.getByRole('button', { name: 'Delete' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete' }).click();
  await expect(page.getByText('Nothing matches')).toBeVisible();
  await expect.poll(async () => (await serverPlaces(page)).some((p) => p.name === name)).toBe(true);

  await page.goto('/places');
  await page.getByRole('searchbox', { name: 'Search' }).fill(name);
  await expect(page.getByRole('list', { name: 'Places' }).getByRole('link')).toContainText(
    '0 visits',
  );
  await page.getByRole('list', { name: 'Places' }).getByRole('link').first().click();
  await goOffline(context);
  await page.getByRole('button', { name: 'Delete' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Keep it' }).click();
  await expect(page.getByRole('article', { name: 'Place' })).toBeVisible();
  await page.getByRole('button', { name: 'Delete' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete' }).click();
  await expect(page.getByText('Nothing matches')).toBeVisible();

  await goOnline(context);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect
    .poll(async () => (await serverPlaces(page)).some((p) => p.name === name))
    .toBe(false);
});
