'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { MouseEvent } from 'react';
import { Drawer, Icon, Kbd } from '@sovereignfs/ui';
import { useMobileNav } from '../ui/mobile-nav';
import { useSidebar } from '../ui/useSidebar';
import { openCheckIn } from './checkin-location';
import { PLACES, isUnder } from './places';
import styles from './AppSidebar.module.css';

/**
 * The app's sidebar (DESIGN.md §20.2), at the left of every signed-in page: _Check in_ first, then the places. The Trips section is added in phase 2
 * (11.1). Full, or a rail of icons, remembered on this device; hidden is not drawn at all.
 */

/**
 * _Check in_, first and always one press away (DESIGN.md §20.2): a link whose address opens the sheet over this page, with the rest of the query kept. It is a real link, so that it can be opened in a new
 * tab or copied; a plain click is handled here so that the current query is the one kept. `C` is its shortcut.
 */
function CheckInLink({ rail, onNavigate }: { rail: boolean; onNavigate?: () => void }) {
  const open = (event: MouseEvent<HTMLAnchorElement>) => {
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    )
      return;
    event.preventDefault();
    onNavigate?.();
    // The history API and not the router, so that this needs no network (the sheet is a place to check in with none): see `checkin-location.ts`.
    openCheckIn();
  };
  return (
    <Link
      href="?checkin=new"
      className={`${styles.row} ${styles.checkin}`}
      onClick={open}
      aria-keyshortcuts="C"
      aria-label={rail ? 'Check in' : undefined}
      title={rail ? 'Check in (C)' : undefined}
    >
      <Icon name="plus" aria-hidden />
      {rail ? null : (
        <>
          <span className={styles.label}>Check in</span>
          <Kbd>C</Kbd>
        </>
      )}
    </Link>
  );
}

/** The places: what the sidebar holds, and what the phone's drawer holds too. */
function NavigationContent({
  rail,
  pathname,
  onNavigate,
}: {
  rail: boolean;
  pathname: string;
  onNavigate?: () => void;
}) {
  return (
    <ul className={styles.list}>
      <li>
        <CheckInLink rail={rail} {...(onNavigate ? { onNavigate } : {})} />
      </li>
      {PLACES.map((place) => (
        <li key={place.href}>
          <Link
            href={place.href}
            className={styles.row}
            onClick={onNavigate}
            aria-current={isUnder(pathname, place.under) ? 'page' : undefined}
            // A rail shows the icon alone, so the name is the label and the tooltip, and a full sidebar says it in words.
            aria-label={rail ? place.label : undefined}
            title={rail ? place.label : undefined}
          >
            <Icon name={place.icon} aria-hidden />
            {rail ? null : <span className={styles.label}>{place.label}</span>}
          </Link>
        </li>
      ))}
    </ul>
  );
}

/** The navigation as the phone's drawer shows it: the same places, full width, with no rail and no collapse. */
export function DrawerNavigation() {
  const nav = useMobileNav();
  const pathname = usePathname();
  return (
    <Drawer open={nav.open} onClose={() => nav.setOpen(false)} aria-label="Waymark">
      <nav className={styles.drawerNav} aria-label="Waymark">
        <NavigationContent rail={false} pathname={pathname} onNavigate={() => nav.setOpen(false)} />
      </nav>
    </Drawer>
  );
}

export function AppSidebar() {
  const pathname = usePathname();
  const sidebar = useSidebar();
  if (!sidebar.available || sidebar.state === 'hidden') return null;
  const rail = sidebar.state === 'rail';

  return (
    <nav
      className={`${styles.sidebar} ${rail ? styles.rail : ''}`}
      aria-label="Waymark"
      data-sidebar={sidebar.state}
    >
      <NavigationContent rail={rail} pathname={pathname} />
      <button
        type="button"
        className={styles.collapse}
        aria-label={rail ? 'Widen the sidebar' : 'Narrow the sidebar'}
        title={rail ? 'Widen the sidebar' : 'Narrow the sidebar'}
        onClick={sidebar.toggleRail}
      >
        <Icon name={rail ? 'panel-left-open' : 'panel-left-close'} aria-hidden />
      </button>
    </nav>
  );
}
