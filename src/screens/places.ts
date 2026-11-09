import type { IconName } from '@sovereignfs/ui';

/**
 * The places of the shell (DESIGN.md §20.2), in the order the sidebar shows them, with what the phone's footer and drawer use of them. **An entry is here
 * only when its page is**: a link to a page that is not there is worse than none, which is why Trips (phase 2) is not here yet. _Check in_ is not a place but
 * an action, and is drawn first by the sidebar (7.2 gives it its sheet).
 */
export interface Place {
  href: string;
  label: string;
  icon: IconName;
  /** The addresses that are this place's, for the one that is current. */
  under: readonly string[];
}

export const PLACES: readonly Place[] = [
  { href: '/', label: 'Home', icon: 'house', under: ['/'] },
  { href: '/checkins', label: 'Check-ins', icon: 'list', under: ['/checkins', '/c'] },
  { href: '/map', label: 'Map', icon: 'map-pin', under: ['/map'] },
  { href: '/places', label: 'Places', icon: 'pin', under: ['/places'] },
];

export const isUnder = (pathname: string, prefixes: readonly string[]) =>
  prefixes.some(
    (prefix) => pathname === prefix || (prefix !== '/' && pathname.startsWith(`${prefix}/`)),
  );
