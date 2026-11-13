'use client';

import { useEffect, useState } from 'react';

/**
 * Whether the app's own map is there, and which style to draw it in (DESIGN.md §8.1, §20.12). The style is the server's (`/api/map/style/<theme>.json`), in light or dark as the page is (`data-theme` on the root, which
 * the theme script sets and keeps); with `WAYMARK_MAP_SOURCE=off` it is not found, and with no connection it cannot be asked: either way the screen draws the list of the same places and says why there is no map.
 */
export type MapStyle =
  | { readonly status: 'checking' }
  | { readonly status: 'on'; readonly url: string }
  | { readonly status: 'off' }
  | { readonly status: 'unavailable' };

const themeOf = (): 'light' | 'dark' =>
  document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';

export function useMapStyle(): MapStyle {
  const [theme, setTheme] = useState<'light' | 'dark'>('light');
  const [state, setState] = useState<MapStyle>({ status: 'checking' });

  useEffect(() => {
    setTheme(themeOf());
    const observer = new MutationObserver(() => setTheme(themeOf()));
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const url = `/api/map/style/${theme}.json`;
    const controller = new AbortController();
    fetch(url, { credentials: 'same-origin', signal: controller.signal }).then(
      (reply) =>
        setState(
          reply.ok
            ? { status: 'on', url }
            : { status: reply.status === 404 ? 'off' : 'unavailable' },
        ),
      (error: unknown) => {
        if ((error as { name?: string }).name !== 'AbortError') setState({ status: 'unavailable' });
      },
    );
    return () => controller.abort();
  }, [theme]);

  return state;
}
