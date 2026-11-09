'use client';

import { useEffect, useState } from 'react';
import { messageFor } from '../auth/messages';
import { Alert, Button, FormField, Input } from '@sovereignfs/ui';
import styles from './Settings.module.css';

interface Preview {
  /** Whether it asks for the password; an account that came in through Sovereign has none, and a session made just now stands in. */
  password: boolean;
  files: number;
  bytes: number;
}

/**
 * Settings, Data, Delete account (DESIGN.md §23). **It says what goes before it asks:** the account, its profile and every file, and later its check-ins and places, and what happens
 * to trips. It asks for the password. This device's copy goes with it (6.2); other devices find out at their next sync, when their session has ended.
 */
export function DeleteAccountSection() {
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [password, setPassword] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [working, setWorking] = useState(false);

  useEffect(() => {
    if (!open) return;
    void (async () => {
      try {
        const reply = await fetch('/api/account/delete', { cache: 'no-store' });
        if (reply.ok) setPreview((await reply.json()) as Preview);
        else setProblem('This needs a connection.');
      } catch {
        setProblem('This needs a connection.');
      }
    })();
  }, [open]);

  async function remove() {
    setWorking(true);
    setProblem(null);
    try {
      const reply = await fetch('/api/account/delete', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      if (reply.status === 403) {
        const { code } = (await reply.json().catch(() => ({}))) as { code?: string };
        return setProblem(
          code === 'SESSION_NOT_FRESH'
            ? messageFor({ code }, 'Sign in again, and then try this once more.')
            : 'That is not your password.',
        );
      }
      if (reply.status === 429)
        return setProblem('That was tried too many times. Wait a few minutes.');
      if (!reply.ok)
        return setProblem(
          'That could not be done. Nothing was deleted, or it was only partly: try again.',
        );
      // The account is gone, and the page starts again from the front.
      setPassword('');
      window.location.assign('/');
    } catch {
      setProblem('That needs a connection.');
    } finally {
      setWorking(false);
    }
  }

  return (
    <div className={styles.group}>
      <h2>Delete account</h2>
      {!open ? (
        <>
          <p className={styles.muted}>
            Deletes your account and everything of yours. It cannot be undone: export first if you
            want a copy.
          </p>
          <div className={styles.row}>
            <Button variant="secondary" onClick={() => setOpen(true)}>
              Delete my account…
            </Button>
          </div>
        </>
      ) : (
        <form
          className={styles.form}
          aria-label="Delete account"
          onSubmit={(event) => {
            event.preventDefault();
            void remove();
          }}
        >
          <p>
            This deletes your account and your profile, and every photo and file you have added.
          </p>
          {preview ? (
            <p className={styles.hint}>
              {preview.files === 0
                ? 'You have no files stored.'
                : `${preview.files} ${preview.files === 1 ? 'file' : 'files'} will be removed from the server.`}
            </p>
          ) : null}
          {problem ? <Alert variant="error">{problem}</Alert> : null}
          {preview && !preview.password ? (
            <p className={styles.hint}>
              You sign in through Sovereign, so there is no password to ask for. This asks that you
              signed in within the last ten minutes: if you did not, sign out, sign in again, and
              come back.
            </p>
          ) : (
            <FormField label="Your password" required>
              {(field) => (
                <Input
                  {...field}
                  type="password"
                  value={password}
                  autoComplete="current-password"
                  onChange={(event) => setPassword(event.target.value)}
                />
              )}
            </FormField>
          )}
          <div className={styles.row}>
            <Button
              type="submit"
              disabled={working || preview === null || (preview.password && password === '')}
            >
              {working ? 'Deleting…' : 'Delete my account for good'}
            </Button>
            <Button variant="secondary" onClick={() => setOpen(false)}>
              Cancel
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}
