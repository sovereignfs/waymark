/**
 * Who is signed in on this device, kept **on the device** so that the offline shell can open the app with no server to ask (DESIGN.md §20.12). It is the person's id, name and address: what the account menu shows
 * and which store to open. It is written by every signed-in page, read only by the shell, and **removed when the person signs out** (`forgetIdentity`), as the device's database is. It is never in the service worker's
 * cache, nor in any page the worker keeps: those hold nothing of a person. Shared with Tusk's `src/identity.ts`, whose shape it is.
 */
export const IDENTITY_KEY = 'waymark.me';

export interface Identity {
  readonly id: string;
  readonly name: string;
  readonly email: string;
}

/** Reads what a stored value says, or nothing for anything that is not exactly an identity. */
export function parseIdentity(text: string | null): Identity | null {
  if (!text) return null;
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== 'object' || value === null) return null;
    const { id, name, email } = value as Record<string, unknown>;
    if (
      typeof id !== 'string' ||
      id === '' ||
      typeof name !== 'string' ||
      typeof email !== 'string'
    )
      return null;
    return { id, name, email };
  } catch {
    return null;
  }
}

export function rememberIdentity(identity: Identity): void {
  try {
    window.localStorage.setItem(IDENTITY_KEY, JSON.stringify(identity));
  } catch {
    // Storage that is full or blocked: the shell then has no one to open for, and says to sign in.
  }
}

export function readIdentity(): Identity | null {
  try {
    return parseIdentity(window.localStorage.getItem(IDENTITY_KEY));
  } catch {
    return null;
  }
}

export function forgetIdentity(): void {
  try {
    window.localStorage.removeItem(IDENTITY_KEY);
  } catch {
    // Nothing to remove from.
  }
}
