'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useEffect } from 'react';
import { CheckInContent } from './CheckInContent';
import { CheckInSurface } from './CheckInSurface';
import { checkInHref, closedHref, isCheckInKey, isCheckInOpen } from './checkin';

/**
 * The check-in sheet (DESIGN.md §20.2, §20.3): **open when the address says `?checkin=new`, over whatever page that is**. Closing it (Escape, its close button, or the back button) puts the address back as it
 * was, so the person is where they were. **A sheet on a wide screen and a drawer on a narrow one, with the same content** (`CheckInSurface`): only what is rendered forks, never where it is or how it is reached. `C` opens it from
 * anywhere that is not a place to type.
 */
export function CheckInSheet() {
  const pathname = usePathname();
  const params = useSearchParams();
  const router = useRouter();
  const open = isCheckInOpen(params);
  const search = params.toString();

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (open || !isCheckInKey(event)) return;
      event.preventDefault();
      router.push(checkInHref(pathname, search), { scroll: false });
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, pathname, search, router]);

  const close = () => router.replace(closedHref(pathname, search), { scroll: false });
  return (
    <CheckInSurface open={open} onClose={close}>
      <CheckInContent />
    </CheckInSurface>
  );
}
