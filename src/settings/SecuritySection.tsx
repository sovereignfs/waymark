'use client';

import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { messageFor } from '../auth/messages';
import { authClient } from '../auth/client';
import { Alert, Button, FormField, Input } from '@sovereignfs/ui';
import { SovereignPanel } from './SovereignPanel';
import { PasskeysPanel } from './PasskeysPanel';
import { TwoFactorPanel } from './TwoFactorPanel';
import styles from './Settings.module.css';

interface Device {
  token: string;
  userAgent: string | null;
  updatedAt: Date;
}

/** A browser's own words, made short enough to read: the last product it names is the one a person knows ("Chrome", "Safari"). */
export function deviceName(userAgent: string | null | undefined): string {
  if (!userAgent) return 'An unknown device';
  const products = [...userAgent.matchAll(/(Edg|Chrome|Firefox|Safari|CriOS|FxiOS)\/[\d.]+/g)].map(
    (match) => match[1] ?? '',
  );
  const names: Record<string, string> = { Edg: 'Edge', CriOS: 'Chrome', FxiOS: 'Firefox' };
  const browser = products.find((p) => p !== 'Safari') ?? products[0];
  const system = /iPhone|iPad/.test(userAgent)
    ? 'iOS'
    : /Android/.test(userAgent)
      ? 'Android'
      : /Mac OS X/.test(userAgent)
        ? 'macOS'
        : /Windows/.test(userAgent)
          ? 'Windows'
          : /Linux/.test(userAgent)
            ? 'Linux'
            : undefined;
  const label = browser ? (names[browser] ?? browser) : 'A browser';
  return system ? `${label} on ${system}` : label;
}

/**
 * Settings, Security (DESIGN.md §21): the password, which asks for the old one and ends every other session, and the devices this account is signed in
 * on, each of which can be signed out from here. Both need a connection, and say so when there is none.
 */
export function SecuritySection({
  passwordMinLength,
  hasPassword,
  sovereign,
  email,
  result,
}: {
  passwordMinLength: number;
  /** The account has a password. One that came in through Sovereign alone has none, and so no password, authenticator app or passkeys to manage. */
  hasPassword: boolean;
  /** Sovereign sign-in is set up on this server: whether this account has it linked (its row's id), or null. Absent where it is not. */
  sovereign: { linkedAccountId: string | null } | undefined;
  email: string;
  /** What the way back from Sovereign (or from unlinking) left in the address. */
  result: { linked: boolean; unlinked: boolean; error: string | null };
}) {
  return (
    <>
      {hasPassword ? (
        <>
          <PasswordForm minLength={passwordMinLength} />
          <TwoFactor />
          <PasskeysPanel />
        </>
      ) : (
        <div className={styles.group}>
          <h2>You sign in with Sovereign</h2>
          <p className={styles.muted}>
            This account has no password, authenticator app or passkeys to manage here: Sovereign
            has its own.
          </p>
        </div>
      )}
      {sovereign ? (
        <SovereignPanel
          linkedAccountId={sovereign.linkedAccountId}
          canUnlink={hasPassword}
          email={email}
          result={result}
        />
      ) : null}
      <Devices />
    </>
  );
}

/** The authenticator panel, once it is known whether it is on: that is the account's own, read from the session. */
function TwoFactor() {
  const { data, isPending } = authClient.useSession();
  if (isPending || !data) return null;
  return (
    <TwoFactorPanel
      enabled={Boolean((data.user as { twoFactorEnabled?: boolean }).twoFactorEnabled)}
    />
  );
}

function PasswordForm({ minLength }: { minLength: number }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const short = next !== '' && next.length < minLength;
  const differs = again !== '' && again !== next;

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (current === '' || next.length < minLength || next !== again) return;
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const { error: failure } = await authClient.changePassword({
        currentPassword: current,
        newPassword: next,
        revokeOtherSessions: true,
      });
      if (failure) {
        setError(messageFor(failure));
        return;
      }
      setCurrent('');
      setNext('');
      setAgain('');
      setSaved(true);
    } catch {
      setError('This needs a connection. Try again when you are back online.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={styles.group}>
      <h2>Password</h2>
      <form onSubmit={onSubmit} className={styles.form} aria-label="Change password">
        {error ? <Alert variant="error">{error}</Alert> : null}
        {saved ? (
          <Alert variant="success">
            Your password is changed, and every other device is signed out.
          </Alert>
        ) : null}
        <FormField label="Current password" required>
          {(field) => (
            <Input
              {...field}
              type="password"
              name="current"
              autoComplete="current-password"
              value={current}
              onChange={(event) => setCurrent(event.target.value)}
              disabled={busy}
            />
          )}
        </FormField>
        <FormField
          label="New password"
          required
          error={short ? `At least ${minLength} characters.` : undefined}
        >
          {(field) => (
            <Input
              {...field}
              type="password"
              name="new"
              autoComplete="new-password"
              value={next}
              onChange={(event) => setNext(event.target.value)}
              disabled={busy}
            />
          )}
        </FormField>
        <FormField
          label="New password again"
          required
          error={differs ? 'The two are not the same.' : undefined}
        >
          {(field) => (
            <Input
              {...field}
              type="password"
              name="again"
              autoComplete="new-password"
              value={again}
              onChange={(event) => setAgain(event.target.value)}
              disabled={busy}
            />
          )}
        </FormField>
        <div>
          <Button
            type="submit"
            loading={busy}
            disabled={current === '' || next.length < minLength || next !== again}
          >
            Change password
          </Button>
        </div>
      </form>
    </div>
  );
}

function Devices() {
  const session = authClient.useSession();
  const here = session.data?.session.token;
  const [devices, setDevices] = useState<Device[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const { data, error: failure } = await authClient.listSessions();
      if (failure || !data) {
        setError(messageFor(failure));
        return;
      }
      setError(null);
      setDevices(
        data.map((each) => ({
          token: each.token,
          userAgent: each.userAgent ?? null,
          updatedAt: new Date(each.updatedAt),
        })),
      );
    } catch {
      setError('This needs a connection. Try again when you are back online.');
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  async function signOutElsewhere(token?: string) {
    setBusy(true);
    try {
      const { error: failure } = token
        ? await authClient.revokeSession({ token })
        : await authClient.revokeOtherSessions();
      if (failure) setError(messageFor(failure));
      else await load();
    } catch {
      setError('This needs a connection. Try again when you are back online.');
    } finally {
      setBusy(false);
    }
  }

  const others = (devices ?? []).filter((device) => device.token !== here);
  return (
    <div className={styles.group}>
      <h2>Devices</h2>
      {error ? <Alert variant="error">{error}</Alert> : null}
      {devices === null && !error ? <p className={styles.hint}>Loading…</p> : null}
      {devices ? (
        <ul className={styles.devices} aria-label="Signed-in devices">
          {devices.map((device) => (
            <li key={device.token} className={styles.device}>
              <div>
                <span className={styles.deviceName}>{deviceName(device.userAgent)}</span>
                <span className={styles.hint}>
                  {device.token === here
                    ? 'This device'
                    : `Last used ${device.updatedAt.toLocaleDateString()}`}
                </span>
              </div>
              {device.token === here ? null : (
                <Button
                  variant="secondary"
                  disabled={busy}
                  onClick={() => void signOutElsewhere(device.token)}
                  aria-label={`Sign out ${deviceName(device.userAgent)}`}
                >
                  Sign out
                </Button>
              )}
            </li>
          ))}
        </ul>
      ) : null}
      {others.length > 1 ? (
        <div>
          <Button variant="secondary" disabled={busy} onClick={() => void signOutElsewhere()}>
            Sign out everywhere else
          </Button>
        </div>
      ) : null}
    </div>
  );
}
