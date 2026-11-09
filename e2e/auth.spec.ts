import { expect, test } from '@playwright/test';
import { PORTS } from './ports';
import { EMAIL, PASSWORD, ensureAccount, signOut, trySignIn } from './helpers';

/**
 * Signing up, in, and out, in a browser (DESIGN.md §19.1). The instance is closed to sign-up, so the first account is the only one there will be, and it
 * is made by whichever browser gets here first: both browsers share the instance, so every test below starts by making sure there is one.
 */
test('a visitor to the front address is sent to sign in', async ({ page }) => {
  await ensureAccount(page);
  await page.goto('/');
  await expect(page).toHaveURL(/\/sign-in$/);
  await expect(page.getByRole('heading', { name: 'Sign in to Waymark' })).toBeVisible();
  for (const path of ['/checkins', '/map', '/places']) {
    await page.goto(path);
    await expect(page, path).toHaveURL(/\/sign-in$/);
  }
});

test('the first account can be made, and signs the person in', async ({ page }) => {
  await ensureAccount(page);
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'User menu' })).toHaveCount(0);
});

test('signing in with the right password shows who is signed in, and signing out ends it', async ({
  page,
}) => {
  await ensureAccount(page);
  await trySignIn(page, EMAIL, PASSWORD);
  await expect(page.getByRole('button', { name: 'User menu' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Home' })).toBeVisible();

  // Signed in, the sign-in page has nothing to ask.
  await page.goto('/sign-in');
  await expect(page).toHaveURL(/\/$/);

  await signOut(page);
  await page.reload();
  await expect(page.getByRole('button', { name: 'User menu' })).toHaveCount(0);
  await expect(page).toHaveURL(/\/sign-in$/);
});

test('a wrong password reads the same as an address with no account, and signs no one in', async ({
  page,
}) => {
  await ensureAccount(page);
  const messages: string[] = [];
  for (const email of [EMAIL, 'nobody@example.com']) {
    await trySignIn(page, email, 'not the password at all');
    const alert = page.getByText(/do not match/);
    await expect(alert).toBeVisible();
    messages.push((await alert.textContent()) ?? '');
  }
  expect(messages[1]).toBe(messages[0]);
  await expect(page.getByRole('button', { name: 'User menu' })).toHaveCount(0);
});

test('a second account is refused by the server, and the page does not offer one', async ({
  page,
  request,
}) => {
  await ensureAccount(page);
  // The browser's own origin, which is what a page of ours would send.
  const origin = new URL(page.url()).origin;
  const reply = await request.post('/api/auth/sign-up/email', {
    headers: { origin },
    data: { name: 'Mallory', email: 'mallory@example.com', password: PASSWORD },
  });
  expect(reply.status()).toBe(403);
  expect((await reply.json()).code).toBe('SIGNUP_CLOSED');

  await page.goto('/sign-up');
  await expect(page.getByRole('heading', { name: 'Sign-up is closed' })).toBeVisible();
  await page.goto('/sign-in');
  await expect(page.getByRole('link', { name: 'Create account' })).toHaveCount(0);
});

test.describe('with no way of signing in', () => {
  const base = `http://localhost:${PORTS.off}`;

  test('every sign-in page and route does not exist, and so does the app', async ({ request }) => {
    for (const path of [
      '/sign-in',
      '/sign-up',
      '/forgot-password',
      '/reset-password',
      '/',
      '/checkins',
    ]) {
      const reply = await request.get(`${base}${path}`);
      expect(reply.status(), path).toBe(404);
    }
    for (const path of ['/api/auth/get-session', '/api/auth/ok']) {
      expect((await request.get(`${base}${path}`)).status(), path).toBe(404);
    }
    const post = await request.post(`${base}/api/auth/sign-up/email`, {
      headers: { origin: base },
      data: { name: 'Mallory', email: 'mallory@example.com', password: PASSWORD },
    });
    expect(post.status()).toBe(404);
    // What is not about a person is still there.
    expect((await request.get(`${base}/api/health`)).status()).toBe(200);
  });
});
