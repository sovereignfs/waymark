import { getConfig } from '../config/current';
import { getAuthDatabase } from '../db/boot';
import { smtpMailer } from '../mail/smtp';
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
  holder[KEY] ??= getAuthDatabase()
    .then((database) => {
      const mail = getConfig().mail;
      return createAuth({
        settings,
        name: site.name,
        database,
        mailer: mail ? smtpMailer(mail) : undefined,
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
export async function signUpAvailable(): Promise<boolean> {
  const settings = authSettings();
  // Sign-up is a page of local sign-in; a person who comes through Sovereign is made at their first sign-in (under the same policy, in the hook).
  if (!settings?.local) return false;
  if (settings.signUp === 'open') return true;
  return (await countUsers(await getAuthDatabase())) === 0;
}
