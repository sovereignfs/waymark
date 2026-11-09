/**
 * What a person chooses about how Tasks looks (Settings, Preferences): kept **in this browser** and applied at once, as for every session on the
 * device. It is not the account's, so it is not sent anywhere; without storage a choice lasts until the page is left. `script.ts` applies what is
 * kept before first paint.
 */
export const THEME_KEY = 'waymark.theme';

export type ThemeChoice = 'system' | 'light' | 'dark';

export const themeOf = (value: string | null): ThemeChoice =>
  value === 'light' || value === 'dark' ? value : 'system';

function read(storage: Pick<Storage, 'getItem'> | undefined, key: string): string | null {
  try {
    return storage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function write(
  storage: Pick<Storage, 'setItem' | 'removeItem'> | undefined,
  key: string,
  value: string | null,
) {
  try {
    if (value === null) storage?.removeItem(key);
    else storage?.setItem(key, value);
  } catch {
    // Not kept: it still applies to this page.
  }
}

export const readTheme = (storage?: Pick<Storage, 'getItem'>): ThemeChoice =>
  themeOf(read(storage, THEME_KEY));

/** Choose the theme: kept (`system` is the absence of a choice) and put on the page, following the system's scheme for `system`. */
export function chooseTheme(
  choice: ThemeChoice,
  root: { setAttribute(name: string, value: string): void },
  systemIsDark: boolean,
  storage?: Pick<Storage, 'setItem' | 'removeItem'>,
) {
  write(storage, THEME_KEY, choice === 'system' ? null : choice);
  root.setAttribute('data-theme', choice === 'system' ? (systemIsDark ? 'dark' : 'light') : choice);
}
