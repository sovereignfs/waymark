import type { ReactNode } from 'react';
import { requireSession } from '@/src/auth/session';
import { serverSealer } from '@/src/crypto/server';
import { getDatabase } from '@/src/db/boot';
import { ensureProfile } from '@/src/profile/profile';
import { SignedInArea } from '@/src/screens/SignedInArea';

// Everything for someone who is signed in (DESIGN.md §20.2): the session is checked here, and the composition is `SignedInArea`, which the offline shell makes too
// (6.4). Every page is rendered per request, since each carries the policy's nonce. A visitor is sent to sign in, and where there is no sign-in at all the answer is
// a 404 (`requireSession`). **Who the person is comes from their profile, never from the auth store** (DESIGN.md §6.1): the session says which account, and the profile
// is made here if the account somehow lacks one.
export const dynamic = 'force-dynamic';

export default async function AppLayout({ children }: { children: ReactNode }) {
  const session = await requireSession();
  const profile = await ensureProfile(
    await getDatabase(),
    serverSealer(),
    { accountId: session.user.id, name: session.user.name, email: session.user.email },
    Date.now(),
  );
  return (
    <SignedInArea name={profile.name} email={profile.email}>
      {children}
    </SignedInArea>
  );
}
