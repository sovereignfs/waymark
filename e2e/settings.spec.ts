import { expect, test, type Page } from '@playwright/test';
import { EMAIL, secondContext, signedIn } from './helpers';

/**
 * Settings, in a browser (DESIGN.md §21): reached from the avatar menu, each section saves and reads back, and changing the name changes it wherever the person is shown. The
 * shared account's name is put back after each test, since the other tests read it.
 */
test.describe.configure({ mode: 'serial' });

async function openSettings(page: Page) {
  await page.getByRole('button', { name: 'User menu' }).click();
  await page.getByRole('menuitem', { name: 'Settings' }).click();
  await expect(page).toHaveURL(/\/settings$/);
  await expect(page.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible();
}

async function restoreName(page: Page) {
  await page.goto('/settings');
  const name = page.getByRole('textbox', { name: 'Name' });
  if ((await name.inputValue()) !== 'Ada') {
    await name.fill('Ada');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByText('Your profile is saved.')).toBeVisible();
  }
}

test('Settings opens from the menu with its sections, and a visitor is sent to sign in', async ({
  page,
  browser,
}) => {
  const visitor = await secondContext(browser);
  const other = await visitor.newPage();
  await other.goto('/settings');
  await expect(other).toHaveURL(/\/sign-in$/);
  expect((await visitor.request.get('/api/settings')).status()).toBe(401);
  await visitor.close();

  await signedIn(page);
  await openSettings(page);
  const nav = page.getByRole('navigation', { name: 'Settings sections' });
  for (const label of ['Profile', 'Sign-in', 'Data'])
    await expect(nav.getByRole('button', { name: label })).toBeVisible();
  // The address it signs in with is shown, and is not an input.
  await expect(page.getByText(EMAIL)).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Email' })).toHaveCount(0);

  await nav.getByRole('button', { name: 'Sign-in' }).click();
  await expect(page.getByRole('region', { name: 'Sign-in' })).toBeVisible();
  for (const heading of ['Password', 'Authenticator app', 'Passkeys', 'Devices'])
    await expect(page.getByRole('heading', { name: heading })).toBeVisible();
  await nav.getByRole('button', { name: 'Data' }).click();
  await expect(page.getByText(/Your photos and files use/)).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Delete account' })).toBeVisible();
});

test('a saved profile reads back, and the new name is shown wherever the person is', async ({
  page,
}) => {
  await signedIn(page);
  await openSettings(page);
  await page.getByRole('textbox', { name: 'Name' }).fill('Ada King');
  await page.getByLabel('Distances in').selectOption('mi');
  await page.getByLabel('The week starts on').selectOption('0');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('Your profile is saved.')).toBeVisible();

  // Read back from the server after a reload.
  await page.reload();
  await expect(page.getByRole('textbox', { name: 'Name' })).toHaveValue('Ada King');
  await expect(page.getByLabel('Distances in')).toHaveValue('mi');
  await expect(page.getByLabel('The week starts on')).toHaveValue('0');
  // And in the menu, on another page.
  await page.goto('/checkins');
  await page.getByRole('button', { name: 'User menu' }).click();
  await expect(page.getByText('Ada King')).toBeVisible();
  await page.keyboard.press('Escape');

  await restoreName(page);
});

test('a name that is not one is not saved', async ({ page }) => {
  await signedIn(page);
  await openSettings(page);
  await page.getByRole('textbox', { name: 'Name' }).fill('   ');
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
  await page.getByRole('textbox', { name: 'Name' }).fill('x'.repeat(101));
  await expect(page.getByText('At most 100 characters.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
});

test('with no connection Settings says that it needs one', async ({ page, context }) => {
  await signedIn(page);
  await openSettings(page);
  await context.setOffline(true);
  await expect(
    page
      .getByRole('heading', { name: 'You’re offline' })
      .or(page.getByRole('heading', { name: "You're offline" })),
  ).toBeVisible();
  await expect(page.getByText('Settings needs a connection', { exact: false })).toBeVisible();
  // Nothing that could be stale is shown.
  await expect(page.getByRole('textbox', { name: 'Name' })).toHaveCount(0);
  await context.setOffline(false);
  await expect(page.getByRole('textbox', { name: 'Name' })).toBeVisible();
});
