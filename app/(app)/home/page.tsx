import { requireAccount } from '@/src/auth/session';
import { Placeholder } from '@/src/screens/Placeholder';

export const metadata = { title: 'Home' };

// Home (DESIGN.md §20.4), which is the front address `/` for someone signed in: the proxy shows this page there, and the address stays `/`. Its own address, `/home`,
// is sent back to `/`, so that there is one. The summary and the latest check-ins are 7.6.
export default async function HomePage() {
  await requireAccount();
  return (
    <Placeholder
      icon="house"
      heading="Home"
      description="Your latest check-ins and a summary of where you have been will be here."
    />
  );
}
