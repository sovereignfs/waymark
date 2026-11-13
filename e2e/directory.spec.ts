import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { signOut } from './helpers';
import { PORTS } from './ports';

/**
 * Inviting from core's directory (task 14.2, DESIGN.md §11.2, §19.3), a fake Sovereign (`e2e/fake-sovereign-server.ts`) on the instance that signs in through it: an Organizer who signed in through core types
 * a name, is offered the people of the instance beside the people they share a trip with, invites one who has **never used Waymark**, and that person's first sign-in through core puts them in the trip with the role invited.
 * The browser asks nothing but this server.
 */
const SOVEREIGN = `http://localhost:${PORTS.sovereign}`;
const CONTROL = `http://localhost:${PORTS.coreControl}`;
const tag = randomUUID().slice(0, 6);
const ORGANIZER = {
  sub: `dir-org-${tag}`,
  email: `org-${tag}@sovereign.test`,
  name: `Olga ${tag}`,
};
const NEWCOMER = { sub: `dir-new-${tag}`, name: `Nia ${tag}`, email: `nia-${tag}@sovereign.test` };

test.use({ baseURL: SOVEREIGN, viewport: { width: 1280, height: 900 }, actionTimeout: 15_000 });
test.describe.configure({ mode: 'serial', timeout: 120_000 });
expect.configure({ timeout: 15_000 });

async function control(page: Page, path: string, data: Record<string, unknown>) {
  const reply = await page.request.post(`${CONTROL}${path}`, { data });
  expect(reply.ok()).toBe(true);
}

/** Starts the sign-in at Sovereign, waiting out the limit on tries (both browsers reach this instance from one address). */
async function throughSovereign(page: Page) {
  const button = page.getByRole('button', { name: 'Sign in with Sovereign' });
  const limited = page.getByText(/Too many tries/);
  for (let attempt = 0; attempt < 3; attempt++) {
    await button.click();
    await expect(limited.or(page.getByRole('button', { name: 'User menu' }))).toBeVisible();
    if (!(await limited.isVisible())) return;
    await page.waitForTimeout(10_500);
  }
}

test('the people of the instance are offered by name, one who has never used Waymark is invited, and their first sign-in through core puts them in the trip', async ({
  page,
  browser,
}) => {
  const asked: string[] = [];
  page.on('request', (request) => {
    if (!request.url().startsWith(SOVEREIGN)) asked.push(request.url());
  });

  // The Organizer signs in through core, and makes a trip.
  await control(page, '/sign-in-as', ORGANIZER);
  await page.goto('/sign-in');
  await throughSovereign(page);
  // Going to core to sign in is the person's own navigation; what is asked from here on is the page's.
  asked.length = 0;
  const tripName = `Directory ${tag}`;
  const made = await page.request.post('/api/ops', {
    headers: { origin: SOVEREIGN },
    data: { op: 'trip.create', name: tripName },
  });
  const { trip } = (await made.json()) as { trip: { id: string } };
  expect(trip.id).toBeTruthy();

  // Someone on the instance who has never signed in to Waymark.
  await control(page, '/people', { sub: NEWCOMER.sub, name: NEWCOMER.name });
  await page.goto(`/t/${trip.id}?view=people`);
  await page.getByRole('button', { name: 'Invite' }).click();
  const invite = page.getByRole('dialog', { name: 'Invite someone' });
  await invite.getByLabel('Role').selectOption('traveler');
  await invite.getByLabel('How').selectOption('person');
  await invite.getByLabel('Name').fill(`Nia ${tag}`);
  const instance = invite.getByRole('list', { name: 'People on this instance' });
  await expect(instance.getByRole('button', { name: NEWCOMER.name })).toBeVisible();
  await expect(invite).toContainText('and the people of this instance');
  // The Organizer is not offered to themselves.
  await invite.getByLabel('Name').fill(`Olga ${tag}`);
  await expect(instance).toHaveCount(0);
  await invite.getByLabel('Name').fill(`Nia ${tag}`);
  await instance.getByRole('button', { name: NEWCOMER.name }).click();
  await invite.getByRole('button', { name: 'Make the invitation' }).click();
  const done = page.getByRole('dialog', { name: 'Invitation made' });
  await expect(done).toContainText('told by the instance');
  const link = await done.getByLabel('The invitation link').inputValue();
  expect(link).toMatch(/\/invite\/[A-Za-z0-9_-]{43}$/);
  await done.getByRole('button', { name: 'Done' }).click();
  await expect(page.getByRole('region', { name: 'Waiting to join' })).toContainText(NEWCOMER.name);
  // Typing in the dialog and choosing asked this server and nobody else.
  expect(asked).toEqual([]);

  // The person's first sign-in through core takes it: they are in the trip, as a Traveler.
  await signOut(page);
  const second = await browser.newContext({ baseURL: SOVEREIGN });
  const newcomer = await second.newPage();
  await control(newcomer, '/sign-in-as', NEWCOMER);
  await newcomer.goto('/sign-in');
  await throughSovereign(newcomer);
  await newcomer.goto(`/t/${trip.id}?view=people`);
  const members = newcomer.getByRole('list', { name: 'Members' });
  await expect(members).toContainText(`Olga ${tag}`);
  await expect(members).toContainText('(you)');
  await expect(members.getByRole('listitem')).toHaveCount(2);
  await expect(newcomer.getByRole('heading', { level: 1 })).toContainText(tripName);
  await second.close();

  // The invitation is spent, and the Organizer sees no one waiting.
  await control(page, '/sign-in-as', ORGANIZER);
  await page.goto('/sign-in');
  await throughSovereign(page);
  await page.goto(`/t/${trip.id}?view=people`);
  await expect(page.getByRole('region', { name: 'Waiting to join' })).toContainText(
    'No one is waiting',
  );
  await expect(page.getByRole('list', { name: 'Members' }).getByRole('listitem')).toHaveCount(2);
});
