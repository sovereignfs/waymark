'use client';

import type { ReactNode } from 'react';
import { ResponsiveSurface } from '@sovereignfs/ui';
import { AccountMenu } from '../auth/screens/AccountMenu';
import { LocalProvider } from '../local/LocalProvider';
import { site } from '../site';
import { AppShell } from '../ui/AppShell';
import { MobileNavProvider } from '../ui/mobile-nav';
import { SidebarToggle } from '../ui/SidebarToggle';
import { AppFrame } from './AppFrame';
import { DrawerNavigation } from './AppSidebar';
import { PhoneFooter } from './PhoneFooter';
import { RegisterWorker } from './RegisterWorker';

/**
 * Everything for someone who is signed in (DESIGN.md §20.2): the shell and the page. **It is the one composition**, made by the server's layout from the
 * session when online, and by the offline shell from the identity kept on the device (6.4), so that the app is the same in both. The device's store and
 * its sync (6.2) are here, for an account; the notice bell (12.1) and the avatar menu (2.7) are added here by the tasks that make them.
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
      </AppShell>
    </MobileNavProvider>
  );
  return accountId ? <LocalProvider accountId={accountId}>{area}</LocalProvider> : area;
}
