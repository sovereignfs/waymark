'use client';

import { usePathname, useSearchParams } from 'next/navigation';
import { useEffect, useSyncExternalStore } from 'react';
import { CheckInContent } from './CheckInContent';
import { CheckInSurface } from './CheckInSurface';
import { checkInMode, isCheckInKey } from './checkin';
import { useLocal } from '../local/LocalProvider';
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
  const mode = checkInMode(search);
  const open = mode !== undefined;
  const local = useLocal();
  const editing =
    mode?.mode === 'edit' ? local?.checkins.find((each) => each.id === mode.id) : undefined;

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
    <CheckInSurface
      open={open}
      onClose={closeCheckIn}
      title={mode?.mode === 'edit' ? 'Change check-in' : 'Check in'}
    >
      {mode?.mode === 'edit' ? (
        // The form is filled in from the check-in, so it is made once the check-in is there (the store is read a moment after the page opens), and again for another.
        editing ? (
          <CheckInContent key={editing.id} editing={editing} onDone={closeCheckIn} />
        ) : (
          <p role="status">
            {local?.ready ? 'That check-in is not on this device any more.' : 'Loading…'}
          </p>
        )
      ) : (
        <CheckInContent
          // From Trip Mode: the item the check-in is for, so its place is on offer first and the check-in is of its trip.
          key={mode?.mode === 'new' ? (mode.from?.itemId ?? 'new') : 'new'}
          {...(mode?.mode === 'new' && mode.from ? { from: mode.from } : {})}
          onDone={closeCheckIn}
        />
      )}
    </CheckInSurface>
  );
}
