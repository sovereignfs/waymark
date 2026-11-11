'use client';

import { useCallback, useEffect, useState } from 'react';
import { Button, useToast } from '@sovereignfs/ui';
import styles from './Settings.module.css';

interface Item {
  id: string;
  status: 'queued' | 'running' | 'ready' | 'failed' | 'expired';
  bytes: number;
  createdAt: number;
  expiresAt?: number;
}

const megabytes = (bytes: number): string =>
  bytes < 1024 * 1024
    ? `${Math.max(1, Math.round(bytes / 1024))} KB`
    : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

const when = (ms: number): string =>
  new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short' }).format(
    new Date(ms),
  );

/**
 * Settings, Data, Export (DESIGN.md §22): ask for everything that is yours in one file (places, check-ins and photos), and download it when it is ready, within a day, after which it is deleted. A job builds it,
 * so this asks and then looks every few seconds while one is being made. It needs a connection, and Settings says so when there is none. Nobody else's address or anything of theirs is in the file.
 */
export function ExportSection() {
  const [items, setItems] = useState<Item[] | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  const load = useCallback(async () => {
    try {
      const reply = await fetch('/api/exports', { cache: 'no-store' });
      if (reply.ok) setItems(((await reply.json()) as { exports: Item[] }).exports);
    } catch {
      // Offline: what there was stays.
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  const waiting = items?.some((each) => each.status === 'queued' || each.status === 'running');
  useEffect(() => {
    if (!waiting) return;
    const tick = setInterval(() => void load(), 3000);
    return () => clearInterval(tick);
  }, [waiting, load]);

  async function ask() {
    setBusy(true);
    try {
      const reply = await fetch('/api/exports', { method: 'POST' });
      if (reply.status === 429)
        toast.show({
          title: 'You have asked for several. Try again in a while.',
          category: 'error',
        });
      else if (!reply.ok && reply.status !== 409)
        toast.show({ title: 'The export could not be started. Try again.', category: 'error' });
      await load();
    } catch {
      toast.show({
        title: 'This needs a connection. Try again when you are back online.',
        category: 'error',
      });
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    await fetch(`/api/exports/${id}`, { method: 'DELETE' }).catch(() => undefined);
    await load();
  }

  const shown = (items ?? []).filter((each) => each.status !== 'expired');
  return (
    <div className={styles.group}>
      <h2>Export</h2>
      <p className={styles.hint}>
        Everything that is yours in one file: your places, your check-ins with who was there, your
        photos and your settings. It does not hold anyone else&rsquo;s address or anything of
        theirs. It is made in the background, and you can download it for a day, after which it is
        deleted.
      </p>
      <div className={styles.row}>
        <Button type="button" disabled={busy || waiting} onClick={() => void ask()}>
          {waiting ? 'Making your export…' : 'Export my data'}
        </Button>
      </div>
      {shown.length > 0 ? (
        <ul className={styles.devices} aria-label="Your exports">
          {shown.map((each) => (
            <li key={each.id} className={styles.device}>
              <div>
                <span className={styles.deviceName}>{when(each.createdAt)}</span>
                <span className={styles.hint}>
                  {each.status === 'ready'
                    ? `${megabytes(each.bytes)}, until ${when(each.expiresAt ?? each.createdAt)}`
                    : each.status === 'failed'
                      ? 'This one could not be made. Ask again.'
                      : 'Being made…'}
                </span>
              </div>
              <span className={styles.row}>
                {each.status === 'ready' ? (
                  <a className={styles.link} href={`/api/exports/${each.id}`} download>
                    Download
                  </a>
                ) : null}
                {each.status !== 'queued' && each.status !== 'running' ? (
                  <Button variant="secondary" type="button" onClick={() => void remove(each.id)}>
                    Delete
                  </Button>
                ) : null}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
