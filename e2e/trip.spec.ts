import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { PORTS } from './ports';
import { goOffline, signedIn } from './helpers';

/**
 * A trip's page (DESIGN.md §20.10), in real browsers: the header and the Overview for an Organizer, who marks the trip ready, takes it back, renames it, recolours it and deletes it; **each role sees the actions its role allows and no
 * others** (the Traveler and the Follower from rows put on the device, since the instance has one account); and switching views keeps the address and the back button right.
 */
test.use({ viewport: { width: 1280, height: 800 }, actionTimeout: 15_000 });
expect.configure({ timeout: 15_000 });

const ORIGIN = `http://localhost:${PORTS.app}`;
const day = (offset: number) =>
  new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

async function op(page: Page, body: Record<string, unknown>) {
  const reply = await page.request.post('/api/ops', { headers: { origin: ORIGIN }, data: body });
  expect(reply.ok()).toBe(true);
  const json = (await reply.json()) as { ok: boolean; trip?: { id: string } };
  expect(json.ok).toBe(true);
  return json.trip as { id: string };
}

/** Two dated stops, a Tally link and another, an item with a place; not ready. */
async function makeTrip(page: Page, name: string) {
  const trip = await op(page, { op: 'trip.create', name });
  for (const [place, from, to] of [
    ['Lisbon', 20, 22],
    ['Sintra', 22, 24],
  ] as const)
    await op(page, {
      op: 'stop.add',
      tripId: trip.id,
      place: { name: place, lat: 38.72, lng: -9.14, tz: 'Europe/Lisbon', source: 'manual' },
      arrive: day(from),
      depart: day(to),
    });
  await op(page, {
    op: 'link.add',
    tripId: trip.id,
    url: 'https://example.org/booking',
    title: 'Booking',
  });
  await op(page, {
    op: 'link.add',
    tripId: trip.id,
    url: 'https://tally.example.org/g/1',
    kind: 'tally',
  });
  return trip.id;
}

test('an Organizer sees the header and the Overview, marks the trip ready and takes it back', async ({
  page,
}) => {
  await signedIn(page);
  const name = `Portugal ${randomUUID().slice(0, 6)}`;
  const id = await makeTrip(page, name);
  await page.goto(`/t/${id}`);

  const header = page
    .getByRole('banner')
    .filter({ hasText: name })
    .or(page.locator('header', { hasText: name }));
  await expect(page.getByRole('heading', { level: 1, name })).toBeVisible();
  await expect(header.first()).toContainText('Planning');
  await expect(header.first()).toContainText('Organizer');
  await expect(page.getByRole('button', { name: 'Mark ready' })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Trip menu' })).toBeVisible();
  // No Trip Mode before the trip is on.
  await expect(page.getByRole('link', { name: 'Open Trip Mode' })).toHaveCount(0);

  // The Overview: stops in order, figures, the next thing, links with Tally's first.
  await expect(page.getByRole('list', { name: 'The stops in order' })).toContainText('Lisbon');
  const stops = page.getByRole('region', { name: 'Stops' }).getByRole('listitem');
  await expect(stops.filter({ hasText: 'Lisbon' }).first()).toBeVisible();
  const figures = page.getByRole('region', { name: 'Figures' });
  await expect(figures).toContainText('Stops');
  await expect(figures.locator('div', { hasText: /^Stops2$/ })).toBeVisible();
  const links = page.getByRole('region', { name: 'Links' }).getByRole('link');
  await expect(links.first()).toHaveAttribute('href', 'https://tally.example.org/g/1');
  await expect(links.nth(1)).toHaveAttribute('href', 'https://example.org/booking');
  await expect(links.first()).toHaveAttribute('rel', /noopener/);

  // Mark ready: the status follows at once, and the button becomes its opposite.
  await page.getByRole('button', { name: 'Mark ready' }).click();
  await expect(header.first()).toContainText('Upcoming');
  await expect(page.getByRole('button', { name: 'Back to planning' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Mark ready' })).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Next' })).toContainText('The trip starts on');
  await page.getByRole('button', { name: 'Back to planning' }).click();
  await expect(header.first()).toContainText('Planning');
  await expect(page.getByRole('button', { name: 'Mark ready' })).toBeVisible();
});

test('the menu renames, recolours and deletes, asking first', async ({ page }) => {
  await signedIn(page);
  const name = `Menu ${randomUUID().slice(0, 6)}`;
  const id = await makeTrip(page, name);
  await page.goto(`/t/${id}`);
  await expect(page.getByRole('heading', { level: 1, name })).toBeVisible();

  const menu = async (item: string) => {
    await page.getByRole('button', { name: 'Trip menu' }).click();
    await page.getByRole('menuitem', { name: item }).click();
  };

  await menu('Rename');
  const renamed = `${name} renamed`;
  const dialog = page.getByRole('dialog', { name: 'Rename the trip' });
  await dialog.getByLabel('Name').fill(renamed);
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('heading', { level: 1, name: renamed })).toBeVisible();
  await expect(
    page.getByRole('navigation', { name: 'Waymark' }).getByRole('link', { name: renamed }),
  ).toBeVisible();

  await menu('Change colour');
  const colour = page.getByRole('dialog', { name: 'Change the colour' });
  await colour.getByRole('radio', { name: 'Red' }).click();
  await colour.getByRole('button', { name: 'Save' }).click();
  await expect(colour).toHaveCount(0);

  // Keeping the trip when asked first.
  await menu('Delete trip');
  const confirm = page
    .getByRole('dialog', { name: 'Delete this trip?' })
    .or(page.getByRole('alertdialog'));
  await expect(confirm.first()).toContainText('2 stops');
  await confirm.first().getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByRole('heading', { level: 1, name: renamed })).toBeVisible();

  await menu('Delete trip');
  await page.getByRole('button', { name: 'Delete trip', exact: true }).click();
  await expect(page).toHaveURL(/\/trips$/);
  await expect(page.locator(`[data-trip="${id}"]`)).toHaveCount(0);
  // The same address is now a trip that is not here.
  await page.goto(`/t/${id}`);
  await expect(page.getByRole('heading', { name: 'This trip is not here' })).toBeVisible();
});

test('the views are tabs in the address, a step of the history each, and the back button goes to the one before', async ({
  page,
}) => {
  await signedIn(page);
  const id = await makeTrip(page, `Views ${randomUUID().slice(0, 6)}`);
  await page.goto(`/t/${id}`);
  const tabs = page.getByRole('navigation', { name: 'Views of the trip' });
  await expect(tabs.getByRole('link')).toHaveText([
    'Overview',
    'Plan',
    'Map',
    'Journal',
    'Files',
    'People',
  ]);
  await expect(tabs.getByRole('link', { name: 'Overview' })).toHaveAttribute(
    'aria-current',
    'page',
  );

  await tabs.getByRole('link', { name: 'Plan' }).click();
  await expect(page).toHaveURL(new RegExp(`/t/${id}\\?view=plan$`));
  await expect(tabs.getByRole('link', { name: 'Plan' })).toHaveAttribute('aria-current', 'page');
  await tabs.getByRole('link', { name: 'Journal' }).click();
  await expect(page).toHaveURL(/view=journal$/);

  await page.goBack();
  await expect(page).toHaveURL(/view=plan$/);
  await expect(tabs.getByRole('link', { name: 'Plan' })).toHaveAttribute('aria-current', 'page');
  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`/t/${id}$`));
  await expect(tabs.getByRole('link', { name: 'Overview' })).toHaveAttribute(
    'aria-current',
    'page',
  );

  // A reload on a view is the same page; a view that is not one is the Overview.
  await page.goto(`/t/${id}?view=map`);
  await expect(tabs.getByRole('link', { name: 'Map' })).toHaveAttribute('aria-current', 'page');
  await page.goto(`/t/${id}?view=nonsense`);
  await expect(tabs.getByRole('link', { name: 'Overview' })).toHaveAttribute(
    'aria-current',
    'page',
  );
});

/** Puts a trip the account is in as `role` on the device, as a sync would have, with the network off so that none comes to say otherwise; then opens its page from the kept shell. */
async function seedTrip(
  page: Page,
  role: string,
  name: string,
  over: { going?: boolean; readyAt?: number | null } = {},
) {
  const account = (await (await page.request.get('/api/auth/get-session')).json()).user
    .id as string;
  const tripId = `seeded-${role}-${randomUUID().slice(0, 6)}`;
  await page.evaluate(
    ({ db, entry }) =>
      new Promise<void>((resolve, reject) => {
        const open = indexedDB.open(db);
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const conn = open.result;
          const tx = conn.transaction(['trips'], 'readwrite');
          tx.objectStore('trips').put(entry);
          tx.oncomplete = () => {
            conn.close();
            resolve();
          };
          tx.onerror = () => reject(tx.error);
        };
      }),
    {
      db: `waymark-${account}`,
      entry: {
        id: tripId,
        role,
        cursor: 1,
        floor: 0,
        head: 1,
        sets: {
          trip: {
            id: tripId,
            name,
            description: undefined,
            color: 'info',
            status: 'ongoing',
            datesPassed: false,
            startDate: day(-1),
            endDate: day(2),
            readyAt: over.readyAt === undefined ? 1 : over.readyAt,
            coverPlaceId: null,
            createdBy: null,
            seq: 1,
            role,
            going: over.going ?? true,
            updatedAt: 1,
          },
          stops: [
            {
              id: `${tripId}-s1`,
              place: {
                id: `${tripId}-p1`,
                name: 'Kyoto',
                lat: 35,
                lng: 135,
                tz: 'Asia/Tokyo',
                countryCode: 'JP',
              },
              arrive: day(-1),
              depart: day(2),
              position: '00001000',
              version: 1,
            },
          ],
          members: [
            { accountId: account, name: 'Owner', role, going: true, joinedAt: 1, self: true },
            {
              accountId: 'someone',
              name: 'Someone',
              role: 'organizer',
              going: true,
              joinedAt: 1,
              self: false,
            },
          ],
          days: [],
          links: [],
          done: [],
        },
      },
    },
  );
  return tripId;
}

test('a Traveler and a Follower are offered none of an Organizer’s actions, and a Follower has no Files', async ({
  page,
  context,
}) => {
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
  // One visit to a trip's address with the worker in control, so that the shell answers it.
  await page.goto('/trips');
  await goOffline(context);

  const traveler = await seedTrip(page, 'traveler', 'Seeded Traveler Trip');
  await page.goto(`/t/${traveler}`);
  await expect(page.getByRole('heading', { level: 1, name: 'Seeded Traveler Trip' })).toBeVisible();
  await expect(page.locator('header', { hasText: 'Seeded Traveler Trip' })).toContainText(
    'Traveler',
  );
  // Ongoing, going: Trip Mode, and nothing of an Organizer's.
  await expect(page.getByRole('link', { name: 'Open Trip Mode' })).toBeVisible();
  for (const name of ['Mark ready', 'Back to planning', 'Trip menu'])
    await expect(page.getByRole('button', { name })).toHaveCount(0);
  await expect(
    page
      .getByRole('navigation', { name: 'Views of the trip' })
      .getByRole('link', { name: 'Files' }),
  ).toBeVisible();
  // A Traveler chooses about sharing; the choice is theirs alone.
  await expect(page.getByRole('region', { name: 'Sharing' })).toBeVisible();

  const follower = await seedTrip(page, 'follower', 'Seeded Follower Trip');
  await page.goto(`/t/${follower}`);
  await expect(page.getByRole('heading', { level: 1, name: 'Seeded Follower Trip' })).toBeVisible();
  await expect(page.locator('header', { hasText: 'Seeded Follower Trip' })).toContainText(
    'Follower',
  );
  await expect(page.getByRole('link', { name: 'Open Trip Mode' })).toHaveCount(0);
  for (const name of ['Mark ready', 'Back to planning', 'Trip menu'])
    await expect(page.getByRole('button', { name })).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Sharing' })).toHaveCount(0);
  const tabs = page.getByRole('navigation', { name: 'Views of the trip' });
  await expect(tabs.getByRole('link')).toHaveText(['Overview', 'Plan', 'Map', 'Journal', 'People']);
  // Asking for Files by the address does not show them.
  await page.goto(`/t/${follower}?view=files`);
  await expect(tabs.getByRole('link', { name: 'Overview' })).toHaveAttribute(
    'aria-current',
    'page',
  );
});
