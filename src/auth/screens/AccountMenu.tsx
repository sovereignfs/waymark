'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { ConfirmDialog, UserMenu } from '@sovereignfs/ui';
import { authClient } from '../client';

/**
 * The avatar menu at the right of the header: who the person is (name and address) and *Sign out*. Signing out ends the session; leaving the device's store
 * (sending what can be sent, asking before throwing away what cannot, and deleting this person's data from the device) joins with the store (6.2), and the rest of
 * the menu (Places, Notifications, Import, Couldn't sync) with the tasks that make them.
 */
export function AccountMenu({ name, email }: { name: string; email: string }) {
  const router = useRouter();
  const [leaving, setLeaving] = useState(false);
  const [failed, setFailed] = useState(false);

  async function signOut() {
    setFailed(false);
    setLeaving(true);
    const { error } = await authClient.signOut();
    setLeaving(false);
    // A session that is already gone is as signed out as one that was just ended; only a failure to reach the server is a failure.
    if (error && error.status !== 401) {
      setFailed(true);
      return;
    }
    window.location.assign('/');
  }

  return (
    <>
      <UserMenu
        name={name}
        email={email}
        size="sm"
        aria-label="User menu"
        items={[
          { label: 'Settings', icon: 'settings', onSelect: () => router.push('/settings') },
          {
            label: leaving ? 'Signing out…' : 'Sign out',
            icon: 'log-out',
            destructive: true,
            onSelect: () => void signOut(),
          },
        ]}
      />
      <ConfirmDialog
        open={failed}
        onClose={() => setFailed(false)}
        onConfirm={() => void signOut()}
        title="Could not sign out"
        message="Signing out needs a connection, so that no one else can use your session. Try again when you are back online."
        confirmLabel="Try again"
        cancelLabel="Not now"
      />
    </>
  );
}
