'use client';

import { usePathname, useSearchParams } from 'next/navigation';
import { useCallback, useMemo, useSyncExternalStore } from 'react';
import { goTo, subscribeLocation } from './checkin-location';

/**
 * The address of the page as it is now, for a page that **draws what the address says** (DESIGN.md §20.3): the timeline reads `/c/<id>` and its filters from here, and changes them with `goTo`, which is the
 * history API, so that it asks the server for nothing and works with no network. Next's own `usePathname` and `useSearchParams` are read too, only so that this renders again when the app navigates by its router.
 */
export interface PageLocation {
  readonly path: string;
  readonly search: string;
  /** Changes the query's keys: a value puts it, `undefined` takes it away; the rest is kept. Replaces the current step of the history (a filter is not a page). */
  setQuery(patch: Record<string, string | undefined>): void;
  /** Goes to a path with a query, as a new step of the history. */
  push(url: string): void;
}

const snapshot = () => `${window.location.pathname}?${window.location.search.slice(1)}`;

export function usePageLocation(): PageLocation {
  usePathname();
  useSearchParams();
  const whole = useSyncExternalStore(subscribeLocation, snapshot, () => '/?');
  const at = whole.indexOf('?');
  const path = whole.slice(0, at);
  const search = whole.slice(at + 1);
  const setQuery = useCallback((patch: Record<string, string | undefined>) => {
    const params = new URLSearchParams(window.location.search);
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined || value === '') params.delete(key);
      else params.set(key, value);
    }
    const query = params.toString();
    goTo(`${window.location.pathname}${query ? `?${query}` : ''}`, 'replace');
  }, []);
  const push = useCallback((url: string) => void goTo(url, 'push'), []);
  return useMemo(() => ({ path, search, setQuery, push }), [path, search, setQuery, push]);
}
