'use client';

import { type FormEvent, useEffect, useState } from 'react';
import { authClient } from '../client';
import { messageFor } from '../messages';
import {
  AuthButton,
  AuthDivider,
  AuthError,
  AuthField,
  AuthFooter,
  AuthForm,
  AuthLink,
  AuthLinkButton,
  Input,
} from '@sovereignfs/ui';

/**
 * Email and password (`local`), and/or Sovereign, which takes the person away to sign in there and back (DESIGN.md §6). No message says whether an address
 * has an account: a wrong address and a wrong password read the same. `failure` is what went wrong on the way back from Sovereign, if anything.
 */
export function SignInForm({
  local,
  sovereign,
  failure: returned = null,
}: {
  local: { canSignUp: boolean; canReset: boolean } | undefined;
  sovereign: boolean;
  failure?: string | null;
}) {
  const canSignUp = local?.canSignUp ?? false;
  const canReset = local?.canReset ?? false;
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(returned);
  const [busy, setBusy] = useState(false);
  const [secondStep, setSecondStep] = useState(false);
  const [passkeys, setPasskeys] = useState(false);
  useEffect(() => setPasskeys('PublicKeyCredential' in window), []);
  const [backup, setBackup] = useState(false);
  const [code, setCode] = useState('');

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const { data, error: failure } = await authClient.signIn.email({ email, password });
    if (failure) {
      setBusy(false);
      setError(messageFor(failure));
      return;
    }
    // The password was right and the account has an authenticator app: a code is the second step, and there is no session until it is given.
    if ((data as { twoFactorRedirect?: boolean } | null)?.twoFactorRedirect) {
      setBusy(false);
      setSecondStep(true);
      return;
    }
    // A full navigation, not a client-side one: `/` is a different page now that there is a session, and the server decides which.
    window.location.assign('/');
  }

  async function onCode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const { error: failure } = backup
      ? await authClient.twoFactor.verifyBackupCode({ code: code.trim() })
      : await authClient.twoFactor.verifyTotp({ code: code.trim() });
    if (failure) {
      setBusy(false);
      setError(
        backup
          ? 'That backup code is not right, or has been used.'
          : 'That code is not right. Check the app, and try the next one.',
      );
      return;
    }
    window.location.assign('/');
  }

  async function withPasskey() {
    setBusy(true);
    setError(null);
    const { error: failure } = await authClient.signIn.passkey();
    if (failure) {
      setBusy(false);
      setError('That passkey did not sign you in. Use your password instead.');
      return;
    }
    window.location.assign('/');
  }

  async function onSovereign(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    setBusy(true);
    setError(null);
    // On success the browser is sent to Sovereign, so there is nothing to do after the call; a person who comes back with a failure lands on this page
    // again with the reason.
    const { error: failure } = await authClient.signIn.social({
      provider: 'sovereign',
      callbackURL: '/',
      errorCallbackURL: '/sign-in',
    });
    if (failure) {
      setBusy(false);
      setError(messageFor(failure, 'Signing in with Sovereign did not work. Try again.'));
    }
  }

  const sovereignButton = (
    <AuthButton
      type={local ? 'button' : 'submit'}
      variant={local ? 'secondary' : 'primary'}
      onClick={local ? () => void onSovereign() : undefined}
      loading={busy}
      disabled={busy}
    >
      Sign in with Sovereign
    </AuthButton>
  );

  if (!local)
    return (
      <AuthForm onSubmit={(event) => void onSovereign(event)}>
        {error ? <AuthError>{error}</AuthError> : null}
        {sovereignButton}
      </AuthForm>
    );

  if (secondStep)
    return (
      <AuthForm onSubmit={(event) => void onCode(event)}>
        <AuthField label={backup ? 'Backup code' : 'Code from your authenticator app'}>
          {(field) => (
            <Input
              {...field}
              name="code"
              autoComplete="one-time-code"
              inputMode={backup ? 'text' : 'numeric'}
              required
              disabled={busy}
              value={code}
              onChange={(e) => setCode(e.target.value)}
            />
          )}
        </AuthField>
        {error ? <AuthError>{error}</AuthError> : null}
        <AuthButton type="submit" loading={busy}>
          Sign in
        </AuthButton>
        <AuthFooter>
          <AuthLinkButton
            onClick={() => {
              setBackup(!backup);
              setCode('');
              setError(null);
            }}
          >
            {backup ? 'Use the app instead' : 'Use a backup code'}
          </AuthLinkButton>
        </AuthFooter>
      </AuthForm>
    );

  return (
    <>
      <AuthForm onSubmit={(event) => void onSubmit(event)}>
        <AuthField label="Email">
          {(field) => (
            <Input
              {...field}
              type="email"
              name="email"
              autoComplete="username"
              required
              disabled={busy}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          )}
        </AuthField>
        <AuthField label="Password">
          {(field) => (
            <Input
              {...field}
              type="password"
              name="password"
              autoComplete="current-password"
              required
              disabled={busy}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          )}
        </AuthField>
        {error ? <AuthError>{error}</AuthError> : null}
        <AuthButton type="submit" loading={busy}>
          Sign in
        </AuthButton>
      </AuthForm>
      {passkeys ? (
        <AuthFooter>
          <AuthLinkButton onClick={() => void withPasskey()} disabled={busy}>
            Use a passkey instead
          </AuthLinkButton>
        </AuthFooter>
      ) : null}
      {sovereign ? (
        <>
          <AuthDivider />
          {sovereignButton}
        </>
      ) : null}
      {canReset ? (
        <AuthFooter>
          <AuthLink href="/forgot-password">Forgot your password?</AuthLink>
        </AuthFooter>
      ) : null}
      {canSignUp ? (
        <AuthFooter>
          New here? <AuthLink href="/sign-up">Create account</AuthLink>
        </AuthFooter>
      ) : null}
    </>
  );
}
