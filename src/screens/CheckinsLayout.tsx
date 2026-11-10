'use client';

import type { ReactNode } from 'react';
import { EmptyState, SplitPane, useIsMobile } from '@sovereignfs/ui';

/**
 * How the timeline and a check-in are laid out (DESIGN.md §20.6): **on a wide screen a selected check-in opens beside the list; on a narrow one it is a page of its own.** This is the whole of what the width
 * decides, in a file that does nothing else: the address is `/c/<id>` at every width, and what is selected, fetched and changed is `CheckinsView`'s (`src/ui/no-fork.test.ts`).
 */
export function CheckinsLayout({
  list,
  detail,
}: {
  list: ReactNode;
  detail: ReactNode | undefined;
}) {
  const mobile = useIsMobile();
  if (mobile) return <>{detail ?? list}</>;
  return (
    <SplitPane
      primary={list}
      secondary={
        detail ?? (
          <EmptyState icon="list" heading="Choose a check-in" description="It opens here." />
        )
      }
      defaultPrimarySize={42}
      minPrimarySize={30}
      maxPrimarySize={65}
      primaryLabel="Check-ins"
      secondaryLabel="Check-in"
    />
  );
}
