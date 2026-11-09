'use client';

import { type FormEvent, useState } from 'react';
import { authClient } from '../client';
import { messageFor } from '../messages';
import { AuthButton, AuthError, AuthField, AuthForm, Input } from '@sovereignfs/ui';

/** Chooses a new password with the token from the link. It is good once; using it ends every other session of the account. */
export function ResetForm({ minLength }: { minLength: number }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const token =
    typeof window === 'undefined'
      ? ''
      : (new URLSearchParams(window.location.search).get('token') ?? '');

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const { error: failure } = await authClient.resetPassword({ newPassword: password, token });
    setBusy(false);
    if (failure) return setError(messageFor(failure));
    setDone(true);
  }

  if (done)
    return (
      <p role="status">
        Your password is changed, and you are signed out everywhere else.{' '}
        <a href="/sign-in">Sign in</a> with it.
      </p>
    );
  return (
    <AuthForm onSubmit={(event) => void onSubmit(event)}>
      <AuthField label="New password" hint={`At least ${minLength} characters.`}>
        {(field) => (
          <Input
            {...field}
            type="password"
            name="password"
            autoComplete="new-password"
            required
            minLength={minLength}
            disabled={busy}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        )}
      </AuthField>
      {error ? <AuthError>{error}</AuthError> : null}
      <AuthButton type="submit" loading={busy}>
        Change my password
      </AuthButton>
    </AuthForm>
  );
}
