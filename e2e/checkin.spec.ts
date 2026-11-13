import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import sharp from 'sharp';
import { PORTS } from './ports';
import { goOffline, goOnline, mockPosition, signedIn } from './helpers';

/**
 * Checking in (DESIGN.md §9.2, §20.5), in real browsers, on an instance whose place search is the fake of `src/places/fake.ts` (a few real places, answered as Nominatim answers, reaching nothing): each way of
 * checking in with the position mocked, offline with the position alone, another time on the place's clock, a refused position, photos and companions, and the keyboard alone.  _On the map_ chooses a point on the app's own map.
 */
const ORIGIN = `http://localhost:${PORTS.app}`;
const TOKYO = { latitude: 35.6586, longitude: 139.7454 }; // at Tokyo Tower, which the fake knows

// Four browsers' worth of instances share one machine in `pnpm e2e:fast`, and WebKit takes the address changes of the history API late when it is busy: a wait of fifteen seconds is for that, and a failure is still a failure.
test.use({ actionTimeout: 15_000 });
expect.configure({ timeout: 15_000 });

const sheet = (page: Page) => page.getByRole('dialog', { name: 'Check in' });

interface Place {
  id: string;
  name: string;
  source: string;
  sourceId?: string;
  category?: string;
  tz: string | null;
}
interface Checkin {
  id: string;
  placeId: string;
  at: number;
  tz: string;
  note?: string;
  companions: string[];
  photos?: string[];
  source: string;
}
/** What the server has of the account, asked as the page would. */
async function server(page: Page): Promise<{ places: Place[]; checkins: Checkin[] }> {
  const reply = await page.request.post('/api/sync', {
    headers: { origin: ORIGIN, 'content-type': 'application/json' },
    data: { protocol: 2, outbox: [], cursor: 0, trips: {}, limit: 500 },
  });
  const body = (await reply.json()).account;
  return { places: body.places, checkins: body.checkins };
}
const checkinWith = async (page: Page, note: string) =>
  (await server(page)).checkins.find((c) => c.note === note);

async function open(page: Page, path = '/') {
  await page.goto(`${path}${path.includes('?') ? '&' : '?'}checkin=new`);
  await expect(sheet(page)).toBeVisible();
}
const unique = (what: string) => `${what} ${randomUUID().slice(0, 8)}`;

test('Here, with the position allowed: a new place by name, then the same place by search, which is one place and two check-ins', async ({
  page,
  context,
}) => {
  await signedIn(page);
  await mockPosition(context, { latitude: 51.5, longitude: -0.12 }); // nowhere the fake knows
  await open(page);
  // The device allows the position already, so Here is the first way and is read without asking.
  await expect(sheet(page).getByRole('radio', { name: 'Here', exact: true })).toBeChecked();
  await sheet(page)
    .getByRole('radio', { name: /New place here/ })
    .check();
  const name = unique('Zxq Corner');
  await sheet(page).getByLabel('Name of the new place').fill(name);
  const first = unique('first');
  await sheet(page).getByLabel('Note').fill(first);
  await sheet(page).getByRole('button', { name: 'Check in' }).click();
  await expect(sheet(page)).toHaveCount(0);
  await expect(page.getByText('Checked in')).toBeVisible();
  await expect.poll(() => checkinWith(page, first)).toBeDefined();
  const made = await checkinWith(page, first);
  const place = (await server(page)).places.find((p) => p.name === name);
  expect(place).toMatchObject({ name, source: 'manual', tz: 'Europe/London' });
  expect(made).toMatchObject({ placeId: place?.id, source: 'live' });

  // Again, by search: the person's own place, offered first, and it is the same place.
  await open(page);
  await sheet(page).getByRole('radio', { name: 'Search', exact: true }).click();
  await sheet(page).getByLabel('Search for a place').fill('zxq corner');
  const second = unique('second');
  await sheet(page).getByLabel('Note').fill(second);
  await expect(sheet(page).getByRole('radio', { name: new RegExp(name) })).toBeVisible();
  await sheet(page)
    .getByRole('radio', { name: new RegExp(name) })
    .check();
  await sheet(page).getByRole('button', { name: 'Check in' }).click();
  await expect(sheet(page)).toHaveCount(0);
  await expect.poll(() => checkinWith(page, second)).toBeDefined();
  expect((await checkinWith(page, second))?.placeId).toBe(place?.id);
  expect((await server(page)).places.filter((p) => p.name === name)).toHaveLength(1);
});

test('Here, at a place the search knows: it is offered, and checking in at it makes a place with what the search knew', async ({
  page,
  context,
}) => {
  await signedIn(page);
  await mockPosition(context, TOKYO);
  await open(page);
  await sheet(page)
    .getByRole('radio', { name: /Tokyo Tower/ })
    .check();
  const note = unique('tower');
  await sheet(page).getByLabel('Note').fill(note);
  await sheet(page).getByRole('button', { name: 'Check in' }).click();
  await expect.poll(() => checkinWith(page, note)).toBeDefined();
  const place = (await server(page)).places.find(
    (p) => p.id === (null as never) || p.sourceId === 'way/100001',
  );
  expect(place).toMatchObject({
    name: 'Tokyo Tower',
    source: 'osm',
    sourceId: 'way/100001',
    category: 'Tower',
    tz: 'Asia/Tokyo',
  });
});

test('Search: the place search’s places, and Enter checks in at the first when none is chosen', async ({
  page,
}) => {
  await signedIn(page);
  await open(page);
  const search = sheet(page).getByLabel('Search for a place');
  await expect(search).toBeFocused();
  await search.fill('central');
  await expect(sheet(page).getByRole('radio', { name: /Café Central/ })).toBeVisible();
  const note = unique('central');
  await sheet(page).getByLabel('Note').fill(note);
  await search.focus();
  await page.keyboard.press('Enter');
  await expect(sheet(page)).toHaveCount(0);
  await expect.poll(() => checkinWith(page, note)).toBeDefined();
  expect((await server(page)).places.find((p) => p.sourceId === 'node/100003')).toMatchObject({
    name: 'Café Central',
    category: 'Cafe',
  });
});

test('with the network off, a check-in by position alone is saved on the device, and goes when the network is back', async ({
  page,
  context,
}) => {
  await signedIn(page);
  // Sydney, to a street's width: the server is shared with every other test of the run (and with the other browser's run of this one), so this point is this run's alone.
  const latitude = -33.8688 - Math.floor(Math.random() * 900) / 10000;
  const longitude = 151.2093 + Math.floor(Math.random() * 900) / 10000;
  await mockPosition(context, { latitude, longitude });
  const near = `A place near ${latitude.toFixed(4)}, ${longitude.toFixed(4)}`;
  await open(page);
  await goOffline(context);
  await sheet(page).getByRole('radio', { name: near }).check();
  const note = unique('offline');
  await sheet(page).getByLabel('Note').fill(note);
  await sheet(page).getByRole('button', { name: 'Check in' }).click();
  await expect(sheet(page)).toHaveCount(0);
  // It is on the device, and the server does not have it.
  await page.waitForTimeout(1200);
  await goOnline(context);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect.poll(() => checkinWith(page, note)).toBeDefined();
  const made = await checkinWith(page, note);
  const place = (await server(page)).places.find((p) => p.id === made?.placeId);
  expect(place?.name).toBe(near);
  expect(place?.tz).toBe('Australia/Sydney');
});

test('with the network off, the person’s own places are still searched, and the sheet says the place search needs a connection', async ({
  page,
  context,
}) => {
  await signedIn(page);
  await mockPosition(context, { latitude: 51.5, longitude: -0.12 });
  await open(page);
  await sheet(page)
    .getByRole('radio', { name: /New place here/ })
    .check();
  const name = unique('Offline Corner');
  await sheet(page).getByLabel('Name of the new place').fill(name);
  await sheet(page).getByRole('button', { name: 'Check in' }).click();
  await expect(sheet(page)).toHaveCount(0);
  await goOffline(context);
  // The sheet opens with no network: it is the address changing in the page, which asks the server for nothing.
  await page
    .getByRole('navigation', { name: 'Waymark' })
    .getByRole('link', { name: /^Check in\b/ })
    .click();
  await expect(sheet(page)).toBeVisible();
  await sheet(page).getByRole('radio', { name: 'Search', exact: true }).click();
  await sheet(page).getByLabel('Search for a place').fill('offline corner');
  await expect(sheet(page).getByRole('radio', { name: new RegExp(name) })).toBeVisible();
  await expect(
    sheet(page).getByText('Place search needs a connection. Your own places are still here.'),
  ).toBeVisible();
  await goOnline(context);
});

test('another time: on the place’s clock in its zone, never in the future', async ({
  page,
  context,
}) => {
  await signedIn(page);
  await mockPosition(context, TOKYO);
  await open(page);
  await sheet(page)
    .getByRole('radio', { name: /Tokyo Tower/ })
    .check();
  await sheet(page).getByRole('button', { name: 'Another time' }).click();
  await expect(
    sheet(page).getByText(/On the clock where the place is \(Asia\/Tokyo\)/),
  ).toBeVisible();
  const note = unique('earlier');
  await sheet(page).getByLabel('Note').fill(note);

  // Tomorrow is refused, with the sentence, and the sheet stays.
  const tomorrow = new Date(Date.now() + 36 * 3600_000).toISOString().slice(0, 10);
  await sheet(page).getByLabel('Date').fill(tomorrow);
  await sheet(page).getByLabel('Time').fill('10:00');
  await sheet(page).getByRole('button', { name: 'Check in' }).click();
  await expect(sheet(page).getByText("A check-in can't be in the future.")).toBeVisible();
  await expect(sheet(page)).toBeVisible();

  // A day in the past is the place's 23:59 of that day, whatever the device's zone.
  const past = new Date(Date.now() - 5 * 86400_000).toISOString().slice(0, 10);
  await sheet(page).getByLabel('Date').fill(past);
  await sheet(page).getByLabel('Time').fill('23:59');
  await sheet(page).getByRole('button', { name: 'Check in' }).click();
  await expect(sheet(page)).toHaveCount(0);
  await expect.poll(() => checkinWith(page, note)).toBeDefined();
  const made = (await checkinWith(page, note)) as Checkin;
  expect(made).toMatchObject({ tz: 'Asia/Tokyo', source: 'manual' });
  const local = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Tokyo',
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(made.at);
  expect(local).toBe(`${past} 23:59`);
});

test('a position that is refused removes Here, with a sentence, and searching still works', async ({
  page,
}) => {
  await signedIn(page);
  await open(page);
  // No permission was given to this context: asking is refused.
  await sheet(page).getByRole('radio', { name: 'Here', exact: true }).click();
  await expect(
    sheet(page).getByText(/Waymark cannot use your position here, so Here is not offered/),
  ).toBeVisible();
  await expect(sheet(page).getByRole('radio', { name: 'Here', exact: true })).toHaveCount(0);
  const search = sheet(page).getByLabel('Search for a place');
  await search.fill('lisbon');
  await expect(sheet(page).getByRole('radio', { name: /Sé de Lisboa/ })).toBeVisible();
  // And without a position there is no way to make a place or a point: only places that exist.
  await expect(sheet(page).getByRole('radio', { name: /New place here/ })).toHaveCount(0);
});

test('a note, companions and photos: kept with the check-in, and the photos reach the server', async ({
  page,
  context,
  browserName,
}) => {
  await signedIn(page);
  await mockPosition(context, { latitude: 51.5, longitude: -0.12 });
  await open(page);
  await sheet(page)
    .getByRole('radio', { name: /New place here/ })
    .check();
  await sheet(page).getByLabel('Name of the new place').fill(unique('Photo Corner'));
  const note = unique('with photos');
  await sheet(page).getByLabel('Note').fill(note);
  const companions = sheet(page).getByLabel('With…');
  await companions.fill('Ada');
  await page.keyboard.press('Enter');
  await companions.fill('Grace');
  await page.keyboard.press('Enter');
  const png = await sharp({
    create: { width: 16, height: 12, channels: 3, background: { r: 200, g: 80, b: 40 } },
  })
    .png()
    .toBuffer();
  await sheet(page)
    .locator('input[type=file]')
    .setInputFiles([
      { name: 'one.png', mimeType: 'image/png', buffer: png },
      { name: 'two.png', mimeType: 'image/png', buffer: png },
    ]);
  await expect(
    sheet(page).getByRole('list', { name: 'Photos to add' }).getByRole('listitem'),
  ).toHaveCount(2);
  await sheet(page).getByRole('button', { name: 'Remove two.png' }).click();
  await expect(
    sheet(page).getByRole('list', { name: 'Photos to add' }).getByRole('listitem'),
  ).toHaveCount(1);
  await sheet(page).getByRole('button', { name: 'Check in' }).click();
  await expect(sheet(page)).toHaveCount(0);
  await expect.poll(() => checkinWith(page, note)).toBeDefined();
  const made = (await checkinWith(page, note)) as Checkin;
  expect(made.companions).toEqual(['Ada', 'Grace']);
  expect(made.photos).toHaveLength(1);
  await expect
    .poll(async () => (await page.request.get(`/api/media/${made.photos?.[0]}`)).status())
    .toBe(200);

  // On the check-in's page the photo is a thumbnail that opens the design system's viewer, which closes by Escape and gives the focus back.
  await page.goto(`/c/${made.id}`);
  const thumb = page.getByRole('button', { name: /Photo 1 of 1/ });
  await expect(thumb).toBeVisible();
  await thumb.click();
  const viewer = page.getByRole('dialog', { name: 'Photos' });
  await expect(viewer).toBeVisible();
  await expect(viewer.locator('img').first()).toHaveAttribute('src', /\/api\/media\//);
  await page.keyboard.press('Escape');
  await expect(viewer).toHaveCount(0);
  // Safari does not focus a button that was clicked, so there is no focus to give back there.
  if (browserName !== 'webkit') await expect(thumb).toBeFocused();
});

test('the keyboard alone: C opens it, typing searches, Enter checks in', async ({ page }) => {
  await signedIn(page);
  await page.goto('/places');
  await page.locator('body').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('c');
  await expect(sheet(page)).toBeVisible();
  await expect(sheet(page).getByLabel('Search for a place')).toBeFocused();
  await page.keyboard.type('sé de');
  await expect(sheet(page).getByRole('radio', { name: /Sé de Lisboa/ })).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(sheet(page)).toHaveCount(0);
  await expect
    .poll(async () => (await server(page)).places.some((p) => p.sourceId === 'relation/100004'))
    .toBe(true);
});

test('at a phone’s width the same way of checking in works in the drawer', async ({ page }) => {
  await signedIn(page);
  await page.setViewportSize({ width: 375, height: 812 });
  await open(page, '/map');
  await sheet(page).getByLabel('Search for a place').fill('central park');
  await expect(sheet(page).getByRole('radio', { name: /Central Park/ })).toBeVisible();
  const note = unique('phone');
  await sheet(page).getByLabel('Note').fill(note);
  await sheet(page)
    .getByRole('radio', { name: /Central Park/ })
    .check();
  await sheet(page).getByRole('button', { name: 'Check in' }).click();
  await expect(sheet(page)).toHaveCount(0);
  await expect.poll(() => checkinWith(page, note)).toBeDefined();
});

test('On the map: a point is chosen by a click, a place is named there, and the check-in is at the point', async ({
  page,
  context,
}) => {
  await signedIn(page);
  // The map opens where the position is; the point chosen is the middle of it, which a click on the map's middle chooses.
  await mockPosition(context, { latitude: 51.5, longitude: -0.12 });
  await open(page, '/checkins');
  const how = sheet(page).getByRole('radiogroup', { name: 'How to find the place' });
  await expect(how.getByRole('radio', { name: 'On the map' })).toBeVisible();
  await how.getByRole('radio', { name: 'On the map' }).click();
  const map = sheet(page).getByRole('region', { name: 'Choose a point on the map' });
  await expect(map).toBeVisible();
  const box = (await map.boundingBox()) as { x: number; y: number; width: number; height: number };
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  // A new place there is offered (and any of the person's own places near it).
  await expect(sheet(page).getByRole('radio', { name: /New place here/ })).toBeVisible();
  await sheet(page)
    .getByRole('radio', { name: /New place here/ })
    .check();
  const name = unique('Map Corner');
  await sheet(page).getByLabel('Name of the new place').fill(name);
  const note = unique('on the map');
  await sheet(page).getByLabel('Note').fill(note);
  await sheet(page).getByRole('button', { name: 'Check in' }).click();
  await expect(sheet(page)).toHaveCount(0);
  await expect
    .poll(async () => (await server(page)).places.some((p) => p.name === name))
    .toBe(true);
  const made = (await server(page)).places.find((p) => p.name === name) as unknown as {
    lat: number;
    lng: number;
  };
  // The point chosen is where the map was centred (the person's position), to within what a click on a map's middle gives.
  expect(Math.abs(made.lat - 51.5)).toBeLessThan(0.02);
  expect(Math.abs(made.lng - -0.12)).toBeLessThan(0.02);
  expect(await checkinWith(page, note)).toBeDefined();
});
