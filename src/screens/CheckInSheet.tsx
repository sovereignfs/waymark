'use client';

import { usePathname, useSearchParams } from 'next/navigation';
import { useEffect, useSyncExternalStore } from 'react';
import { CheckInContent } from './CheckInContent';
import { CheckInSurface } from './CheckInSurface';
import { isCheckInKey, isCheckInOpen } from './checkin';
import { closeCheckIn, currentSearch, openCheckIn, subscribeLocation } from './checkin-location';

/**
 * The check-in sheet (DESIGN.md §20.2, §20.3): **open when the address says `?checkin=new`, over whatever page that is**. Closing it (Escape, its close button, or the back button) puts the address back as it was, so
 * the person is where they were. The address is read and changed directly (`checkin-location.ts`), so that the sheet opens and closes **at once and with no network**. **A sheet on a wide screen and a drawer on a
 * narrow one, with the same content** (`CheckInSurface`): only what is rendered forks, never where it is or how it is reached. `C` opens it from anywhere that is not a place to type.
 */
export function CheckInSheet() {
  // Next's own address, read only so that this renders again when the app navigates (another page closes the sheet); what decides is the address as it is.
  usePathname();
  useSearchParams();
  const search = useSyncExternalStore(subscribeLocation, currentSearch, () => '');
  const open = isCheckInOpen(search);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (open || !isCheckInKey(event)) return;
      event.preventDefault();
      openCheckIn();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  return (
    <CheckInSurface open={open} onClose={closeCheckIn}>
      <CheckInContent onDone={closeCheckIn} />
    </CheckInSurface>
  );
}
