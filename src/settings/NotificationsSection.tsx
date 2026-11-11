'use client';

import { useState } from 'react';
import { Toggle, useToast } from '@sovereignfs/ui';
import styles from './Settings.module.css';

interface Kind {
  kind: string;
  label: string;
  email: boolean;
}

/**
 * Settings, Notifications (DESIGN.md §17.2, §21): what Waymark emails. **The bell is always on**; beyond it a person chooses, for each kind of notice, whether it is also emailed. With no mail set up on this
 * server it says the bell is the only way Waymark can tell you, and the switches are off and cannot be moved (a choice made now would apply if mail were set up later, but a person should not be asked to choose
 * what cannot happen). A change is shown at once and put right if the server did not take it.
 */
export function NotificationsSection({ mail, initial }: { mail: boolean; initial: Kind[] }) {
  const [kinds, setKinds] = useState(initial);
  const toast = useToast();

  async function choose(kind: string, on: boolean) {
    const before = kinds;
    setKinds((now) => now.map((each) => (each.kind === kind ? { ...each, email: on } : each)));
    try {
      const reply = await fetch('/api/notices/prefs', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind, channel: 'email', on }),
      });
      if (!reply.ok) throw new Error('refused');
    } catch {
      setKinds(before);
      toast.show({ title: 'That could not be saved. Try again.', category: 'error' });
    }
  }

  return (
    <div className={styles.group}>
      <h2>Notifications</h2>
      <p className={styles.hint}>
        What Waymark tells you is always in the bell and on the Notifications page.
        {mail
          ? ' Choose what is also emailed to you.'
          : ' Email is not set up on this server, so the bell is the only way Waymark can tell you.'}
      </p>
      <ul className={styles.devices} aria-label="What is emailed">
        {kinds.map((each) => (
          <li key={each.kind} className={styles.device}>
            <span className={styles.deviceName}>{each.label}</span>
            <Toggle
              aria-label={`Email me when: ${each.label}`}
              checked={mail && each.email}
              disabled={!mail}
              onChange={(on) => void choose(each.kind, on)}
            />
          </li>
        ))}
      </ul>
    </div>
  );
}
