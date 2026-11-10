'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { ConfirmDialog, UserMenu } from '@sovereignfs/ui';
import { useLocal } from '../../local/LocalProvider';
import { authClient } from '../client';

/**
 * The avatar menu at the right of the header: who the person is (name and address) and *Sign out*. **Signing out sends what can be sent first, asks before it throws away what cannot** (what is
 * waiting, or was refused, and is only on this device), ends the session, and then **deletes this account's database from the browser** (DESIGN.md §15.8). The rest of the menu (Places,
 * Notifications, Import, Couldn't sync) joins with the tasks that make them.
 */
export function AccountMenu({ name, email }: { name: string; email: string }) {
  const router = useRouter();
  const [leaving, setLeaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const local = useLocal();
  /** How many changes are only on this device, when there are some: asked about before they are thrown away. */
  const [unsent, setUnsent] = useState(0);

  /** Sends what can be sent; if something is left that the server would not take or could not be reached, the person is asked. Otherwise signs out. */
  async function begin() {
    setFailed(false);
    if (local) {
      setLeaving(true);
      await local.syncNow().catch(() => undefined);
      const left = await local.unsent().catch(() => 0);
      setLeaving(false);
      if (left > 0) {
        setUnsent(left);
        return;
      }
    }
    await signOut();
  }

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
    // The session is over, and so is this account's copy on the device.
    await local?.destroy().catch(() => undefined);
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
            onSelect: () => void begin(),
          },
        ]}
      />
      <ConfirmDialog
        open={failed}
        onClose={() => setFailed(false)}
        onConfirm={() => void begin()}
        title="Could not sign out"
        message="Signing out needs a connection, so that no one else can use your session. Try again when you are back online."
        confirmLabel="Try again"
        cancelLabel="Not now"
      />
      <ConfirmDialog
        open={unsent > 0}
        onClose={() => setUnsent(0)}
        onConfirm={() => {
          setUnsent(0);
          void signOut();
        }}
        title="Some changes were not sent"
        message={`${unsent} ${unsent === 1 ? 'change is' : 'changes are'} only on this device, because the server could not be reached or would not take ${unsent === 1 ? 'it' : 'them'}. Signing out deletes ${unsent === 1 ? 'it' : 'them'} from here.`}
        confirmLabel="Sign out and discard"
        cancelLabel="Stay signed in"
        destructive
      />
    </>
  );
}
