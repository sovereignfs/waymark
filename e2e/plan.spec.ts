import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { PORTS } from './ports';
import { goOffline, goOnline, signedIn } from './helpers';

/**
 * The Plan (DESIGN.md §20.10), in real browsers: a trip planned from nothing with the keyboard alone, an item edited with no network (a clock until the server has it), an item dragged to another day, a stop shortened
 * over days that have items (the server refuses and the screen offers to move or delete them), and a Follower, who is given none of the controls.
 */
test.use({ viewport: { width: 1280, height: 900 }, actionTimeout: 15_000 });
expect.configure({ timeout: 15_000 });

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

const lisbon = (name: string) => ({
  name,
  lat: 38.72,
  lng: -9.14,
  tz: 'Europe/Lisbon',
  source: 'manual',
});

/** The place search is limited per account and the suite shares one, so the dialogs are given a search of their own; `e2e/checkin.spec.ts` asks the real one. */
async function stubSearch(page: Page) {
  await page.route('**/api/places?**', (route) =>
    route.fulfill({
      json: {
        status: 'ok',
        found: [
          {
            name: 'Lisbon',
            lat: 38.72,
            lng: -9.14,
            category: 'city',
            source: 'osm',
            sourceId: 'relation/5400890',
          },
        ],
      },
    }),
  );
}

/** A trip with stops dated around today, and its days by date: `[{ stop, days: [{ id, date }] }]`. */
async function makeTrip(page: Page, name: string, stops: [string, number, number][]) {
  const created = await op<{ trip: { id: string } }>(page, { op: 'trip.create', name });
  const tripId = created.trip.id;
  for (const [place, from, to] of stops)
    await op(page, {
      op: 'stop.add',
      tripId,
      place: lisbon(place),
      arrive: day(from),
      depart: day(to),
    });
  const plan = await op<{
    plan: { stops: { place: { name: string }; days: { id: string; date: string }[] }[] };
  }>(page, { op: 'trip.plan', tripId });
  return { tripId, stops: plan.plan.stops };
}

test('a trip is planned from nothing with the keyboard alone', async ({ page }) => {
  await signedIn(page);
  await stubSearch(page);
  const { trip } = await op<{ trip: { id: string } }>(page, {
    op: 'trip.create',
    name: `Keys ${randomUUID().slice(0, 6)}`,
  });
  await page.goto(`/t/${trip.id}?view=plan`);
  await expect(page.getByRole('heading', { name: 'No stops yet' })).toBeVisible();

  // Add a stop: the button by the keyboard, the place by typing and choosing, the dates by the calendar's keys.
  await page.getByRole('button', { name: 'Add a stop' }).focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Add a stop' });
  await dialog.getByLabel('Place').fill('Lisbon');
  await dialog.getByRole('list', { name: 'Places found' }).getByRole('button').first().focus();
  await page.keyboard.press('Enter');
  await expect(dialog.getByText('Place:')).toBeVisible();
  await dialog.getByRole('button', { name: 'Arrival and departure' }).focus();
  await page.keyboard.press('Enter');
  // The calendar opens beside the field; Tab reaches its grid, whose keys are its own.
  await expect(page.getByRole('grid')).toBeVisible();
  const inGrid = () =>
    page.evaluate(() => document.activeElement?.closest('[role="grid"]') !== null);
  for (let i = 0; i < 6 && !(await inGrid()); i++) await page.keyboard.press('Tab');
  expect(await inGrid()).toBe(true);
  await page.keyboard.press('Enter');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('grid')).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Add the stop' }).focus();
  await page.keyboard.press('Enter');
  await expect(dialog).toHaveCount(0);

  // The stop and its three days are there.
  await expect(page.getByRole('heading', { level: 2, name: 'Lisbon' })).toBeVisible();
  await expect(page.locator('[data-day]')).toHaveCount(3);

  // An item on the first day, by the keyboard.
  const first = page.locator('[data-day]').first();
  await first.getByRole('button', { name: 'Add an item' }).focus();
  await page.keyboard.press('Enter');
  const item = page.getByRole('dialog', { name: 'Add an item' });
  await item.getByLabel('Title').fill('Pastéis de Belém');
  await page.keyboard.press('Enter');
  await expect(item).toHaveCount(0);
  await expect(first.getByRole('listitem').filter({ hasText: 'Pastéis de Belém' })).toBeVisible();
  // A second, then moved above the first with the keyboard.
  await first.getByRole('button', { name: 'Add an item' }).focus();
  await page.keyboard.press('Enter');
  await page.getByRole('dialog', { name: 'Add an item' }).getByLabel('Title').fill('Castelo');
  await page.keyboard.press('Enter');
  const rows = first.getByRole('listitem');
  await expect(rows).toHaveText([/Pastéis de Belém/, /Castelo/]);
  await first.getByRole('button', { name: 'Move Castelo up' }).focus();
  await page.keyboard.press('Enter');
  await expect(rows).toHaveText([/Castelo/, /Pastéis de Belém/]);
  // The first cannot go up and the last cannot go down.
  await expect(first.getByRole('button', { name: 'Move Castelo up' })).toBeDisabled();
  await expect(first.getByRole('button', { name: 'Move Pastéis de Belém down' })).toBeDisabled();
});

test('an item edited with no network shows at once with a clock, and the server has it when the network is back', async ({
  page,
  context,
}) => {
  await signedIn(page);
  const { tripId, stops } = await makeTrip(page, `Offline ${randomUUID().slice(0, 6)}`, [
    ['Lisbon', 5, 7],
  ]);
  const dayId = stops[0]?.days[0]?.id as string;
  await op(page, { op: 'item.add', tripId, dayId, title: 'Tram 28' });
  await page.goto(`/t/${tripId}?view=plan`);
  const row = page.locator('[data-item]').filter({ hasText: 'Tram 28' });
  await expect(row).toBeVisible();
  await expect(row.getByRole('img', { name: 'Not sent yet' })).toHaveCount(0);

  await goOffline(context);
  await row.getByRole('button', { name: 'Edit Tram 28' }).click();
  const dialog = page.getByRole('dialog', { name: 'Edit the item' });
  await dialog.getByLabel('Title').fill('Tram 28 to Graça');
  await dialog.getByLabel('Start', { exact: true }).fill('10:30');
  await dialog.getByRole('button', { name: 'Save' }).click();
  const edited = page.locator('[data-item]').filter({ hasText: 'Tram 28 to Graça' });
  await expect(edited).toBeVisible();
  await expect(edited).toContainText('10:30');
  await expect(edited.getByRole('img', { name: 'Not sent yet' })).toBeVisible();

  await goOnline(context);
  await expect(edited.getByRole('img', { name: 'Not sent yet' })).toHaveCount(0);
  // The server has it: a fresh load shows the same.
  await page.reload();
  await expect(page.locator('[data-item]').filter({ hasText: 'Tram 28 to Graça' })).toContainText(
    '10:30',
  );
});

test('an item is dragged to another day by its handle', async ({ page }) => {
  await signedIn(page);
  const { tripId, stops } = await makeTrip(page, `Drag ${randomUUID().slice(0, 6)}`, [
    ['Lisbon', 5, 7],
  ]);
  const [d1, d2] = stops[0]?.days ?? [];
  await op(page, { op: 'item.add', tripId, dayId: d1?.id, title: 'Move me' });
  await op(page, { op: 'item.add', tripId, dayId: d2?.id, title: 'Already here' });
  await page.goto(`/t/${tripId}?view=plan`);
  const from = page.locator(`[data-day="${d1?.id}"]`);
  const to = page.locator(`[data-day="${d2?.id}"]`);
  const handle = from.getByRole('button', { name: 'Drag Move me' });
  const target = to.getByText('Already here');
  const a = (await handle.boundingBox()) as { x: number; y: number; width: number; height: number };
  const b = (await target.boundingBox()) as { x: number; y: number; width: number; height: number };
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(a.x + a.width / 2 + 20, a.y + a.height / 2 + 20, { steps: 5 });
  await page.mouse.move(b.x + b.width / 2, b.y + 2, { steps: 15 });
  await page.mouse.up();
  // It is on the other day, and gone from this one. Where it lands among the day's items depends on which half of the item under it the pointer ends in, which a browser's layout decides to the pixel (WebKit put it
  // after in some runs): the order is the plan's own tests' (`src/trips/items.test.ts`), not this one's.
  const there = to.getByRole('listitem');
  await expect(there).toHaveCount(2);
  await expect(there.filter({ hasText: 'Move me' })).toHaveCount(1);
  await expect(there.filter({ hasText: 'Already here' })).toHaveCount(1);
  await expect(from.getByText('Nothing planned yet.')).toBeVisible();
});

test('shortening a stop over days with items is never silent: the items are moved or deleted', async ({
  page,
}) => {
  await signedIn(page);
  const { tripId, stops } = await makeTrip(page, `Shrink ${randomUUID().slice(0, 6)}`, [
    ['Lisbon', 5, 7],
    ['Sintra', 7, 8],
  ]);
  const lisbonDays = stops.find((s) => s.place.name === 'Lisbon')?.days ?? [];
  const sintraDay = stops.find((s) => s.place.name === 'Sintra')?.days[0];
  await op(page, { op: 'item.add', tripId, dayId: lisbonDays[1]?.id, title: 'Keep me' });
  await page.goto(`/t/${tripId}?view=plan`);
  await page.getByRole('button', { name: /^Lisbon/ }).click();

  await page.getByRole('button', { name: 'Change dates' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'Dates for Lisbon' });
  await dialog.getByRole('button', { name: 'Take the dates away' }).click();
  await dialog.getByRole('button', { name: 'Save' }).click();
  // Refused, naming the day, and offering to move or delete.
  await expect(dialog.getByText(/would go, and they have items/)).toBeVisible();
  // Moving needs a day to move them to.
  await expect(dialog.getByRole('button', { name: 'Move the items' })).toBeDisabled();
  await dialog.getByLabel('Move their items to').selectOption(sintraDay?.id as string);
  await dialog.getByRole('button', { name: 'Move the items' }).click();
  await expect(dialog).toHaveCount(0);

  // Lisbon has no days now, and Sintra’s day has the item.
  await expect(page.getByRole('heading', { name: 'No days yet' })).toBeVisible();
  await page.getByRole('button', { name: /^Sintra/ }).click();
  await expect(page.locator('[data-item]').filter({ hasText: 'Keep me' })).toBeVisible();
});

test('a Follower sees the plan and is given none of its controls', async ({ page, context }) => {
  await signedIn(page);
  await page.goto('/trips');
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => true));
  await expect
    .poll(() =>
      page.evaluate(async () => {
        for (const name of (await caches.keys()).filter((n) => n.startsWith('waymark-shell-')))
          if (await (await caches.open(name)).match('/shell')) return true;
        return false;
      }),
    )
    .toBe(true);
  await page.goto('/trips');
  await goOffline(context);
  const account = (
    await (
      await page.request.get('/api/auth/get-session').catch(() => undefined)
    )
      ?.json()
      .catch(() => undefined)
  )?.user?.id as string | undefined;
  const id =
    account ??
    (await page
      .evaluate(
        async () =>
          (await indexedDB.databases())
            .map((d) => d.name ?? '')
            .find((n) => n.startsWith('waymark-')) ?? '',
      )
      .then((n) => n.replace('waymark-', '')));
  const tripId = `plan-follower-${randomUUID().slice(0, 6)}`;
  await page.evaluate(
    ({ db, tripId, date }) =>
      new Promise<void>((resolve, reject) => {
        const open = indexedDB.open(db);
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const conn = open.result;
          const tx = conn.transaction(['trips', 'tripItems'], 'readwrite');
          tx.objectStore('trips').put({
            id: tripId,
            role: 'follower',
            cursor: 1,
            floor: 0,
            head: 1,
            sets: {
              trip: {
                id: tripId,
                name: 'Followed',
                color: 'info',
                startDate: date,
                endDate: date,
                readyAt: 1,
                going: true,
                role: 'follower',
                updatedAt: 1,
                status: 'upcoming',
                datesPassed: false,
                coverPlaceId: null,
                createdBy: null,
                seq: 1,
              },
              stops: [
                {
                  id: `${tripId}-s`,
                  place: {
                    id: `${tripId}-p`,
                    name: 'Kyoto',
                    lat: 35,
                    lng: 135,
                    tz: 'Asia/Tokyo',
                    countryCode: 'JP',
                  },
                  arrive: date,
                  depart: date,
                  position: '00001000',
                  version: 1,
                },
              ],
              members: [
                {
                  accountId: 'x',
                  name: 'Someone',
                  role: 'organizer',
                  going: true,
                  joinedAt: 1,
                  self: false,
                },
              ],
              days: [
                {
                  id: `${tripId}-d`,
                  stopId: `${tripId}-s`,
                  date,
                  title: undefined,
                  notes: undefined,
                  version: 1,
                },
              ],
              links: [],
              done: [],
            },
          });
          tx.objectStore('tripItems').put({
            id: `${tripId}-i`,
            tripId,
            dayId: `${tripId}-d`,
            title: 'Fushimi Inari',
            kind: 'sight',
            start: null,
            end: null,
            fixed: false,
            position: '00001000',
            notes: undefined,
            place: undefined,
            createdBy: null,
            updatedBy: null,
            version: 1,
            seq: 1,
          });
          tx.oncomplete = () => {
            conn.close();
            resolve();
          };
          tx.onerror = () => reject(tx.error);
        };
      }),
    { db: `waymark-${id}`, tripId, date: day(10) },
  );
  await page.goto(`/t/${tripId}?view=plan`);
  await expect(page.locator('[data-item]').filter({ hasText: 'Fushimi Inari' })).toBeVisible();
  await expect(page.getByRole('heading', { level: 2, name: 'Kyoto' })).toBeVisible();
  for (const name of [
    /^Add a stop/,
    /^Add an item/,
    /^Change dates/,
    /^Remove the stop/,
    /^Edit /,
    /^Delete /,
    /^Move /,
    /^Drag /,
  ])
    await expect(page.getByRole('button', { name })).toHaveCount(0);
});
