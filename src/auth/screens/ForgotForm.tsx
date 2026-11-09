'use client';

import { type FormEvent, useState } from 'react';
import { authClient } from '../client';
import { messageFor } from '../messages';
import { AuthButton, AuthError, AuthField, AuthForm, Input } from '@sovereignfs/ui';

/** Asks for a reset link. **The answer is the same whether or not the address has an account** (DESIGN.md §6), so the page cannot be used to find out. */
export function ForgotForm() {
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const { error: failure } = await authClient.requestPasswordReset({
      email,
      redirectTo: '/reset-password',
    });
    setBusy(false);
    if (failure && failure.status === 429) return setError(messageFor(failure));
    // Whatever came of it, the same words.
    setSent(true);
  }

  if (sent)
    return (
      <p role="status">
        If an account has the address {email}, a link to choose a new password is on its way. It can
        be used once.
      </p>
    );
  return (
    <AuthForm onSubmit={(event) => void onSubmit(event)}>
      <AuthField label="Email">
        {(field) => (
          <Input
            {...field}
            type="email"
            name="email"
            autoComplete="email"
            required
            disabled={busy}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        )}
      </AuthField>
      {error ? <AuthError>{error}</AuthError> : null}
      <AuthButton type="submit" loading={busy}>
        Send the link
      </AuthButton>
    </AuthForm>
  );
}
