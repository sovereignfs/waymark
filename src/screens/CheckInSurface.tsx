'use client';

import type { ReactNode } from 'react';
import { Drawer, Sheet, useIsMobile } from '@sovereignfs/ui';

/**
 * What the check-in is drawn on (DESIGN.md §20.2): **a `Sheet` on a wide screen and a `Drawer` on a narrow one, with the same content.** This is the whole of what the width decides about it, which is why it is
 * a file of its own that does nothing else: when it opens and what closes it are `CheckInSheet`'s, and are the same at every width (`src/ui/no-fork.test.ts`).
 */
export function CheckInSurface({
  open,
  onClose,
  children,
}: {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  const mobile = useIsMobile();
  if (mobile)
    return (
      <Drawer open={open} onClose={onClose} title="Check in" aria-label="Check in">
        {children}
      </Drawer>
    );
  return (
    <Sheet open={open} onClose={onClose} title="Check in" aria-label="Check in">
      {children}
    </Sheet>
  );
}
