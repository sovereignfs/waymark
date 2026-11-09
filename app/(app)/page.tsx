import { requireAccount } from '@/src/auth/session';
import { Placeholder } from '@/src/screens/Placeholder';

export const metadata = { title: 'Home' };

export default async function Page() {
  await requireAccount();
  return (
    <Placeholder
      icon="house"
      heading="Home"
      description="Your latest check-ins and a summary of where you have been will be here."
    />
  );
}
