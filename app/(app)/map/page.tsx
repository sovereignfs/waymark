import { requireAccount } from '@/src/auth/session';
import { Placeholder } from '@/src/screens/Placeholder';

export const metadata = { title: 'Map' };

export default async function Page() {
  await requireAccount();
  return (
    <Placeholder
      icon="map-pin"
      heading="Map"
      description="Everywhere you have checked in will be on a map here."
    />
  );
}
