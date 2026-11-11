'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, useToast } from '@sovereignfs/ui';
import styles from './Settings.module.css';

interface Job {
  id: string;
  source: string;
  status: 'queued' | 'running' | 'done' | 'failed' | 'cancelled';
  checkinsDone: number;
  checkinsSkipped: number;
  placesMade: number;
  photosDone: number;
  photosFailed: number;
  errors: { sentence: string; count: number }[];
}

const SENTENCE: Record<string, string> = {
  BUSY: 'An import is already running. Wait for it to finish, or cancel it, and then try again.',
  TOO_BIG: 'That file is larger than 200 MB.',
  EMPTY: 'That file is empty.',
  UNAVAILABLE: 'Importing is not available on this server.',
};

/**
 * Settings, Data, Import a Waymark file (DESIGN.md §22): choose a file made by Export and bring its places, check-ins and photos into this account, as new ones. It is read by a background job, so this uploads and
 * then looks every few seconds; **nothing is made unless all of the file is valid**, and a file that is not right is refused with a sentence that says what to do. Importing the same file again makes nothing again,
 * and your name and settings are not changed by it. It needs a connection.
 */
export function ImportFileSection() {
  const [job, setJob] = useState<Job | undefined>(undefined);
  const [uploading, setUploading] = useState(false);
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const input = useRef<HTMLInputElement>(null);
  const toast = useToast();

  const load = useCallback(async () => {
    try {
      const reply = await fetch('/api/imports', { cache: 'no-store' });
      if (!reply.ok) return;
      const body = (await reply.json()) as { imports: Job[] };
      setJob(body.imports.find((each) => each.source === 'waymark'));
    } catch {
      // Offline: what there was stays.
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  const active = job?.status === 'queued' || job?.status === 'running';
  useEffect(() => {
    if (!active) return;
    const tick = setInterval(() => void load(), 2000);
    return () => clearInterval(tick);
  }, [active, load]);

  async function upload(file: File) {
    setUploading(true);
    setProblem(undefined);
    try {
      const reply = await fetch('/api/imports?source=waymark', { method: 'POST', body: file });
      if (!reply.ok) {
        const body = (await reply.json().catch(() => ({}))) as { code?: string };
        setProblem(SENTENCE[body.code ?? ''] ?? 'The file could not be sent. Try again.');
      }
      await load();
    } catch {
      setProblem('This needs a connection. Try again when you are back online.');
    } finally {
      setUploading(false);
      if (input.current) input.current.value = '';
    }
  }

  async function cancel() {
    if (!job) return;
    await fetch(`/api/imports/${job.id}`, { method: 'DELETE' }).catch(() => undefined);
    toast.show({ title: 'Import cancelled. What was brought so far stays.', category: 'info' });
    await load();
  }

  const counts = job
    ? `${job.checkinsDone.toLocaleString('en-GB')} check-ins and ${job.placesMade.toLocaleString('en-GB')} places` +
      (job.photosDone > 0 ? `, ${job.photosDone.toLocaleString('en-GB')} photos` : '') +
      (job.checkinsSkipped > 0
        ? `, ${job.checkinsSkipped.toLocaleString('en-GB')} already here`
        : '') +
      (job.photosFailed > 0
        ? `, ${job.photosFailed.toLocaleString('en-GB')} photos that could not be kept`
        : '')
    : '';

  return (
    <div className={styles.group}>
      <h2>Import a Waymark file</h2>
      <p className={styles.hint}>
        Choose a file you made with Export, and its places, check-ins and photos are brought in as
        new ones here. Nothing is brought unless the whole file is valid. Bringing the same file
        again adds nothing, and your name and settings are not changed.
      </p>
      <div className={styles.row}>
        <input
          ref={input}
          type="file"
          accept=".zip,application/zip"
          aria-label="A Waymark export file"
          disabled={uploading || active}
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void upload(file);
          }}
        />
      </div>
      {problem ? (
        <p role="alert" className={styles.hint}>
          {problem}
        </p>
      ) : null}
      {job ? (
        <p role="status" className={styles.hint}>
          {job.status === 'queued' || job.status === 'running'
            ? `Importing… ${counts}.`
            : job.status === 'done'
              ? `Imported: ${counts}.`
              : job.status === 'cancelled'
                ? `Cancelled: ${counts} were brought before it stopped.`
                : (job.errors[0]?.sentence ?? 'The import could not be finished.')}
        </p>
      ) : null}
      {active ? (
        <div className={styles.row}>
          <Button type="button" variant="secondary" onClick={() => void cancel()}>
            Cancel the import
          </Button>
        </div>
      ) : null}
    </div>
  );
}
