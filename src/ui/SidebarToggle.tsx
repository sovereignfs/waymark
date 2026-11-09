'use client';

import { Icon, useIsMobile } from '@sovereignfs/ui';
import { useMobileNav } from './mobile-nav';
import { useSidebar } from './useSidebar';
import styles from './AppShell.module.css';

/**
 * The header's button for the sidebar (DESIGN.md §20.2), a menu icon: hides it, and shows it again as it was. **On a phone the same button opens the navigation in a drawer**
 * (the sidebar and the lists, one column at a time), which is the same places by the same addresses: only what is drawn differs.
 */
export function SidebarToggle() {
  const sidebar = useSidebar();
  const mobile = useIsMobile();
  const nav = useMobileNav();
  if (mobile)
    return (
      <button
        type="button"
        className={styles.toggle}
        aria-label="Open the navigation"
        aria-haspopup="dialog"
        aria-expanded={nav.open}
        onClick={() => nav.setOpen(true)}
      >
        <Icon name="menu" aria-hidden />
      </button>
    );
  if (!sidebar.available) return null;
  const hidden = sidebar.state === 'hidden';
  return (
    <button
      type="button"
      className={styles.toggle}
      aria-label={hidden ? 'Show the sidebar' : 'Hide the sidebar'}
      aria-expanded={!hidden}
      onClick={sidebar.toggleHidden}
    >
      <Icon name="menu" aria-hidden />
    </button>
  );
}
