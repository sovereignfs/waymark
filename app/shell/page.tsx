import type { Metadata } from 'next';
import { EmptyState } from '@sovereignfs/ui';
import { SignedInArea } from '@/src/screens/SignedInArea';

export const metadata: Metadata = { title: 'Waymark', robots: { index: false, follow: false } };

/**
 * The one page the service worker keeps (DESIGN.md §20.12). **It holds nothing of a person** and asks nothing of the session: it is the same for everyone. It is the
 * frame of the app with nothing in it, which 6.4 makes the page the app starts from on a device with no server to ask, finding who is signed in on the device
 * itself.
 */
export default function ShellPage() {
  return (
    <SignedInArea>
      <EmptyState icon="map-pin" heading="Waymark" description="Opening." />
    </SignedInArea>
  );
}
