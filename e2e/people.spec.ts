import { randomUUID } from 'node:crypto';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { PORTS } from './ports';
import { signedIn, trySignIn } from './helpers';

/**
 * A trip's People (DESIGN.md §11, §20.10), in real browsers: an Organizer sees who is in the trip and what they may do about each, makes invitations (a link with its QR code, an address) and withdraws them; and **an invitation made
 * here is accepted in a second browser** on an instance that takes accounts by invitation, where the new member appears with their role. Followers and Travelers, who have none of these controls, are in `e2e/trip.spec.ts`.
 */
test.use({ viewport: { width: 1280, height: 900 }, actionTimeout: 15_000 });
expect.configure({ timeout: 15_000 });

const PASSWORD = 'correct horse battery';

async function op<T = Record<string, unknown>>(
  page: Page,
  origin: string,
  body: Record<string, unknown>,
) {
  const reply = await page.request.post('/api/ops', { headers: { origin }, data: body });
  expect(reply.ok()).toBe(true);
  const json = (await reply.json()) as { ok: boolean } & T;
  expect(json.ok).toBe(true);
  return json;
}

test('an Organizer sees the people, makes invitations by link and by address, and withdraws them', async ({
  page,
}) => {
  await signedIn(page);
  const origin = `http://localhost:${PORTS.app}`;
  const { trip } = await op<{ trip: { id: string } }>(page, origin, {
    op: 'trip.create',
    name: `People ${randomUUID().slice(0, 6)}`,
  });
  await page.goto(`/t/${trip.id}?view=people`);

  // The only person: the Organizer, who is going; the last Organizer cannot change their own role.
  const members = page.getByRole('list', { name: 'Members' });
  await expect(members.getByRole('listitem')).toHaveCount(1);
  await expect(members).toContainText('(you)');
  await expect(members.getByRole('combobox', { name: /^Role of / })).toBeDisabled();
  await expect(members.getByRole('switch', { name: 'I am going' })).toBeChecked();
  await expect(members.getByRole('button', { name: /^Remove / })).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Waiting to join' })).toContainText(
    'No one is waiting',
  );

  // A link, with its QR code, shown once, and then waiting.
  await page.getByRole('button', { name: 'Invite' }).click();
  const invite = page.getByRole('dialog', { name: 'Invite someone' });
  await invite.getByLabel('Role').selectOption('follower');
  await invite.getByRole('button', { name: 'Make the invitation' }).click();
  const made = page.getByRole('dialog', { name: 'Invitation made' });
  const link = await made.getByLabel('The invitation link').inputValue();
  expect(link).toMatch(/\/invite\/[A-Za-z0-9_-]{43}$/);
  await expect(made.getByRole('img', { name: 'The invitation link as a QR code' })).toBeVisible();
  await expect(made.getByRole('button', { name: 'Copy the link' })).toBeVisible();
  await made.getByRole('button', { name: 'Done' }).click();
  const waiting = page.getByRole('region', { name: 'Waiting to join' });
  await expect(waiting).toContainText('Anyone with the link');
  await expect(waiting).toContainText('Follower');

  // By address: this server has no mail, and says the link is the only way.
  await page.getByRole('button', { name: 'Invite' }).click();
  const byMail = page.getByRole('dialog', { name: 'Invite someone' });
  await byMail.getByLabel('How').selectOption('email');
  await byMail.getByLabel('Email address').fill('noor@example.com');
  await byMail.getByRole('button', { name: 'Make the invitation' }).click();
  await expect(page.getByRole('dialog', { name: 'Invitation made' })).toContainText(
    'cannot send email',
  );
  await page
    .getByRole('dialog', { name: 'Invitation made' })
    .getByRole('button', { name: 'Done' })
    .click();
  await expect(waiting).toContainText('noor@example.com');

  // An address that is not one is refused in words; and a name that no one has is not offered.
  await page.getByRole('button', { name: 'Invite' }).click();
  const bad = page.getByRole('dialog', { name: 'Invite someone' });
  await bad.getByLabel('How').selectOption('email');
  await bad.getByLabel('Email address').fill('a@b');
  await bad.getByRole('button', { name: 'Make the invitation' }).click();
  await expect(bad.getByRole('alert')).toContainText('email address');
  await bad.getByLabel('How').selectOption('person');
  await bad.getByLabel('Name').fill('Nobody Here');
  await expect(bad.getByText(/No one you share a trip with/)).toBeVisible();
  await bad.getByRole('button', { name: 'Cancel' }).click();

  // Withdrawn: gone from the list; and a link that was withdrawn is a page that cannot be used, as is any other that cannot.
  await waiting
    .getByRole('button', { name: 'Withdraw the invitation of noor@example.com' })
    .click();
  await expect(waiting).not.toContainText('noor@example.com');
  await page.goto(new URL(link).pathname);
  await expect(page.getByRole('button', { name: 'Join the trip' })).toBeVisible();
  await page.goto(`/t/${trip.id}?view=people`);
  await page
    .getByRole('button', { name: 'Withdraw the invitation of Anyone with the link' })
    .click();
  await expect(waiting).toContainText('No one is waiting');
  await page.goto(new URL(link).pathname);
  await expect(page.getByRole('heading', { name: 'This invitation cannot be used' })).toBeVisible();

  // The only one in the trip is told to delete it rather than leave.
  await page.goto(`/t/${trip.id}?view=people`);
  await page.getByRole('button', { name: 'Leave the trip' }).first().click();
  await expect(page.getByRole('dialog', { name: 'Leave the trip?' })).toContainText(
    'only one in this trip',
  );
});

/** A browser of its own, which is a person of its own, on the instance that takes accounts by invitation. */
async function person(browser: Browser) {
  const context = await browser.newContext({
    baseURL: `http://localhost:${PORTS.invite}`,
    viewport: { width: 1280, height: 900 },
  });
  return { context, page: await context.newPage() };
}

async function signUp(page: Page, name: string, email: string) {
  await page.getByLabel('Name').fill(name);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Create account' }).click();
}

test('an invitation made here is accepted in a second browser, and the new member appears with their role', async ({
  browser,
}) => {
  const origin = `http://localhost:${PORTS.invite}`;
  // An address of this run's own: the instance keeps its accounts between the two browsers.
  const graceEmail = `grace-${randomUUID().slice(0, 6)}@example.com`;
  const owner = await person(browser);
  const guest = await person(browser);
  const stranger = await person(browser);
  try {
    // The first account is made with no invitation; sign-up is then not offered to someone with none. The instance keeps its accounts between the two browsers, so the second browser's run finds Ada there and signs in.
    await owner.page.goto('/sign-up');
    const first = owner.page.getByLabel('Name');
    const closed = owner.page.getByRole('heading', { name: 'Sign-up is closed' });
    await expect(first.or(closed)).toBeVisible();
    if (await first.isVisible()) {
      await signUp(owner.page, 'Ada', 'ada@example.com');
    } else {
      await trySignIn(owner.page, 'ada@example.com', PASSWORD);
    }
    await expect(owner.page.getByRole('button', { name: 'User menu' })).toBeVisible();
    await stranger.page.goto('/sign-up');
    await expect(stranger.page.getByRole('heading', { name: 'Sign-up is closed' })).toBeVisible();

    const name = `Japan ${randomUUID().slice(0, 6)}`;
    const { trip } = await op<{ trip: { id: string } }>(owner.page, origin, {
      op: 'trip.create',
      name,
    });
    await owner.page.goto(`/t/${trip.id}?view=people`);
    await owner.page.getByRole('button', { name: 'Invite' }).click();
    const dialog = owner.page.getByRole('dialog', { name: 'Invite someone' });
    await dialog.getByLabel('Role').selectOption('traveler');
    await dialog.getByRole('button', { name: 'Make the invitation' }).click();
    const link = await owner.page.getByLabel('The invitation link').inputValue();
    const invitePath = new URL(link).pathname;
    await owner.page.getByRole('button', { name: 'Done' }).click();

    // The link shows the trip and who invited, and nothing else, to someone who is not signed in.
    await guest.page.goto(invitePath);
    await expect(guest.page.getByRole('heading', { name })).toBeVisible();
    await expect(guest.page.getByText(/Ada invited you/)).toBeVisible();
    await expect(guest.page.getByText(/Traveler|organizer|follower/i)).toHaveCount(0);

    // They create an account from it (sign-up is by invitation here), and come back to it to join.
    await guest.page.getByRole('link', { name: 'create an account' }).click();
    await expect(guest.page).toHaveURL(/\/sign-up\?invite=/);
    await signUp(guest.page, 'Grace', graceEmail);
    await expect(guest.page).toHaveURL(new RegExp(`${invitePath}$`));
    await guest.page.getByRole('button', { name: 'Join the trip' }).click();
    await expect(guest.page).toHaveURL(new RegExp(`/t/${trip.id}$`));
    await expect(guest.page.getByRole('heading', { level: 1, name })).toBeVisible();
    await expect(guest.page.locator('header', { hasText: name })).toContainText('Traveler');

    // The Organizer has them, with their role, and nothing is waiting any more.
    await owner.page.goto(`/t/${trip.id}?view=people`);
    const grace = owner.page.locator('[data-member]').filter({ hasText: 'Grace' });
    await expect(grace).toBeVisible();
    await expect(grace.getByRole('combobox', { name: 'Role of Grace' })).toHaveValue('traveler');
    await expect(owner.page.getByRole('region', { name: 'Waiting to join' })).toContainText(
      'No one is waiting',
    );
    // An Organizer sees an address; the Traveler does not see one of the Organizer.
    await expect(grace).toContainText(graceEmail);
    await guest.page.goto(`/t/${trip.id}?view=people`);
    await expect(guest.page.getByRole('list', { name: 'Members' })).toContainText('Ada');
    await expect(guest.page.getByRole('list', { name: 'Members' })).not.toContainText(
      'ada@example.com',
    );
    await expect(guest.page.getByRole('button', { name: 'Invite' })).toHaveCount(0);

    // A link is single-use: the same link is the same page as any other that cannot be used.
    await stranger.page.goto(invitePath);
    await expect(
      stranger.page.getByRole('heading', { name: 'This invitation cannot be used' }),
    ).toBeVisible();
    await stranger.page.goto('/invite/' + 'x'.repeat(43));
    await expect(
      stranger.page.getByRole('heading', { name: 'This invitation cannot be used' }),
    ).toBeVisible();
    // And sign-up is still closed to anyone without one.
    await stranger.page.goto(`/sign-up?invite=${'x'.repeat(43)}`);
    await expect(stranger.page.getByRole('heading', { name: 'Sign-up is closed' })).toBeVisible();

    // The Organizer changes their role; the Traveler has it on their device once it syncs.
    await grace.getByRole('combobox', { name: 'Role of Grace' }).selectOption('follower');
    await expect(grace.getByRole('combobox', { name: 'Role of Grace' })).toHaveValue('follower');
    await guest.page.reload();
    await expect(
      guest.page
        .getByRole('navigation', { name: 'Views of the trip' })
        .getByRole('link', { name: 'Files' }),
    ).toHaveCount(0);

    // And removes them: the trip is not there for them any more.
    await grace.getByRole('button', { name: 'Remove Grace' }).click();
    await owner.page.getByRole('button', { name: 'Remove them' }).click();
    await expect(owner.page.locator('[data-member]').filter({ hasText: 'Grace' })).toHaveCount(0);
    await guest.page.reload();
    await expect(guest.page.getByRole('heading', { name: 'This trip is not here' })).toBeVisible();
  } finally {
    await owner.context.close();
    await guest.context.close();
    await stranger.context.close();
  }
});
