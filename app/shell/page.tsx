import type { Metadata } from 'next';
import { OfflineApp } from '@/src/screens/OfflineApp';

export const metadata: Metadata = { title: 'Waymark', robots: { index: false, follow: false } };

/**
 * The one page the service worker keeps (DESIGN.md §20.12), answered for the app's screens when there is no network. **It holds nothing of a person** and asks nothing of the session: it is the same
 * for everyone, and is the page the app starts from on a device with no server to ask. Who is signed in is found on the device, in the browser (`OfflineApp`).
 */
export default function ShellPage() {
  return <OfflineApp />;
}
