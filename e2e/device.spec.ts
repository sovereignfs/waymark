import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { PORTS } from './ports';
import { goOffline, goOnline, secondContext, signOut, signedIn } from './helpers';

/**
 * The device's store and its sync, in real browsers (DESIGN.md §15.1, §15.3, §15.8): two browsers of one account, one of them offline for a while, both end with the same check-ins; and signing out
 * leaves no Waymark database in the browser. There is no screen to check in with yet (7.2), so a change is put in the outbox the way the app puts it, in the database the app opened, and the page
 * is told, as the app tells itself, that it has the focus or the network: **the app's own loop** sends it.
 */
const ORIGIN = `http://localhost:${PORTS.app}`;

async function accountId(page: Page): Promise<string> {
  const session = await (await page.request.get('/api/auth/get-session')).json();
  return session.user.id as string;
}
const databases = (page: Page) =>
  page.evaluate(async () =>
    (await indexedDB.databases()).map((d) => d.name ?? '').filter((n) => n.startsWith('waymark-')),
  );

/** Reads rows straight from the app's database. */
const readStore = (page: Page, id: string) =>
  page.evaluate(
    (name) =>
      new Promise<{ checkins: string[]; places: string[]; outbox: number }>((resolve, reject) => {
        const open = indexedDB.open(name);
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result;
          const tx = db.transaction(['checkins', 'places', 'outbox'], 'readonly');
          const all = (store: string) =>
            new Promise<unknown[]>((ok) => {
              const request = tx.objectStore(store).getAll();
              request.onsuccess = () => ok(request.result);
            });
          void Promise.all([all('checkins'), all('places'), all('outbox')]).then(
            ([checkins, places, outbox]) => {
              db.close();
              resolve({
                checkins: (checkins as { id: string }[]).map((c) => c.id).sort(),
                places: (places as { id: string }[]).map((p) => p.id).sort(),
                outbox: outbox.length,
              });
            },
          );
        };
      }),
    `waymark-${id}`,
  );

/** Puts a mutation in the outbox of the app's database, and tells the page it has the focus, which is one of the things that makes the app's loop send it. */
async function record(
  page: Page,
  id: string,
  mutation: unknown,
  event: 'focus' | 'online' = 'focus',
) {
  await page.evaluate(
    ({ name, mutation, event }) =>
      new Promise<void>((resolve, reject) => {
        const open = indexedDB.open(name);
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result;
          const tx = db.transaction('outbox', 'readwrite');
          tx.objectStore('outbox').add({
            mutationId: (mutation as { mutationId: string }).mutationId,
            mutation,
            queuedAt: Date.now(),
          });
          tx.oncomplete = () => {
            db.close();
            window.dispatchEvent(new Event(event));
            resolve();
          };
        };
      }),
    { name: `waymark-${id}`, mutation, event },
  );
}

const placeRow = {
  name: 'Café de Flore',
  lat: 48.854,
  lng: 2.3326,
  source: 'manual',
  tz: 'Europe/Paris',
  countryCode: null,
};
const checkinRow = (placeId: string, note: string) => ({
  placeId,
  at: Date.now() - 60_000,
  tz: 'Europe/Paris',
  offsetMin: 120,
  note,
  companions: [],
  tripId: null,
  linkSource: null,
  share: 'trip',
  source: 'live',
});
const withPlace = (placeId: string, checkinId: string, note: string) => ({
  mutationId: randomUUID(),
  stream: 'account',
  changes: [
    { table: 'place', op: 'put', id: placeId, row: placeRow },
    { table: 'checkin', op: 'put', id: checkinId, row: checkinRow(placeId, note) },
  ],
});
const at = (placeId: string, checkinId: string, note: string) => ({
  mutationId: randomUUID(),
  stream: 'account',
  changes: [{ table: 'checkin', op: 'put', id: checkinId, row: checkinRow(placeId, note) }],
});
/** What the server has, asked as the page would. */
const serverCheckins = async (page: Page) => {
  const reply = await page.request.post('/api/sync', {
    headers: { origin: ORIGIN, 'content-type': 'application/json' },
    data: { protocol: 1, outbox: [], cursor: 0, limit: 500 },
  });
  return ((await reply.json()).account.checkins as { id: string }[]).map((c) => c.id);
};

test('two browsers of one account, one of them offline, end with the same check-ins; signing out leaves no database behind', async ({
  page,
  browser,
}) => {
  await signedIn(page);
  const other = await secondContext(browser);
  const pageB = await other.newPage();
  await signedIn(pageB);
  const id = await accountId(page);
  expect(await accountId(pageB)).toBe(id);

  // Each browser opened the account's database, and only that.
  await expect.poll(() => databases(page)).toEqual([`waymark-${id}`]);
  await expect.poll(() => databases(pageB)).toEqual([`waymark-${id}`]);

  const place = randomUUID();
  const [first, second, third] = [randomUUID(), randomUUID(), randomUUID()];

  // A records, and the app's loop sends it; B then has it, by pulling.
  await record(page, id, withPlace(place, first, 'from a'));
  await expect.poll(() => serverCheckins(page)).toContain(first);
  await expect.poll(async () => (await readStore(page, id)).outbox).toBe(0);
  await pageB.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect.poll(async () => (await readStore(pageB, id)).checkins).toContain(first);

  // B goes offline and records: it is kept, and is not sent.
  await goOffline(other);
  await record(pageB, id, at(place, second, 'from b, offline'));
  await pageB.waitForTimeout(1500);
  expect((await readStore(pageB, id)).outbox).toBe(1);
  expect(await serverCheckins(page)).not.toContain(second);

  // A records meanwhile.
  await record(page, id, at(place, third, 'from a, again'));
  await expect.poll(() => serverCheckins(page)).toContain(third);

  // B comes back and sends; then A catches up. Both end the same.
  await goOnline(other);
  await pageB.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect.poll(() => serverCheckins(page)).toContain(second);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  // The server is shared by every test of the run, so what is there is more than these three; the point is that the two browsers hold the same, and all three.
  await expect
    .poll(async () => (await readStore(page, id)).checkins)
    .toEqual(expect.arrayContaining([first, second, third]));
  await expect
    .poll(async () => (await readStore(pageB, id)).checkins)
    .toEqual(expect.arrayContaining([first, second, third]));
  await expect
    .poll(async () => (await readStore(pageB, id)).checkins)
    .toEqual((await readStore(page, id)).checkins);
  expect((await readStore(pageB, id)).outbox).toBe(0);
  expect((await readStore(page, id)).places).toContain(place);
  expect((await readStore(pageB, id)).places).toEqual((await readStore(page, id)).places);

  // Signing out deletes the account's database from the browser.
  await signOut(pageB);
  await expect.poll(() => databases(pageB)).toEqual([]);
  await other.close();
  await signOut(page);
  await expect.poll(() => databases(page)).toEqual([]);
});

test('signing out with something that was not sent asks first, and keeping the device signed in keeps it', async ({
  page,
}) => {
  await signedIn(page);
  const id = await accountId(page);
  await expect.poll(() => databases(page)).toEqual([`waymark-${id}`]);
  // A mutation the server will refuse: a check-in at a place that is not there. It is refused, and kept in Couldn't sync.
  await record(page, id, at('no-such-place', randomUUID(), 'doomed'));
  await expect.poll(async () => (await readStore(page, id)).outbox).toBe(0);
  await page.getByRole('button', { name: 'User menu' }).click();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
  await expect(page.getByText('Some changes were not sent')).toBeVisible();
  await page.getByRole('button', { name: 'Stay signed in' }).click();
  await expect(page.getByRole('button', { name: 'User menu' })).toBeVisible();
  expect(await databases(page)).toEqual([`waymark-${id}`]);
  // Then discarding it signs out and deletes the database.
  await page.getByRole('button', { name: 'User menu' }).click();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
  await page.getByRole('button', { name: 'Sign out and discard' }).click();
  await expect(page.getByRole('button', { name: 'User menu' })).toHaveCount(0);
  await expect.poll(() => databases(page)).toEqual([]);
});
