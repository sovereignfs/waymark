import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { PORTS } from './ports';
import { signedIn } from './helpers';

/**
 * The Journal (DESIGN.md §13, §20.10), in real browsers: a trip worked by hand, whose days read as a sentence and a list: what was done, what was skipped, what was found on the way, and what has no place and is never judged.
 * A check-in that is not linked to the trip is not in it, and the Overview's figures are the journal's.
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
const point = (name: string, lat: number, lng: number) => ({
  name,
  lat,
  lng,
  tz: 'Europe/Lisbon',
  source: 'manual',
});

const BELEM = { name: 'Pastéis de Belém', lat: 38.6975, lng: -9.2033 };
const CASTELO = { name: 'Castelo de São Jorge', lat: 38.7139, lng: -9.1335 };
const CAFE = { name: 'Random Café', lat: 38.7, lng: -9.1 };
const ALFAMA = { name: 'Alfama', lat: 38.711, lng: -9.13 };

/** Puts places and check-ins on the device's store, as a sync would have; the instance has one account, so the check-ins are the reader's own. */
async function seed(page: Page, tripId: string, firstDate: string) {
  const account = (await (await page.request.get('/api/auth/get-session')).json()).user
    .id as string;
  const place = (id: string, p: { name: string; lat: number; lng: number }) => ({
    id,
    ...p,
    source: 'manual',
    tz: 'Europe/Lisbon',
    countryCode: 'PT',
    version: 1,
    seq: 1,
  });
  const checkin = (id: string, placeId: string, hour: number, linked: boolean) => ({
    id,
    placeId,
    at: Date.parse(`${firstDate}T${String(hour).padStart(2, '0')}:00:00Z`),
    tz: 'Europe/Lisbon',
    offsetMin: 0,
    companions: [],
    tripId: linked ? tripId : null,
    linkSource: linked ? 'manual' : null,
    share: 'trip',
    source: 'live',
    version: 1,
    seq: 1,
  });
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
    {
      db: `waymark-${account}`,
      places: [place('jp-belem', BELEM), place('jp-castelo', CASTELO), place('jp-cafe', CAFE)],
      checkins: [
        // At Belém, and at a café the plan does not know: both linked to the trip.
        checkin('jc-belem', 'jp-belem', 10, true),
        checkin('jc-cafe', 'jp-cafe', 15, true),
        // At the castle, but not linked to this trip: the journal does not have it.
        checkin('jc-castelo', 'jp-castelo', 12, false),
      ],
    },
  );
}

test('each day reads as what was planned, done, skipped and found on the way; what is not linked is not in it', async ({
  page,
}) => {
  await signedIn(page);
  const first = day(-4);
  const created = await op<{ trip: { id: string } }>(page, {
    op: 'trip.create',
    name: `Journal ${randomUUID().slice(0, 6)}`,
  });
  const tripId = created.trip.id;
  await op(page, {
    op: 'stop.add',
    tripId,
    place: point('Lisbon', 38.72, -9.14),
    arrive: first,
    depart: day(-3),
  });
  const plan = await op<{ plan: { stops: { days: { id: string; date: string }[] }[] } }>(page, {
    op: 'trip.plan',
    tripId,
  });
  const [d1, d2] = plan.plan.stops[0]?.days ?? [];
  await op(page, {
    op: 'item.add',
    tripId,
    dayId: d1?.id,
    title: 'Belém',
    place: point(BELEM.name, BELEM.lat, BELEM.lng),
  });
  await op(page, {
    op: 'item.add',
    tripId,
    dayId: d1?.id,
    title: 'Castelo',
    start: '11:00',
    place: point(CASTELO.name, CASTELO.lat, CASTELO.lng),
  });
  await op(page, { op: 'item.add', tripId, dayId: d1?.id, title: 'Call home' });
  await op(page, {
    op: 'item.add',
    tripId,
    dayId: d2?.id,
    title: 'Alfama walk',
    place: point(ALFAMA.name, ALFAMA.lat, ALFAMA.lng),
  });

  await page.goto(`/t/${tripId}`);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await seed(page, tripId, first);
  await page.goto(`/t/${tripId}?view=journal`);

  const one = page.locator(`[data-date="${first}"]`);
  await expect(one.locator('[data-sentence]')).toHaveText(
    '3 planned, 1 done, 1 skipped, 1 found on the way',
  );
  // In time order: the plan’s order, and the café found at 15:00 after the castle that is timed 11:00.
  expect(
    await one
      .locator('[data-entry]')
      .evaluateAll((n) => n.map((e) => e.getAttribute('data-entry'))),
  ).toEqual(['done', 'skipped', 'planned', 'found']);
  await expect(one.locator('[data-item]').filter({ hasText: 'Belém' })).toContainText('Done');
  // The castle was checked in at, but not as part of this trip: skipped.
  await expect(one.locator('[data-item]').filter({ hasText: 'Castelo' })).toContainText('Skipped');
  // An item with no place is planned, never judged, even though its day has passed.
  await expect(one.locator('[data-item]').filter({ hasText: 'Call home' })).toContainText(
    'Planned',
  );
  await expect(one.locator('[data-entry="found"]')).toContainText('Random Café');
  await expect(one.locator('[data-entry="found"]')).toContainText('Found on the way');

  const two = page.locator(`[data-date="${day(-3)}"]`);
  await expect(two.locator('[data-sentence]')).toHaveText('1 planned, 1 skipped');

  // The Overview's figures are the journal's: two linked check-ins, one place visited.
  await page.goto(`/t/${tripId}`);
  const figures = page.getByRole('region', { name: 'Figures' });
  await expect(figures.locator('div', { hasText: /^Places visited1$/ })).toBeVisible();
  await expect(figures.locator('div', { hasText: /^Check-ins2$/ })).toBeVisible();
});

test('a trip that has not begun has nothing to look back on', async ({ page }) => {
  await signedIn(page);
  const created = await op<{ trip: { id: string } }>(page, {
    op: 'trip.create',
    name: `Future ${randomUUID().slice(0, 6)}`,
  });
  await op(page, {
    op: 'stop.add',
    tripId: created.trip.id,
    place: point('Lisbon', 38.72, -9.14),
    arrive: day(20),
    depart: day(22),
  });
  await page.goto(`/t/${created.trip.id}?view=journal`);
  await expect(page.getByRole('heading', { name: 'Nothing to look back on yet' })).toBeVisible();
});
