'use client';

import { useCallback, useEffect, useState } from 'react';
import { authClient } from '../auth/client';
import { messageFor } from '../auth/messages';
import { Alert, Button, FormField, Input } from '@sovereignfs/ui';
import styles from './Settings.module.css';

interface Passkey {
  id: string;
  name?: string | null | undefined;
  createdAt?: Date | string | null | undefined;
}

/**
 * Settings, Security, passkeys (DESIGN.md §19.1, §21): added from this device (the browser asks for the fingerprint, face or key), named, renamed and removed. A
 * passkey signs in with no password. It belongs to this address (`WAYMARK_URL`) and works nowhere else. Where the browser has no passkeys, it says so.
 */
export function PasskeysPanel() {
  const [passkeys, setPasskeys] = useState<Passkey[] | null>(null);
  const [name, setName] = useState('');
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [supported, setSupported] = useState(true);

  const read = useCallback(async () => {
    const { data, error: failure } = await authClient.passkey.listUserPasskeys();
    if (failure) return setError(messageFor(failure));
    setPasskeys((data ?? []) as Passkey[]);
  }, []);
  useEffect(() => {
    setSupported(typeof window !== 'undefined' && 'PublicKeyCredential' in window);
    void read();
  }, [read]);

  async function add() {
    setBusy(true);
    setError(null);
    const { error: failure } = await authClient.passkey.addPasskey({
      ...(name.trim() ? { name: name.trim() } : {}),
    });
    setBusy(false);
    if (failure) return setError('The passkey was not added. Try again, or use another device.');
    setName('');
    await read();
  }
  async function remove(id: string) {
    setError(null);
    const { error: failure } = await authClient.passkey.deletePasskey({ id });
    if (failure) setError(messageFor(failure));
    await read();
  }
  async function rename() {
    if (!editing) return;
    const { error: failure } = await authClient.passkey.updatePasskey({
      id: editing.id,
      name: editing.name.trim(),
    });
    if (failure) setError(messageFor(failure));
    setEditing(null);
    await read();
  }

  return (
    <div className={styles.group}>
      <h2>Passkeys</h2>
      <p className={styles.hint}>
        A passkey signs you in with your fingerprint, face or a security key, with no password. It
        works on this address only.
      </p>
      {error ? <Alert variant="error">{error}</Alert> : null}
      {passkeys === null ? <p className={styles.hint}>Loading…</p> : null}
      {passkeys?.length === 0 ? <p className={styles.muted}>You have no passkeys.</p> : null}
      <ul className={styles.devices} aria-label="Your passkeys">
        {(passkeys ?? []).map((each) => (
          <li key={each.id} className={styles.device}>
            {editing?.id === each.id ? (
              <form
                className={styles.row}
                onSubmit={(event) => {
                  event.preventDefault();
                  void rename();
                }}
              >
                <FormField label="Name">
                  {(field) => (
                    <Input
                      {...field}
                      value={editing.name}
                      onChange={(e) => setEditing({ id: each.id, name: e.target.value })}
                    />
                  )}
                </FormField>
                <Button type="submit" size="sm">
                  Save
                </Button>
                <Button variant="secondary" size="sm" onClick={() => setEditing(null)}>
                  Cancel
                </Button>
              </form>
            ) : (
              <>
                <div>
                  <span className={styles.deviceName}>{each.name || 'A passkey'}</span>
                  <span className={styles.hint}>
                    {each.createdAt ? `Added ${new Date(each.createdAt).toLocaleDateString()}` : ''}
                  </span>
                </div>
                <div className={styles.row}>
                  <Button
                    variant="secondary"
                    size="sm"
                    aria-label={`Rename ${each.name || 'a passkey'}`}
                    onClick={() => setEditing({ id: each.id, name: each.name ?? '' })}
                  >
                    Rename
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    aria-label={`Remove ${each.name || 'a passkey'}`}
                    onClick={() => void remove(each.id)}
                  >
                    Remove
                  </Button>
                </div>
              </>
            )}
          </li>
        ))}
      </ul>
      {supported ? (
        <form
          className={styles.row}
          onSubmit={(event) => {
            event.preventDefault();
            void add();
          }}
        >
          <FormField label="Name for the new passkey">
            {(field) => (
              <Input
                {...field}
                placeholder="This laptop"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            )}
          </FormField>
          <Button type="submit" disabled={busy}>
            Add a passkey
          </Button>
        </form>
      ) : (
        <p className={styles.muted}>This browser cannot make passkeys.</p>
      )}
    </div>
  );
}
