'use client';

import { useState } from 'react';
import { AuthButton, AuthError } from '@sovereignfs/ui';

/** Joins the trip the invitation is to, for the person who is signed in (`POST /api/invitations/accept`), and goes to it. Joining when already a member changes nothing and says so. */
export function JoinTrip({ token }: { token: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [already, setAlready] = useState(false);

  async function join() {
    setBusy(true);
    setError(null);
    try {
      const reply = await fetch('/api/invitations/accept', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token }),
      });
      if (reply.status === 404) {
        setError('This invitation cannot be used any more. Ask whoever sent it for a new one.');
      } else if (reply.status === 409) {
        const body = (await reply.json()) as { sentence?: string };
        setError(body.sentence ?? 'The trip could not take you on.');
      } else if (!reply.ok) {
        setError('That did not work. Try again.');
      } else {
        const body = (await reply.json()) as { status: 'joined' | 'already'; tripId: string };
        if (body.status === 'already') setAlready(true);
        window.location.assign(`/t/${body.tripId}`);
        return;
      }
    } catch {
      setError('There is no connection to the server. Try again when there is.');
    }
    setBusy(false);
  }

  return (
    <>
      {error ? <AuthError>{error}</AuthError> : null}
      {already ? <p role="status">You are already in this trip.</p> : null}
      <AuthButton type="button" loading={busy} disabled={busy} onClick={() => void join()}>
        Join the trip
      </AuthButton>
    </>
  );
}
