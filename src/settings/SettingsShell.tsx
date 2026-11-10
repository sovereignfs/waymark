'use client';

import { type ReactNode, useState } from 'react';
import { Icon, type IconName, OfflineGate } from '@sovereignfs/ui';
import { type SettingsSection } from './query';
import styles from './Settings.module.css';

const SECTIONS: { id: SettingsSection; label: string; icon: IconName }[] = [
  { id: 'profile', label: 'Profile', icon: 'user' },
  { id: 'security', label: 'Sign-in', icon: 'shield' },
  { id: 'data', label: 'Data', icon: 'database' },
  { id: 'device', label: 'This device', icon: 'smartphone' },
];

/**
 * Settings (DESIGN.md §21): its sections down the left and the open one on the right. Each is rendered by the server and handed in, so choosing one only shows it; the ones
 * not shown stay mounted, so a half-typed password is not lost by looking at another. **Settings needs a connection**: with none, it says so and shows nothing that could be
 * stale (the design system's `OfflineGate`).
 */
export function SettingsShell({
  initial,
  panels,
}: {
  initial: SettingsSection;
  panels: Record<SettingsSection, ReactNode>;
}) {
  const [section, setSection] = useState<SettingsSection>(initial);
  return (
    <OfflineGate surfaceName="Settings">
      <div className={styles.shell}>
        <div className={styles.side}>
          <h1>Settings</h1>
          <nav className={styles.nav} aria-label="Settings sections">
            {SECTIONS.map((entry) => (
              <button
                key={entry.id}
                type="button"
                aria-current={section === entry.id ? 'page' : undefined}
                onClick={() => setSection(entry.id)}
              >
                <Icon name={entry.icon} aria-hidden />
                {entry.label}
              </button>
            ))}
          </nav>
        </div>
        {SECTIONS.map((entry) => (
          <section
            key={entry.id}
            className={styles.panel}
            aria-label={entry.label}
            hidden={section !== entry.id}
          >
            {panels[entry.id]}
          </section>
        ))}
      </div>
    </OfflineGate>
  );
}
