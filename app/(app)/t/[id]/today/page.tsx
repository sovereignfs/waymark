import { requireAccount } from '@/src/auth/session';
import { TripMode } from '@/src/screens/TripModeScreen';

export const metadata = { title: 'Trip Mode' };

/** Trip Mode (DESIGN.md §14.2): today on a trip, drawn on the device from its own store, so there is nothing to fetch here but the page. */
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  await requireAccount();
  const { id } = await params;
  return <TripMode id={id} />;
}
