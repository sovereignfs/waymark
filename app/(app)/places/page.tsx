import { requireAccount } from '@/src/auth/session';
import { PlacesView } from '@/src/screens/PlacesView';

export const metadata = { title: 'Places' };

/** The places (DESIGN.md §20.8): drawn on the device from its own store, so there is nothing to fetch here but the page. */
export default async function Page() {
  await requireAccount();
  return <PlacesView />;
}
