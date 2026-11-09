import type { ReactNode } from 'react';
import { requireSession } from '@/src/auth/session';
import { SignedInArea } from '@/src/screens/SignedInArea';

// Everything for someone who is signed in (DESIGN.md §20.2): the session is checked here, and the composition is `SignedInArea`, which the offline shell makes too
// (6.4). Every page is rendered per request, since each carries the policy's nonce. A visitor is sent to sign in, and where there is no sign-in at all the answer is
// a 404 (`requireSession`).
export const dynamic = 'force-dynamic';

export default async function AppLayout({ children }: { children: ReactNode }) {
  const session = await requireSession();
  return (
    <SignedInArea name={session.user.name} email={session.user.email}>
      {children}
    </SignedInArea>
  );
}
