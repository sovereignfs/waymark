'use client';

import { usePathname } from 'next/navigation';
import { useCallback, useMemo, useSyncExternalStore } from 'react';
import { useIsMobile } from '@sovereignfs/ui';
import {
  type PageKind,
  STORAGE_KEY,
  type SidebarState,
  type Stored,
  pageKind,
  parseStored,
  stateFor,
  toggleHidden,
  toggleRail,
} from './sidebar';

const EVENT = 'waymark:sidebar';

/** The stored text, or null: a private window, blocked site data and a browser with no storage all read as nothing, and the default stands. */
function read(): string | null {
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener('storage', onChange);
  window.addEventListener(EVENT, onChange);
  return () => {
    window.removeEventListener('storage', onChange);
    window.removeEventListener(EVENT, onChange);
  };
}

/**
 * How the sidebar is shown on this page, on this device (DESIGN.md §20.2). The server and the first paint show the default for the kind of page, so
 * that the two agree; what the person chose before is read straight after, and a change in another tab is followed. **On a phone it is not shown at all**
 * (it is the footer's, 7.7), whatever was chosen on a desktop.
 */
export function useSidebar(): {
  kind: PageKind;
  state: SidebarState;
  /** Whether there is a sidebar to toggle at this width. */
  available: boolean;
  toggleHidden(): void;
  toggleRail(): void;
} {
  const pathname = usePathname();
  const mobile = useIsMobile();
  const raw = useSyncExternalStore(subscribe, read, () => null);
  const kind = pageKind(pathname);
  const stored = useMemo(() => parseStored(raw), [raw]);

  const write = useCallback((next: Stored) => {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      // Not kept: it holds for this page view, and the default is back at the next.
    }
    window.dispatchEvent(new Event(EVENT));
  }, []);

  return {
    kind,
    state: mobile ? 'hidden' : stateFor(kind, stored),
    available: !mobile,
    toggleHidden: () => write(toggleHidden(kind, parseStored(read()))),
    toggleRail: () => write(toggleRail(kind, parseStored(read()))),
  };
}
