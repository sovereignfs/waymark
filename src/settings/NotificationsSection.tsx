'use client';

import { useEffect, useState } from 'react';
import { Button, Toggle, useToast } from '@sovereignfs/ui';
import { type PushState, browserEnv, stateOf, turnOff, turnOn } from '../push/client';
import styles from './Settings.module.css';

interface Kind {
  kind: string;
  label: string;
  email: boolean;
  core: boolean;
  push: boolean;
}

/**
 * Settings, Notifications (DESIGN.md §17.2, §21): what Waymark emails. **The bell is always on**; beyond it a person chooses, for each kind of notice, whether it is also emailed. With no mail set up on this
 * server it says the bell is the only way Waymark can tell you, and the switches are off and cannot be moved (a choice made now would apply if mail were set up later, but a person should not be asked to choose
 * what cannot happen). A change is shown at once and put right if the server did not take it.
 */
export function NotificationsSection({
  mail,
  core,
  push,
  initial,
}: {
  /** This server can send email: by its own mail, or by the core the people sign in through. */
  mail: boolean;
  /** The people here sign in through a Sovereign core, whose bell is then a channel (DESIGN.md §19.4). */
  core: boolean;
  /** This server has a key for Web Push (DESIGN.md §17.3): the public key a browser subscribes with. Absent, push is not offered. */
  push: { publicKey: string } | undefined;
  initial: Kind[];
}) {
  const [kinds, setKinds] = useState(initial);
  const toast = useToast();

  async function choose(kind: string, channel: 'email' | 'core' | 'push', on: boolean) {
    const before = kinds;
    setKinds((now) => now.map((each) => (each.kind === kind ? { ...each, [channel]: on } : each)));
    try {
      const reply = await fetch('/api/notices/prefs', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind, channel, on }),
      });
      if (!reply.ok) throw new Error('refused');
    } catch {
      setKinds(before);
      toast.show({ title: 'That could not be saved. Try again.', category: 'error' });
    }
  }

  const [device, setDevice] = useState<PushState | 'checking' | 'working'>('checking');
  useEffect(() => {
    if (!push) return;
    void stateOf(browserEnv()).then(setDevice, () => setDevice('unsupported'));
  }, [push]);

  async function toggleDevice() {
    if (!push) return;
    const before = device;
    setDevice('working');
    const env = browserEnv();
    if (before === 'on') {
      setDevice(await turnOff(env));
      return;
    }
    const after = await turnOn(env, push.publicKey);
    if (after === 'failed') {
      setDevice('off');
      toast.show({ title: 'Push could not be turned on. Try again.', category: 'error' });
    } else setDevice(after);
  }

  return (
    <div className={styles.group}>
      <h2>Notifications</h2>
      <p className={styles.hint}>
        What Waymark tells you is always in the bell and on the Notifications page.
        {mail
          ? ` Choose what is also emailed to you${core ? ', and what also goes to your Sovereign bell' : ''}.`
          : core
            ? ' Choose what also goes to your Sovereign bell.'
            : ' Email is not set up on this server, so the bell is the only way Waymark can tell you.'}
      </p>
      {push ? (
        <div className={styles.group}>
          <h3>This device</h3>
          <p className={styles.hint}>
            {device === 'unsupported'
              ? 'This browser cannot receive push notifications. On an iPhone or iPad, push works once Waymark is added to the Home Screen (Share, then Add to Home Screen) and opened from there.'
              : device === 'blocked'
                ? 'Notifications are blocked for Waymark in this browser. Allow them in the browser’s settings for this site, then come back.'
                : device === 'on'
                  ? 'Push is on in this browser. A push says what happened and where, and nothing of the trip itself.'
                  : 'Turn push on to be told here, even when Waymark is closed. Your browser will ask first.'}
          </p>
          {device === 'off' || device === 'on' || device === 'working' ? (
            <Button
              variant="secondary"
              disabled={device === 'working'}
              onClick={() => void toggleDevice()}
            >
              {device === 'on' ? 'Turn off on this device' : 'Turn on for this device'}
            </Button>
          ) : null}
        </div>
      ) : (
        <p className={styles.hint}>
          Push notifications are not set up on this server, so Waymark cannot push to your devices.
        </p>
      )}
      <ul className={styles.devices} aria-label="What is emailed">
        {kinds.map((each) => (
          <li key={each.kind} className={styles.device}>
            <span className={styles.deviceName}>{each.label}</span>
            <span className={styles.row}>
              {core ? (
                <Toggle
                  aria-label={`Core’s bell when: ${each.label}`}
                  checked={each.core}
                  onChange={(on) => void choose(each.kind, 'core', on)}
                />
              ) : null}
              {push ? (
                <Toggle
                  aria-label={`Push to my devices when: ${each.label}`}
                  checked={each.push}
                  onChange={(on) => void choose(each.kind, 'push', on)}
                />
              ) : null}
              <Toggle
                aria-label={`Email me when: ${each.label}`}
                checked={mail && each.email}
                disabled={!mail}
                onChange={(on) => void choose(each.kind, 'email', on)}
              />
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
