import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { PORTS } from './ports';
import { goOffline, goOnline, mockPosition, signedIn } from './helpers';

/**
 * The timeline and a check-in (DESIGN.md §20.6), in real browsers: a seeded decade scrolls with only the rows in view drawn, the filters give the counts the data has, a check-in opens beside the list on a wide
 * screen and as a page on a narrow one at the same address, and **Edit and Delete work with no network** and reach the server when it is back. The photo viewer is 17.6's.
 */
test.use({ actionTimeout: 15_000 });
expect.configure({ timeout: 15_000 });

const ORIGIN = `http://localhost:${PORTS.app}`;
const accountId = async (page: Page) =>
  (await (await page.request.get('/api/auth/get-session')).json()).user.id as string;

/** Puts places and check-ins in the app's store as the server's rows, as a sync would have, and loads the page again so that it reads them. */
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

/** A decade: `count` check-ins spread over 2016 to 2025 at twenty places in four countries, the same every time. */
function decade(count: number) {
  const countries = ['FR', 'PT', 'JP', 'US'];
  const categories = ['Cafe', 'Park', 'Museum', 'Bar'];
  const places = Array.from({ length: 20 }, (_, i) => ({
    id: `seed-p${i}`,
    name: `Seed Place ${i}`,
    lat: 10,
    lng: 10,
    source: 'manual',
    tz: 'Europe/Lisbon',
    countryCode: countries[i % 4],
    category: categories[i % 4],
    version: 1,
    seq: i + 1,
  }));
  const start = Date.UTC(2016, 0, 1, 12);
  const span = Date.UTC(2025, 11, 31) - start;
  const checkins = Array.from({ length: count }, (_, i) => ({
    id: `seed-c${String(i).padStart(5, '0')}`,
    placeId: `seed-p${i % 20}`,
    at: start + Math.floor((i / count) * span),
    tz: 'Europe/Lisbon',
    offsetMin: 60,
    ...(i % 3 === 0 ? { note: `Seed note ${i}` } : {}),
    companions: [],
    tripId: null,
    linkSource: null,
    share: 'trip',
    source: 'live',
    version: 1,
    seq: 100 + i,
  }));
  return { places, checkins };
}

const rowsInDom = (page: Page) =>
  page.locator('[role=list][aria-label="Check-ins"] [role=listitem] a').count();

test('a decade of check-ins: only the rows in view are drawn, the oldest is reached by scrolling, and the filters give the counts the data has', async ({
  page,
}) => {
  await signedIn(page);
  const data = decade(4000);
  await seed(page, data);
  // The server is shared with the other tests of the run, and what it has of this account arrives with the seed: the total is the seed and what was there.
  const there = (await serverCheckins(page)).length;
  const total = 4000 + there;
  await page.goto('/checkins');
  await expect(page.getByRole('status').filter({ hasText: `${total} check-ins` })).toBeVisible();

  // A handful of rows are in the page, not four thousand.
  const drawn = await rowsInDom(page);
  expect(drawn).toBeGreaterThan(3);
  expect(drawn).toBeLessThan(60);

  // The newest is first (whatever real check-ins the run has made are above the seed), and scrolling to the bottom reaches the oldest, still with a handful drawn.
  await expect(
    page.getByRole('list', { name: 'Check-ins' }).getByRole('link').first(),
  ).toBeVisible();
  const list = page.getByRole('list', { name: 'Check-ins' });
  await list.evaluate((el) => (el.scrollTop = el.scrollHeight));
  await expect(
    page.getByText('Seed Place 19').or(page.getByText('Seed Place 0')).first(),
  ).toBeVisible();
  expect(await rowsInDom(page)).toBeLessThan(60);
  await expect(list.getByText(/Friday,? 1 January 2016/).first()).toBeVisible();

  // Filters are in the query and the counts are the data's.
  const expectedYear = data.checkins.filter(
    (c) => new Date(c.at + c.offsetMin * 60_000).getUTCFullYear() === 2020,
  ).length;
  await page.getByLabel('Year').selectOption('2020');
  await expect(page).toHaveURL(/year=2020/);
  await expect(
    page.getByRole('status').filter({ hasText: `${expectedYear} of ${total} check-ins` }),
  ).toBeVisible();
  const expectedCountry = data.checkins.filter(
    (c) =>
      new Date(c.at + c.offsetMin * 60_000).getUTCFullYear() === 2020 &&
      data.places[Number(c.placeId.slice(6))]?.countryCode === 'JP',
  ).length;
  await page.getByLabel('Country').selectOption('JP');
  await expect(
    page.getByRole('status').filter({ hasText: `${expectedCountry} of ${total} check-ins` }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Clear', exact: true }).click();
  await expect(
    page.getByRole('status').filter({ hasText: new RegExp(`^${total} check-ins$`) }),
  ).toBeVisible();
  await expect(page).not.toHaveURL(/year=/);

  // A search over the place and the note, on the device.
  // Every word of the search has to be in the place's name or the note, in any order, as a substring: counted here the same way, from the data.
  const noted = data.checkins.filter((c) => {
    const text =
      `${data.places[Number(c.placeId.slice(6))]?.name ?? ''} ${(c as { note?: string }).note ?? ''}`.toLowerCase();
    return ['seed', 'note', '300'].every((word) => text.includes(word));
  }).length;
  await page.getByLabel('Search').fill('seed note 300');
  await expect(
    page.getByRole('status').filter({ hasText: `${noted} of ${total} check-ins` }),
  ).toBeVisible();
  await page.getByLabel('Search').fill('zzzz nothing');
  await expect(page.getByText('Nothing matches')).toBeVisible();
  await page.getByRole('button', { name: 'Clear the filters' }).click();
  await expect(
    page.getByRole('status').filter({ hasText: new RegExp(`^${total} check-ins$`) }),
  ).toBeVisible();
});

test('a check-in opens beside the list on a wide screen and as a page on a narrow one, at the same address; a reload keeps it', async ({
  page,
}) => {
  await signedIn(page);
  await seed(page, decade(60));
  await page.goto('/checkins?year=2025');
  const first = page.getByRole('list', { name: 'Check-ins' }).getByRole('link').first();
  await expect(first).toBeVisible();
  const href = await first.getAttribute('href');
  expect(href).toMatch(/^\/c\/seed-c\d+\?year=2025$/);
  await first.click();
  await expect(page).toHaveURL(new RegExp(`${href?.replace('?', '\\?')}$`));
  // Wide: the list is still there, and the check-in is beside it.
  await expect(page.getByRole('article', { name: 'Check-in' })).toBeVisible();
  await expect(page.getByRole('list', { name: 'Check-ins' })).toBeVisible();
  await expect(first).toHaveAttribute('aria-current', 'page');
  // A reload on its address is the same page.
  await page.reload();
  await expect(page.getByRole('article', { name: 'Check-in' })).toBeVisible();
  await expect(page.getByRole('list', { name: 'Check-ins' })).toBeVisible();
  // The back button goes back to the timeline with its filter.
  await page.goBack();
  await expect(page).toHaveURL(/\/checkins\?year=2025$/);

  // Narrow: the same address is a page of its own, with a way back.
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto(href as string);
  await expect(page.getByRole('article', { name: 'Check-in' })).toBeVisible();
  await expect(page.getByRole('list', { name: 'Check-ins' })).toHaveCount(0);
  await page.getByRole('button', { name: '← Check-ins' }).click();
  await expect(page).toHaveURL(/\/checkins\?year=2025$/);
  await expect(page.getByRole('list', { name: 'Check-ins' })).toBeVisible();
});

test('a check-in whose place the page does not hold is a page that says so, with a way back', async ({
  page,
}) => {
  await signedIn(page);
  await page.goto('/c/no-such-checkin');
  await expect(page.getByText('That check-in is not here')).toBeVisible();
  await page.getByRole('button', { name: 'Back to your check-ins' }).click();
  await expect(page).toHaveURL(/\/checkins$/);
});

/** Makes a check-in with a note through the sheet, at a place named for the run, and returns the note. */
async function makeCheckin(page: Page, context: Parameters<typeof mockPosition>[0], note: string) {
  await mockPosition(context, { latitude: 51.5, longitude: -0.12 });
  await page.goto('/checkins?checkin=new');
  const sheet = page.getByRole('dialog', { name: 'Check in' });
  await expect(sheet).toBeVisible();
  await sheet.getByRole('radio', { name: /New place here/ }).check();
  await sheet
    .getByLabel('Name of the new place')
    .fill(`Timeline Corner ${randomUUID().slice(0, 6)}`);
  await sheet.getByLabel('Note').fill(note);
  await sheet.getByRole('button', { name: 'Check in' }).click();
  await expect(sheet).toHaveCount(0);
}
const serverCheckins = async (page: Page) =>
  (
    await (
      await page.request.post('/api/sync', {
        headers: { origin: ORIGIN, 'content-type': 'application/json' },
        data: { protocol: 2, outbox: [], cursor: 0, trips: {}, limit: 500 },
      })
    ).json()
  ).account.checkins as { id: string; note?: string }[];

test('editing a check-in with the network off changes it at once, and the server has the change when the network is back', async ({
  page,
  context,
}) => {
  await signedIn(page);
  const note = `edit me ${randomUUID().slice(0, 8)}`;
  await makeCheckin(page, context, note);
  await page.getByRole('searchbox', { name: 'Search' }).fill(note);
  await page.getByRole('list', { name: 'Check-ins' }).getByRole('link').first().click();
  await expect(page.getByRole('article', { name: 'Check-in' }).getByText(note)).toBeVisible();
  await expect
    .poll(async () => (await serverCheckins(page)).some((c) => c.note === note))
    .toBe(true);

  await goOffline(context);
  await page.getByRole('button', { name: 'Edit' }).click();
  const sheet = page.getByRole('dialog', { name: 'Change check-in' });
  await expect(sheet).toBeVisible();
  // Filled in from the check-in.
  await expect(sheet.getByLabel('Note')).toHaveValue(note);
  const changed = `${note} changed`;
  await sheet.getByLabel('Note').fill(changed);
  // The name is taken when the field is left (the Save button's press leaves it); Enter here was a second way to the same thing, and in one browser it was also a way to submit the form before Save was pressed.
  await sheet.getByLabel('With…').fill('Ada');
  await sheet.getByRole('button', { name: 'Save' }).click();
  await expect(sheet).toHaveCount(0);
  await expect(page.getByRole('article', { name: 'Check-in' }).getByText(changed)).toBeVisible();
  await expect(
    page
      .getByRole('article', { name: 'Check-in' })
      .getByRole('list', { name: 'With' })
      .getByText('Ada'),
  ).toBeVisible();
  expect((await serverCheckins(page)).some((c) => c.note === changed)).toBe(false);

  await goOnline(context);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect
    .poll(async () => (await serverCheckins(page)).some((c) => c.note === changed))
    .toBe(true);
});

test('saving a change that is nothing says so, and the moment can be corrected on the clock where it was made', async ({
  page,
  context,
}) => {
  await signedIn(page);
  const note = `moment ${randomUUID().slice(0, 8)}`;
  await makeCheckin(page, context, note);
  await page.getByRole('searchbox', { name: 'Search' }).fill(note);
  await page.getByRole('list', { name: 'Check-ins' }).getByRole('link').first().click();
  await page.getByRole('button', { name: 'Edit' }).click();
  const sheet = page.getByRole('dialog', { name: 'Change check-in' });
  await sheet.getByRole('button', { name: 'Save' }).click();
  await expect(sheet.getByText('Nothing was changed.')).toBeVisible();
  const past = new Date(Date.now() - 3 * 86_400_000).toISOString().slice(0, 10);
  await sheet.getByLabel('Date', { exact: true }).fill(past);
  await sheet.getByLabel('Time', { exact: true }).fill('09:15');
  await sheet.getByRole('button', { name: 'Save' }).click();
  await expect(sheet).toHaveCount(0);
  await expect(page.getByRole('article', { name: 'Check-in' }).getByText(/09:15 \(/)).toBeVisible();
});

test('deleting a check-in with the network off asks first, removes it at once, and the server loses it when the network is back', async ({
  page,
  context,
}) => {
  await signedIn(page);
  const note = `delete me ${randomUUID().slice(0, 8)}`;
  await makeCheckin(page, context, note);
  await page.getByRole('searchbox', { name: 'Search' }).fill(note);
  await page.getByRole('list', { name: 'Check-ins' }).getByRole('link').first().click();
  await expect
    .poll(async () => (await serverCheckins(page)).find((c) => c.note === note)?.id)
    .toBeDefined();
  const id = (await serverCheckins(page)).find((c) => c.note === note)?.id;

  await goOffline(context);
  await page.getByRole('button', { name: 'Delete' }).click();
  // Asked first: keeping it keeps it.
  await page.getByRole('dialog').getByRole('button', { name: 'Keep it' }).click();
  await expect(page.getByRole('article', { name: 'Check-in' })).toBeVisible();
  await page.getByRole('button', { name: 'Delete' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete' }).click();
  await expect(page).toHaveURL(/\/checkins/);
  await expect(page.getByText('Nothing matches')).toBeVisible();
  expect((await serverCheckins(page)).some((c) => c.id === id)).toBe(true);

  await goOnline(context);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect.poll(async () => (await serverCheckins(page)).some((c) => c.id === id)).toBe(false);
});
