import { Landing } from '@/src/landing/Landing';
import { site } from '@/src/site';
import { AppShell } from '@/src/ui/AppShell';

// The front address (DESIGN.md §20.3). For a visitor, this page; for someone with a session cookie, the proxy has already sent the request to Home (`/home`) before it
// gets here, and the address stays `/`. **Nothing of anyone is in it**: it is the same for every visitor, and says only what the server is set up to offer.
export default function Front() {
  return (
    <AppShell name={site.name}>
      <Landing />
    </AppShell>
  );
}
