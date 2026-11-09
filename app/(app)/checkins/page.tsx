import { requireAccount } from '@/src/auth/session';
import { Placeholder } from '@/src/screens/Placeholder';

export const metadata = { title: 'Check-ins' };

export default async function Page() {
  await requireAccount();
  return (
    <Placeholder
      icon="list"
      heading="Check-ins"
      description="Every place you have checked in, newest first, will be here."
    />
  );
}
