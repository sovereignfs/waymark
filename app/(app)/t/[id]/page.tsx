import { requireAccount } from '@/src/auth/session';
import { TripPage } from '@/src/screens/TripPage';

export const metadata = { title: 'Trip' };

/** One trip (DESIGN.md §20.10): drawn on the device from its own store, so there is nothing to fetch here but the page. What the account may see of a trip is what the device was given. */
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  await requireAccount();
  const { id } = await params;
  return <TripPage id={id} />;
}
