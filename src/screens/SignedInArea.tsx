'use client';

import { type ReactNode, Suspense } from 'react';
import { ResponsiveSurface } from '@sovereignfs/ui';
import { AccountMenu } from '../auth/screens/AccountMenu';
import { LocalProvider } from '../local/LocalProvider';
import { site } from '../site';
import { AppShell } from '../ui/AppShell';
import { MobileNavProvider } from '../ui/mobile-nav';
import { SidebarToggle } from '../ui/SidebarToggle';
import { AppFrame } from './AppFrame';
import { CheckInSheet } from './CheckInSheet';
import { DrawerNavigation } from './AppSidebar';
import { NoticeBell } from './NoticeBell';
import { NoticesProvider } from './NoticesProvider';
import { PhoneFooter } from './PhoneFooter';
import { RegisterWorker } from './RegisterWorker';

/**
 * Everything for someone who is signed in (DESIGN.md §20.2): the shell and the page. **It is the one composition**, made by the server's layout from the
 * session when online, and by the offline shell from the identity kept on the device (6.4), so that the app is the same in both. The device's store and
 * its sync (6.2) are here, for an account; the notice bell (12.1) is here for an account, and the avatar menu's rest (2.7) is added by the task that makes it.
 */
export function SignedInArea({
  accountId,
  name,
  email,
  children,
}: {
  /** Which account's store to open on this device (6.2). Absent on the public shell page, which has no account and so keeps no data. */
  accountId?: string;
  /** Who is signed in, for the avatar menu. Absent on the public shell page, which holds nothing of a person. */
  name?: string;
  email?: string;
  children: ReactNode;
}) {
  const area = (
    <MobileNavProvider>
      <RegisterWorker />
      <AppShell
        name={site.name}
        toolbar={<SidebarToggle />}
        // The bell reads notices from the server, so it is for an account and absent on the offline shell, which holds nothing of a person.
        bell={accountId ? <NoticeBell /> : undefined}
        account={
          name !== undefined && email !== undefined ? (
            <AccountMenu name={name} email={email} />
          ) : undefined
        }
        // The footer, on a phone only (DESIGN.md §20.12): the design system's `ResponsiveSurface` draws it there and nothing beside the sidebar.
        footer={<ResponsiveSurface web={null} mobile={<PhoneFooter />} />}
      >
        <AppFrame>{children}</AppFrame>
        <DrawerNavigation />
        {/* The check-in sheet is in the address, and so is read on the client: a page that is built ahead of time needs a boundary to wait at. */}
        <Suspense fallback={null}>
          <CheckInSheet />
        </Suspense>
      </AppShell>
    </MobileNavProvider>
  );
  return accountId ? (
    <LocalProvider accountId={accountId}>
      <NoticesProvider>{area}</NoticesProvider>
    </LocalProvider>
  ) : (
    area
  );
}
