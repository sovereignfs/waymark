'use client';

import { usePathname } from 'next/navigation';
import { Icon, MobileFooter } from '@sovereignfs/ui';
import { useMobileNav } from '../ui/mobile-nav';
import { PLACES, isUnder } from './places';

/**
 * The phone's footer (DESIGN.md §20.12): the design system's `MobileFooter`, which publishes its own height as `--sv-shell-footer-height` so that sheets
 * and dialogs clear it. **Its middle button is named by the design system ("Apps")**, which an app cannot change; here it opens the navigation in a drawer,
 * the same places by the same addresses. It is drawn on a phone and not beside the sidebar, and it is `AppShell`'s `footer` slot: no route depends on it.
 *
 * Phase 1 has no Trips, so the right of the launcher is Map and Places; 7.7 settles the footer (Check in as a floating button, Places into the avatar
 * menu, Trips on the right once there are trips).
 */
export function PhoneFooter() {
  const pathname = usePathname();
  const nav = useMobileNav();
  const link = (href: string) => {
    const place = PLACES.find((each) => each.href === href);
    if (!place) throw new Error(`the footer names a place that is not there: ${href}`);
    return {
      icon: <Icon name={place.icon} aria-hidden />,
      label: place.label,
      href,
      active: isUnder(pathname, place.under),
    };
  };
  return (
    <MobileFooter
      leftIcons={[link('/'), link('/checkins')]}
      rightIcons={[link('/map'), link('/places')]}
      launcherIcon={<Icon name="menu" size="md" aria-hidden />}
      launcherOpen={nav.open}
      onOpenApps={() => nav.setOpen(true)}
    />
  );
}
