import { checkInHref, closedHref } from './checkin';

/**
 * The address the check-in sheet lives in, read and changed **directly** (DESIGN.md §20.3, §15): `window.location` and the history API, with the sheet told at once when either changes. Opening and closing do not go
 * through Next's router, which asks the server for the page again (and with no network, which is exactly when a person checks in, falls back to loading the page and fails); and they do not wait for Next to take
 * the new address up, which a busy page does late. Next keeps its own `usePathname` and `useSearchParams` in step with the history API, so the rest of the app sees the address as it is.
 */
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((listener) => listener());

/** Subscribes to changes of the address, ours and the browser's (the back button). Returns how to stop. */
export function subscribeLocation(listener: () => void): () => void {
  listeners.add(listener);
  window.addEventListener('popstate', listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('popstate', listener);
  };
}

/** The query as it is now, without the `?`. */
export const currentSearch = (): string => window.location.search.slice(1);
export const currentPath = (): string => window.location.pathname;

/** Opens the sheet over the page this is: a step in the history, so that the back button closes it. */
export function openCheckIn(): void {
  window.history.pushState(null, '', checkInHref(window.location.pathname, window.location.search));
  notify();
}

/** Closes the sheet: the address is put back as it was, without a step in the history. */
export function closeCheckIn(): void {
  window.history.replaceState(
    null,
    '',
    closedHref(window.location.pathname, window.location.search),
  );
  notify();
}
