'use client';

import { usePathname } from 'next/navigation';
import { FloatingActionButton, Icon, MobileFooter } from '@sovereignfs/ui';
import { useMobileNav } from '../ui/mobile-nav';
import { openCheckIn } from './checkin-location';
import { PLACES, TRIPS_PLACE, isUnder } from './places';

/**
 * The phone's footer (DESIGN.md §20.12): the design system's `MobileFooter`, which publishes its own height as `--sv-shell-footer-height` so that sheets
 * and dialogs clear it. **Its middle button is named by the design system ("Apps")**, which an app cannot change; here it opens the navigation in a drawer,
 * the same places by the same addresses. It is drawn on a phone and not beside the sidebar, and it is `AppShell`'s `footer` slot: no route depends on it.
 *
 * Home and Check-ins are left of the launcher and **Map and Trips right of it**, as the design has it. **_Check in_ is the floating button above it**, and Places is in the avatar menu (and the launcher's navigation).
 */
export function PhoneFooter() {
  const pathname = usePathname();
  const nav = useMobileNav();
  const link = (href: string) => {
    const place =
      href === TRIPS_PLACE.href ? TRIPS_PLACE : PLACES.find((each) => each.href === href);
    if (!place) throw new Error(`the footer names a place that is not there: ${href}`);
    return {
      icon: <Icon name={place.icon} aria-hidden />,
      label: place.label,
      href,
      active: isUnder(pathname, place.under),
    };
  };
  return (
    <>
      <MobileFooter
        leftIcons={[link('/'), link('/checkins')]}
        rightIcons={[link('/map'), link('/trips')]}
        launcherIcon={<Icon name="menu" size="md" aria-hidden />}
        launcherOpen={nav.open}
        onOpenApps={() => nav.setOpen(true)}
      />
      {/* The phone's one main action (DESIGN.md §20.12): _Check in_, floating above the footer, which opens the drawer; the same action as the sidebar's, by the same way (the history API, so it asks for nothing). */}
      <FloatingActionButton
        label="Check in"
        icon={<Icon name="plus" aria-hidden />}
        onClick={() => openCheckIn()}
      />
    </>
  );
}
