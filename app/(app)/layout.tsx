import type { ReactNode } from 'react';
import { SignedInArea } from '@/src/screens/SignedInArea';

// Everything for someone who is signed in (DESIGN.md §20.2): the composition is `SignedInArea`, which the offline shell makes too (6.4). Every page is
// rendered per request, since each carries the policy's nonce. The session is found here once sign-in exists (2.1); until then the shell is open, which
// only a development build is.
export const dynamic = 'force-dynamic';

export default function AppLayout({ children }: { children: ReactNode }) {
  return <SignedInArea>{children}</SignedInArea>;
}
