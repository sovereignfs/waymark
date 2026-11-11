'use client';

import { useState } from 'react';
import { authClient } from '../auth/client';
import { messageFor, oauthErrorMessage } from '../auth/messages';
import { Alert, Button } from '@sovereignfs/ui';
import styles from './Settings.module.css';

/**
 * Settings, Security, Sovereign (DESIGN.md §19.1): whether this account can also be signed into through Sovereign. Linking sends the person to Sovereign and
 * back, and only works when Sovereign's address is this account's own, which the server checks and this says. Unlinking is refused for an account with no other
 * way to sign in, and asks for a session made in the last few minutes.
 */
export function SovereignPanel({
  linkedAccountId,
  canUnlink,
  email,
  result,
}: {
  /** better-auth's id for the linked row, or null when it is not linked. */
  linkedAccountId: string | null;
  /** The account has another way in, so that Sovereign can go. */
  canUnlink: boolean;
  email: string;
  /** What the way back from Sovereign (or from unlinking) left in the address. */
  result: { linked: boolean; unlinked: boolean; error: string | null };
}) {
  const { data } = authClient.useSession();
  const twoFactorOn = Boolean(
    (data?.user as { twoFactorEnabled?: boolean } | undefined)?.twoFactorEnabled,
  );
  const [busy, setBusy] = useState(false);
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<string | null>(oauthErrorMessage(result.error ?? undefined));

  async function link() {
    setBusy(true);
    setError(null);
    // On success the browser is sent to Sovereign and brought back to this page, with the result.
    const { error: failure } = await authClient.linkSocial({
      provider: 'sovereign',
      callbackURL: '/settings?section=security&linked=1',
      errorCallbackURL: '/settings?section=security',
    });
    if (failure) {
      setBusy(false);
      setError(messageFor(failure, 'Linking Sovereign did not work. Try again.'));
    }
  }

  async function unlink() {
    if (!linkedAccountId) return;
    setBusy(true);
    setError(null);
    const { error: failure } = await authClient.unlinkAccount({ accountId: linkedAccountId });
    setBusy(false);
    if (failure) {
      setAsking(false);
      setError(messageFor(failure, 'Sovereign was not unlinked. Try again.'));
      return;
    }
    window.location.assign('/settings?section=security&unlinked=1');
  }

  return (
    <div className={styles.group} role="group" aria-labelledby="sovereign-title">
      <h2 id="sovereign-title">Sovereign</h2>
      {error ? <Alert variant="error">{error}</Alert> : null}
      {result.linked && linkedAccountId && !error ? (
        <Alert variant="success">Sovereign is linked.</Alert>
      ) : null}
      {result.unlinked && !linkedAccountId && !error ? (
        <Alert variant="success">Sovereign is unlinked.</Alert>
      ) : null}
      {linkedAccountId ? (
        <p className={styles.muted}>
          You can sign in with Sovereign as well as the other way. Your Sovereign account uses the
          same email address as this one, {email}.
        </p>
      ) : (
        <p className={styles.muted}>
          Link a Sovereign account to sign in with it as well. It has to use the same email address
          as this account, <strong>{email}</strong>: if it does not, nothing is linked.
        </p>
      )}
      {twoFactorOn && linkedAccountId ? (
        <p className={styles.hint}>
          Signing in with Sovereign does not ask for an authenticator code here: Sovereign asks for
          its own.
        </p>
      ) : null}
      <div className={styles.row}>
        {linkedAccountId ? (
          asking ? (
            <>
              <Button onClick={() => void unlink()} loading={busy}>
                Unlink
              </Button>
              <Button variant="secondary" onClick={() => setAsking(false)} disabled={busy}>
                Cancel
              </Button>
            </>
          ) : (
            <Button variant="secondary" onClick={() => setAsking(true)} disabled={!canUnlink}>
              Unlink Sovereign
            </Button>
          )
        ) : (
          <Button onClick={() => void link()} loading={busy}>
            Link Sovereign
          </Button>
        )}
      </div>
      {linkedAccountId && !canUnlink ? (
        <p className={styles.hint}>It is the only way you can sign in, so it cannot be unlinked.</p>
      ) : null}
      {asking ? (
        <p className={styles.hint}>
          You will sign in with your password from now on. This asks that you signed in within the
          last ten minutes.
        </p>
      ) : null}
    </div>
  );
}
