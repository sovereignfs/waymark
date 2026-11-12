/**
 * The addresses the worker answers with the kept shell when there is no network (DESIGN.md §20.12; 6.4): Home, Check-ins, a check-in, Map, Places and a place, which the shell draws from the device's own store.
 * **One list, for the worker and for the shell**: the worker is a string with no imports, so it is given the patterns' sources, and `OfflineApp` chooses the screen with `offlineScreenOf`, which a test holds to the
 * same patterns. Anything else (Settings, notices, importing, exporting, the sign-in pages) needs a network and gets the offline page.
 */
export type OfflineScreen = 'home' | 'checkins' | 'map' | 'places';

const ID = '[0-9a-zA-Z_-]{1,64}';

export const OFFLINE_ADDRESSES: readonly {
  readonly screen: OfflineScreen;
  readonly pattern: RegExp;
}[] = [
  { screen: 'home', pattern: /^\/(home)?$/ },
  { screen: 'checkins', pattern: /^\/checkins$/ },
  { screen: 'checkins', pattern: new RegExp(`^/c/${ID}$`) },
  { screen: 'map', pattern: /^\/map$/ },
  { screen: 'places', pattern: /^\/places$/ },
  { screen: 'places', pattern: new RegExp(`^/places/${ID}$`) },
];

/** Which screen of the offline shell an address is, or `undefined` for one that is not kept (a path with a trailing slash is not the same address). */
export function offlineScreenOf(pathname: string): OfflineScreen | undefined {
  return OFFLINE_ADDRESSES.find((each) => each.pattern.test(pathname))?.screen;
}

/** The patterns' sources, for the worker's text. */
export const offlineAddressSources = (): string[] =>
  OFFLINE_ADDRESSES.map((each) => each.pattern.source);
