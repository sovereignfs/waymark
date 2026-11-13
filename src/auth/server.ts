import { getConfig } from '../config/current';
import { serverSealer } from '../crypto/server';
import { getAuthDatabase, getDatabase } from '../db/boot';
import { claimInvitations, invitationIsOpen } from '../invitations/service';
import { serverInvite } from '../invitations/server';
import { rememberCoreToken } from '../sovereign/tokens';
import { createProfile } from '../profile/profile';
import { outboxMailer } from '../mail/outbox';
import { site } from '../site';
import { type Auth, createAuth } from './auth';
import type { AuthSettings } from './config';
import { countUsers } from './users';

/**
 * The server's view of sign-in: the settings and the better-auth instance. Used by pages and routes, never by a test (which makes its own with
 * `createAuth`). With no way of signing in on, `getAuth()` is null and everything that needs it answers 404: there is no sign-in, not a disabled
 * one (DESIGN.md §6).
 */
const KEY = Symbol.for('waymark.auth');
type Holder = { [KEY]?: Promise<Auth> | undefined };

/** The sign-in settings, or undefined when no way of signing in is on. */
export function authSettings(): AuthSettings | undefined {
  return getConfig().auth;
}

export function getAuth(): Promise<Auth | null> {
  const settings = authSettings();
  if (!settings) return Promise.resolve(null);
  // On `globalThis`, because the development server reloads modules and a second instance must not be made.
  const holder = globalThis as Holder;
  holder[KEY] ??= Promise.all([getAuthDatabase(), getDatabase()])
    .then(([database, appDatabase]) => {
      const mail = getConfig().mail;
      return createAuth({
        settings,
        name: site.name,
        database,
        // Verification and reset mail is queued and sent by a job (DESIGN.md §17.2), so a slow mail server holds no request and a failure is tried again.
        mailer: mail
          ? outboxMailer({ database: appDatabase, sealer: serverSealer(), now: Date.now })
          : undefined,
        // Under the sign-up policy `invite`, an account may be made by whoever holds an invitation that can still be used.
        invitationOpen: async (token) => invitationIsOpen(await getDatabase(), Date.now(), token),
        // A sign-in through core: its refresh token is kept sealed for the directory, and the invitations made for the person's `sub` are taken (DESIGN.md §19.3, §11.2).
        onSovereignSignIn: async ({ accountId, sub, refreshToken }) => {
          if (refreshToken)
            await rememberCoreToken(
              { database: await getDatabase(), sealer: serverSealer(), now: Date.now },
              accountId,
              sub,
              refreshToken,
            );
          await claimInvitations(await serverInvite(), accountId, sub);
        },
        // Waymark's own copy of the person's name and address, made with the account (2.7).
        onAccountCreated: async (account) => {
          await createProfile(
            await getDatabase(),
            serverSealer(),
            { accountId: account.id, name: account.name, email: account.email },
            Date.now(),
          );
        },
      });
    })
    .catch((error: unknown) => {
      holder[KEY] = undefined;
      throw error;
    });
  return holder[KEY];
}

/** Whether this server can send mail: then addresses are verified and a forgotten password is reset by a link (DESIGN.md §6). */
export function mailAvailable(): boolean {
  return getConfig().mail !== undefined && authSettings()?.local === true;
}

/**
 * Whether a new account can be made: yes if sign-up is open, yes for the very first account whatever the setting (someone has to be first), and
 * otherwise no. The server enforces the same rule where an account is created, so this only decides what the page offers.
 */
export async function signUpAvailable(invitation?: string): Promise<boolean> {
  const settings = authSettings();
  // Sign-up is a page of local sign-in; a person who comes through Sovereign is made at their first sign-in (under the same policy, in the hook).
  if (!settings?.local) return false;
  if (settings.signUp === 'open') return true;
  if ((await countUsers(await getAuthDatabase())) === 0) return true;
  // `invite`: with an invitation that can still be used (the server asks it again where the account is made).
  return (
    settings.signUp === 'invite' &&
    invitation !== undefined &&
    (await invitationIsOpen(await getDatabase(), Date.now(), invitation))
  );
}
