import { requireAccount } from '@/src/auth/session';
import { MapScreen } from '@/src/screens/MapScreen';

export const metadata = { title: 'Map' };

export default async function Page() {
  await requireAccount();
  return <MapScreen />;
}
