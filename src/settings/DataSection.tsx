'use client';

import { DeleteAccountSection } from './DeleteAccountSection';
import styles from './Settings.module.css';

const megabytes = (bytes: number): string =>
  bytes < 1024 * 1024
    ? `${Math.max(0, Math.round(bytes / 1024))} KB`
    : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

/**
 * Settings, Data (DESIGN.md §21): how much of the account's room the files use, and deleting the account. Import from Swarm, export and import join with 8.3, 15.1 and 15.2.
 */
export function DataSection({ usedBytes, limitBytes }: { usedBytes: number; limitBytes: number }) {
  return (
    <>
      <div className={styles.group}>
        <h2>Storage</h2>
        <p>
          Your photos and files use {megabytes(usedBytes)} of the {megabytes(limitBytes)} this
          server gives each account.
        </p>
        <progress value={usedBytes} max={limitBytes} aria-label="Storage used" />
      </div>
      <DeleteAccountSection />
    </>
  );
}
