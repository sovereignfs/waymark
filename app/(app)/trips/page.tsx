import { requireAccount } from '@/src/auth/session';
import { TripsView } from '@/src/screens/TripsView';

export const metadata = { title: 'Trips' };

/** The trips (DESIGN.md §20.9): drawn on the device from its own store, so there is nothing to fetch here but the page. */
export default async function Page() {
  await requireAccount();
  return <TripsView />;
}
