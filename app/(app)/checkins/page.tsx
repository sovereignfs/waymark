import { requireAccount } from '@/src/auth/session';
import { CheckinsView } from '@/src/screens/CheckinsView';

export const metadata = { title: 'Check-ins' };

/** The timeline (DESIGN.md §20.6): drawn on the device from its own store, so there is nothing to fetch here but the page. */
export default async function Page() {
  await requireAccount();
  return <CheckinsView />;
}
