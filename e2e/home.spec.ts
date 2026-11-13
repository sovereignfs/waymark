import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { PORTS } from './ports';
import { signedIn } from './helpers';

/**
 * Home (DESIGN.md §20.4), in real browsers: a new person sees two empty states side by side; someone with check-ins and a trip sees _Now_ (Check in, large), _Next trip_, _Recently_ (the last ten, as links) and the year's
 * figures, **all from the device's store**, with no spinner once it has been read.
 */
test.use({ viewport: { width: 1280, height: 900 }, actionTimeout: 15_000 });
expect.configure({ timeout: 20_000 });

const day = (offset: number) =>
  new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

test('a new person sees Check in where you are and Plan a trip, side by side, with Import from Swarm under the first', async ({
  browser,
}) => {
  // A person of their own, on the instance where sign-up is open (the `both` one), so that the account is new whatever else ran.
  const context = await browser.newContext({
    baseURL: `http://localhost:${PORTS.both}`,
    viewport: { width: 1280, height: 900 },
  });
  const page = await context.newPage();
  try {
    await page.goto('/sign-up');
    await page.getByLabel('Name').fill('Newcomer');
    await page.getByLabel('Email').fill(`new-${randomUUID().slice(0, 6)}@example.com`);
    await page.getByLabel('Password').fill('correct horse battery');
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page.getByRole('button', { name: 'User menu' })).toBeVisible();
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Home' })).toBeVisible();
    const one = page.getByRole('heading', { name: 'Check in where you are' });
    const two = page.getByRole('heading', { name: 'Plan a trip' });
    await expect(one).toBeVisible();
    await expect(two).toBeVisible();
    // Side by side: the same row.
    const a = (await one.boundingBox()) as { y: number };
    const b = (await two.boundingBox()) as { y: number };
    expect(Math.abs(a.y - b.y)).toBeLessThan(20);
    await expect(page.getByRole('link', { name: 'Import from Swarm' })).toHaveAttribute(
      'href',
      '/settings',
    );
    await expect(page.getByRole('link', { name: 'New trip' }).last()).toHaveAttribute(
      'href',
      '/trips?new=1',
    );
    await page.getByRole('button', { name: 'Check in' }).click();
    await expect(page.getByRole('dialog', { name: 'Check in' })).toBeVisible();
  } finally {
    await context.close();
  }
});

async function seed(page: Page, tag: string) {
  const account = (await (await page.request.get('/api/auth/get-session')).json()).user
    .id as string;
  const place = (id: string, name: string, lat: number, lng: number, cc: string) => ({
    id: `${id}-${tag}`,
    name,
    lat,
    lng,
    source: 'manual',
    tz: 'UTC',
    countryCode: cc,
    version: 1,
    seq: 1,
  });
  const places = [
    place('h1', `Home Café ${tag}`, 38.72, -9.14, 'PT'),
    place('h2', `Home Tower ${tag}`, 35.66, 139.75, 'JP'),
  ];
  const checkins = Array.from({ length: 12 }, (_, i) => ({
    id: `hc${i}-${tag}`,
    placeId: places[i % 2]?.id,
    // Newer than anything another test made on this shared account (a day ahead, one minute apart): this is a seed, and Home shows the newest ten.
    at: Date.now() + 86_400_000 + (12 - i) * 60_000,
    tz: 'UTC',
    offsetMin: 0,
    companions: [],
    tripId: null,
    linkSource: null,
    share: 'trip',
    source: 'live',
    version: 1,
    seq: 1,
  }));
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
  return checkins;
}

test('with check-ins and a trip: Now, Next trip, Recently (the last ten) and the figures, from the store', async ({
  page,
}) => {
  await signedIn(page);
  const tag = randomUUID().slice(0, 6);
  // A trip that is ready and starts in a few weeks.
  const origin = `http://localhost:${PORTS.app}`;
  const post = async (data: object) =>
    (await (await page.request.post('/api/ops', { headers: { origin }, data })).json()) as {
      trip: { id: string };
    };
  const name = `Upcoming ${tag}`;
  const { trip } = await post({ op: 'trip.create', name });
  await post({
    op: 'stop.add',
    tripId: trip.id,
    place: { name: 'Kyoto', lat: 35, lng: 135, tz: 'Asia/Tokyo', source: 'manual' },
    arrive: day(23),
    depart: day(26),
  });
  await post({ op: 'trip.ready', tripId: trip.id });
  await page.goto('/trips');
  await expect(page.locator(`[data-trip="${trip.id}"]`)).toBeVisible();
  const made = await seed(page, tag);

  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Home' })).toBeVisible();
  // Now: Check in, large (no trip is on).
  await expect(
    page.getByRole('region', { name: 'Now' }).getByRole('button', { name: 'Check in' }),
  ).toBeVisible();
  // Next trip: its name, dates and how long.
  const next = page.getByRole('region', { name: 'Next trip' });
  await expect(next.getByRole('link', { name })).toHaveAttribute('href', `/t/${trip.id}`);
  await expect(next).toContainText('in 23 days');
  // Recently: ten, newest first, each a link to its check-in.
  const recent = page.getByRole('region', { name: 'Recently' }).getByRole('listitem');
  await expect(recent).toHaveCount(10);
  await expect(recent.first().getByRole('link')).toHaveAttribute('href', `/c/${made[0]?.id}`);
  await expect(recent.first()).toContainText('Home Café');
  // Figures: this year's check-ins, places, countries (the instance has other people's... this account's own too, so at least ours).
  const figures = page.getByRole('region', { name: 'Figures' });
  await expect(figures).toContainText('Check-ins this year');
  await expect(figures.locator('div', { hasText: /^Places\d+$/ })).toBeVisible();
  await expect(figures.locator('div', { hasText: /^Countries\d+$/ })).toBeVisible();
  // The year's map is there, with this server's tiles only.
  await expect(page.getByRole('region', { name: 'Where you have been this year' })).toBeVisible();
});
