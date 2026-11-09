'use client';

import { type ReactNode, createContext, useContext, useMemo, useState } from 'react';

/**
 * Whether the phone's navigation drawer is open (DESIGN.md §20.12). Held above the header, whose button opens it, and the columns, which hold what is in it.
 * It decides nothing but whether a drawer is drawn: **no address, no data and no route depends on it** (`src/ui/no-fork.test.ts` holds the code to that).
 */
interface MobileNav {
  open: boolean;
  setOpen(open: boolean): void;
}

const Context = createContext<MobileNav>({ open: false, setOpen: () => undefined });

export function MobileNavProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const value = useMemo(() => ({ open, setOpen }), [open]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export const useMobileNav = (): MobileNav => useContext(Context);
