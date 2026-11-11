import { expect, test, type Page } from '@playwright/test';
import { signOut } from './helpers';
import { PORTS } from './ports';

/**
 * Signing in through Sovereign (task 2.3, DESIGN.md §19.1), a fake one (`e2e/fake-sovereign-server.ts`), on two instances of their own: one that takes only Sovereign and has local sign-up closed, and one
 * that takes both ways with sign-up open (their ports are in `e2e/ports.ts`). The instances keep their accounts between the two browsers, so each test is the same whichever runs first: the same person
 * signs in as the same account.
 */
const SOVEREIGN = `http://localhost:${PORTS.sovereign}`;
const BOTH = `http://localhost:${PORTS.both}`;
const FIRST = { sub: 'e2e-first', email: 'first@sovereign.test', name: 'Grace Hopper' };
const SECOND = { sub: 'e2e-second', email: 'second@sovereign.test', name: 'Alan Turing' };

async function nextPersonIs(page: Page, who: { sub: string; email: string; name?: string }) {
  const reply = await page.request.post(`http://localhost:${PORTS.coreControl}/sign-in-as`, {
    data: who,
  });
  expect(reply.ok()).toBe(true);
}

/**
 * Starts the sign-in at Sovereign. Sign-in is rate-limited, three tries in ten seconds from one address, and both browsers reach these instances from the same one: when told so, wait it out and go
 * again, as a person would.
 */
async function throughSovereign(page: Page) {
  const button = page.getByRole('button', { name: 'Sign in with Sovereign' });
  const limited = page.getByText(/Too many tries/);
  for (let attempt = 0; attempt < 3; attempt++) {
    await button.click();
    await expect(
      limited
        .or(page.getByRole('button', { name: 'User menu' }))
        .or(page.getByText(/Sign-up is closed|already an account/)),
    ).toBeVisible();
    if (!(await limited.isVisible())) return;
    await page.waitForTimeout(10_500);
  }
}

test.describe('an instance that signs in through Sovereign only', () => {
  test.use({ baseURL: SOVEREIGN, viewport: { width: 1280, height: 800 } });
  test.describe.configure({ mode: 'serial', timeout: 90_000 });

  test('offers Sovereign and nothing of the local ways, which are not there to find', async ({
    page,
  }) => {
    await page.goto('/sign-in');
    await expect(page.getByRole('button', { name: 'Sign in with Sovereign' })).toBeVisible();
    await expect(page.getByLabel('Password')).toHaveCount(0);
    await expect(page.getByRole('button', { name: /passkey/i })).toHaveCount(0);
    for (const path of ['/sign-up', '/forgot-password', '/reset-password']) {
      expect((await page.goto(path))?.status(), path).toBe(404);
    }
  });

  test('a person signs in as who Sovereign says they are, with a profile of their own, and signing out is local', async ({
    page,
  }) => {
    await nextPersonIs(page, FIRST);
    await page.goto('/sign-in');
    await throughSovereign(page);
    await expect(page.getByRole('button', { name: 'User menu' })).toBeVisible();
    await page.getByRole('button', { name: 'User menu' }).click();
    await expect(page.getByText(FIRST.name)).toBeVisible();
    await expect(page.getByText(FIRST.email)).toBeVisible();
    await page.keyboard.press('Escape');

    // Settings has the profile made from Sovereign's name and address.
    await page.goto('/settings');
    await expect(page.getByLabel('Name')).toHaveValue(FIRST.name);

    // Signing out ends this session, and not Sovereign's; the next sign-in is the same account.
    await signOut(page);
    await page.goto('/sign-in');
    await throughSovereign(page);
    await expect(page.getByRole('button', { name: 'User menu' })).toBeVisible();
    await signOut(page);
  });

  test('a second person is signed in too, though local sign-up is closed: a core decides who may sign in to it', async ({
    page,
  }) => {
    await nextPersonIs(page, SECOND);
    await page.goto('/sign-in');
    await throughSovereign(page);
    await expect(page.getByRole('button', { name: 'User menu' })).toBeVisible();
    await page.getByRole('button', { name: 'User menu' }).click();
    await expect(page.getByText(SECOND.name)).toBeVisible();
    await page.keyboard.press('Escape');
    await signOut(page);
  });

  test('a person who declines at Sovereign is told so and is not signed in', async ({ page }) => {
    await page.goto('/sign-in?error=access_denied');
    await expect(page.getByText(/You declined to share/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'User menu' })).toHaveCount(0);
  });

  test('an account that came in through Sovereign has no password to manage, and cannot unlink its only way in', async ({
    page,
  }) => {
    await nextPersonIs(page, FIRST);
    await page.goto('/sign-in');
    await throughSovereign(page);
    await expect(page.getByRole('button', { name: 'User menu' })).toBeVisible();

    await page.goto('/settings?section=security');
    await expect(page.getByRole('heading', { name: 'You sign in with Sovereign' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Change password' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Set up an authenticator app' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Add a passkey' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Unlink Sovereign' })).toBeDisabled();
    await expect(page.getByText('only way you can sign in')).toBeVisible();
    await signOut(page);
  });
});

/** A local account made on the instance that offers both ways, signed in. */
async function signUpLocal(page: Page, name: string): Promise<{ email: string; name: string }> {
  const email = `local-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;
  await page.goto('/sign-up');
  await page.getByLabel('Name').fill(name);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill('correct horse battery');
  const limited = page.getByText(/Too many tries/);
  for (let attempt = 0; attempt < 3; attempt++) {
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(limited.or(page.getByRole('button', { name: 'User menu' }))).toBeVisible();
    if (!(await limited.isVisible())) break;
    await page.waitForTimeout(10_500);
  }
  await expect(page.getByRole('button', { name: 'User menu' })).toBeVisible();
  return { email, name };
}

test.describe('an instance that offers both ways', () => {
  test.use({ baseURL: BOTH, viewport: { width: 1280, height: 800 } });
  test.describe.configure({ mode: 'serial', timeout: 90_000 });

  test('shows a password and Sovereign, and each signs in', async ({ page }) => {
    await page.goto('/sign-in');
    await expect(page.getByLabel('Password')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Sign in with Sovereign' })).toBeVisible();

    await nextPersonIs(page, {
      sub: 'e2e-both-1',
      email: 'both-one@sovereign.test',
      name: 'Katherine Johnson',
    });
    await throughSovereign(page);
    await expect(page.getByRole('button', { name: 'User menu' })).toBeVisible();
    await signOut(page);

    await signUpLocal(page, 'Local Ada');
    await signOut(page);
  });

  test('a Sovereign login with a local account’s address is refused, with what to do instead: an email match alone links nothing', async ({
    page,
  }) => {
    const { email } = await signUpLocal(page, 'Local Grace');
    await signOut(page);

    await nextPersonIs(page, { sub: `e2e-both-${Date.now()}`, email, name: 'Someone Else' });
    await page.goto('/sign-in');
    await throughSovereign(page);
    await expect(page).toHaveURL(/\/sign-in/);
    await expect(page.getByText(/already an account here/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'User menu' })).toHaveCount(0);
  });

  test('a local account links Sovereign from Settings, then signs in with it as the same account', async ({
    page,
  }) => {
    const { email, name } = await signUpLocal(page, 'Local Margaret');
    await nextPersonIs(page, {
      sub: `e2e-link-${Date.now()}`,
      email,
      name: 'Someone Else At Sovereign',
    });
    await page.goto('/settings?section=security');
    await expect(page.getByRole('button', { name: 'Change password' })).toBeVisible();
    await page.getByRole('button', { name: 'Link Sovereign' }).click();

    await expect(page).toHaveURL(/\/settings\?section=security&linked=1/);
    await expect(page.getByText('Sovereign is linked.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Unlink Sovereign' })).toBeEnabled();

    await signOut(page);
    await page.goto('/sign-in');
    await throughSovereign(page);
    // The account is the local one: its name, not the name Sovereign has for the person.
    await expect(page.getByRole('button', { name: 'User menu' })).toBeVisible();
    await page.getByRole('button', { name: 'User menu' }).click();
    await expect(page.getByText(name, { exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    await signOut(page);
  });

  test('a Sovereign account with a different address is refused with the reason, and nothing is linked', async ({
    page,
  }) => {
    await signUpLocal(page, 'Local Mary');
    await nextPersonIs(page, {
      sub: `e2e-other-${Date.now()}`,
      email: `other-${Date.now()}@sovereign.test`,
      name: 'Not The Same',
    });
    await page.goto('/settings?section=security');
    await page.getByRole('button', { name: 'Link Sovereign' }).click();

    await expect(page).toHaveURL(/\/settings\?section=security/);
    await expect(page.getByText(/different email address/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Link Sovereign' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Unlink Sovereign' })).toHaveCount(0);
    await signOut(page);
  });

  test('can be unlinked, after which the same Sovereign login is turned back with what to do', async ({
    page,
  }) => {
    const { email } = await signUpLocal(page, 'Local Dorothy');
    const who = { sub: `e2e-undo-${Date.now()}`, email, name: 'Same Person' };
    await nextPersonIs(page, who);
    await page.goto('/settings?section=security');
    await page.getByRole('button', { name: 'Link Sovereign' }).click();
    await expect(page.getByText('Sovereign is linked.')).toBeVisible();

    await page.getByRole('button', { name: 'Unlink Sovereign' }).click();
    await page.getByRole('button', { name: 'Unlink', exact: true }).click();
    await expect(page.getByText('Sovereign is unlinked.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Link Sovereign' })).toBeVisible();

    await signOut(page);
    await nextPersonIs(page, who);
    await page.goto('/sign-in');
    await throughSovereign(page);
    await expect(page.getByText(/already an account here/)).toBeVisible();
  });
});
