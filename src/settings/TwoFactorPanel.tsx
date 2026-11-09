'use client';

import { QRCodeSVG } from 'qrcode.react';
import { type FormEvent, useState } from 'react';
import { authClient } from '../auth/client';
import { messageFor } from '../auth/messages';
import { Alert, Button, FormField, Input } from '@sovereignfs/ui';
import styles from './Settings.module.css';

/**
 * Settings, Security, authenticator app (DESIGN.md §19.1, §21). **It asks for the password at every step that changes it:** to begin, to make new backup codes and to
 * turn it off. Enrolling shows a code to scan and ten backup codes, and **it is on only once a code from the app has been shown to work**, so a mistaken scan
 * cannot lock a person out of their own account. The backup codes are shown once; each works once.
 */
export function TwoFactorPanel({ enabled: initial }: { enabled: boolean }) {
  const [enabled, setEnabled] = useState(initial);
  const [step, setStep] = useState<'idle' | 'password' | 'scan' | 'off' | 'renew' | 'codes'>(
    'idle',
  );
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [uri, setUri] = useState<string | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function run(work: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await work();
    } finally {
      setBusy(false);
    }
  }

  const begin = (event: FormEvent) => {
    event.preventDefault();
    void run(async () => {
      const { data, error: failure } = await authClient.twoFactor.enable({ password });
      if (failure || !data || data.method !== 'totp') return setError(messageFor(failure));
      setUri(data.totpURI);
      setCodes(data.backupCodes);
      setPassword('');
      setStep('scan');
    });
  };
  const confirm = (event: FormEvent) => {
    event.preventDefault();
    void run(async () => {
      const { error: failure } = await authClient.twoFactor.verifyTotp({ code: code.trim() });
      if (failure) return setError('That code is not right. Check the app, and try the next one.');
      setEnabled(true);
      setCode('');
      setUri(null);
      setStep('codes');
    });
  };
  const turnOff = (event: FormEvent) => {
    event.preventDefault();
    void run(async () => {
      const { error: failure } = await authClient.twoFactor.disable({ password });
      if (failure) return setError(messageFor(failure));
      setEnabled(false);
      setPassword('');
      setCodes(null);
      setStep('idle');
    });
  };
  const renew = (event: FormEvent) => {
    event.preventDefault();
    void run(async () => {
      const { data, error: failure } = await authClient.twoFactor.generateBackupCodes({ password });
      if (failure || !data) return setError(messageFor(failure));
      setCodes(data.backupCodes);
      setPassword('');
      setStep('codes');
    });
  };

  return (
    <div className={styles.group}>
      <h2>Authenticator app</h2>
      {error ? <Alert variant="error">{error}</Alert> : null}
      {step === 'idle' || step === 'codes' ? (
        <p className={styles.hint}>
          {enabled
            ? 'On: signing in asks for a code from your authenticator app after the password. A backup code works in its place, once.'
            : 'Off. With it on, signing in asks for a code from an app on your phone after the password.'}
        </p>
      ) : null}
      {step === 'idle' && !enabled ? (
        <div className={styles.row}>
          <Button variant="secondary" onClick={() => setStep('password')}>
            Set up an authenticator app
          </Button>
        </div>
      ) : null}
      {step === 'password' ? (
        <form className={styles.form} onSubmit={begin} aria-label="Set up an authenticator app">
          <FormField label="Your password" required>
            {(field) => (
              <Input
                {...field}
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            )}
          </FormField>
          <div className={styles.row}>
            <Button type="submit" disabled={busy || password === ''}>
              Continue
            </Button>
            <Button variant="secondary" onClick={() => setStep('idle')}>
              Cancel
            </Button>
          </div>
        </form>
      ) : null}
      {step === 'scan' && uri ? (
        <form className={styles.form} onSubmit={confirm} aria-label="Confirm the authenticator app">
          <p>
            Scan this with your authenticator app, then give it the code it shows. It is not on
            until you have.
          </p>
          <QRCodeSVG value={uri} size={176} title="Authenticator app code" />
          <p className={styles.hint}>
            Or enter this key by hand:{' '}
            <code aria-label="Setup key">{new URL(uri).searchParams.get('secret')}</code>
          </p>
          <FormField label="Code from the app" required>
            {(field) => (
              <Input
                {...field}
                inputMode="numeric"
                autoComplete="one-time-code"
                value={code}
                onChange={(e) => setCode(e.target.value)}
              />
            )}
          </FormField>
          <div className={styles.row}>
            <Button type="submit" disabled={busy || code.trim().length < 6}>
              Turn it on
            </Button>
            <Button variant="secondary" onClick={() => setStep('idle')}>
              Cancel
            </Button>
          </div>
        </form>
      ) : null}
      {step === 'codes' && codes ? (
        <div role="status" aria-label="Backup codes">
          <p>
            <strong>Save these backup codes.</strong> Each works once, in place of a code from the
            app, and they are not shown again.
          </p>
          <ul className={styles.list}>
            {codes.map((each) => (
              <li key={each}>
                <code>{each}</code>
              </li>
            ))}
          </ul>
          <Button
            variant="secondary"
            onClick={() => {
              setCodes(null);
              setStep('idle');
            }}
          >
            I have saved them
          </Button>
        </div>
      ) : null}
      {enabled && step === 'idle' ? (
        <div className={styles.row}>
          <Button variant="secondary" onClick={() => setStep('off')}>
            Turn it off
          </Button>
          <Button variant="secondary" onClick={() => setStep('renew')}>
            New backup codes
          </Button>
        </div>
      ) : null}
      {step === 'off' ? (
        <form
          className={styles.form}
          onSubmit={turnOff}
          aria-label="Turn off the authenticator app"
        >
          <FormField label="Your password" required>
            {(field) => (
              <Input
                {...field}
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            )}
          </FormField>
          <div className={styles.row}>
            <Button type="submit" disabled={busy || password === ''}>
              Turn it off
            </Button>
            <Button variant="secondary" onClick={() => setStep('idle')}>
              Cancel
            </Button>
          </div>
        </form>
      ) : null}
      {step === 'renew' ? (
        <form className={styles.form} onSubmit={renew} aria-label="Make new backup codes">
          <p className={styles.hint}>The codes you have now stop working.</p>
          <FormField label="Your password" required>
            {(field) => (
              <Input
                {...field}
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            )}
          </FormField>
          <div className={styles.row}>
            <Button type="submit" disabled={busy || password === ''}>
              Make new codes
            </Button>
            <Button variant="secondary" onClick={() => setStep('idle')}>
              Cancel
            </Button>
          </div>
        </form>
      ) : null}
    </div>
  );
}
