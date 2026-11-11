import { requireAccount } from '@/src/auth/session';
import { PlacesView } from '@/src/screens/PlacesView';

export const metadata = { title: 'Place' };

/** One place (DESIGN.md §20.8), beside the list on a wide screen and a page on a narrow one: the same page as `/places`, which draws what the address says. */
export default async function Page() {
  await requireAccount();
  return <PlacesView />;
}
