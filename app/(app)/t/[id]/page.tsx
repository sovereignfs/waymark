import { requireAccount } from '@/src/auth/session';
import { TripPlaceholder } from '@/src/screens/TripPlaceholder';

export const metadata = { title: 'Trip' };

/** One trip (DESIGN.md §20.10): until its header and views are built, its name and dates from the device. The page asks the server for nothing about the trip; what the account may see of it is what the device was given. */
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  await requireAccount();
  const { id } = await params;
  return <TripPlaceholder id={id} />;
}
