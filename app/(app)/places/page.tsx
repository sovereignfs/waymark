import { requireAccount } from '@/src/auth/session';
import { Placeholder } from '@/src/screens/Placeholder';

export const metadata = { title: 'Places' };

export default async function Page() {
  await requireAccount();
  return (
    <Placeholder
      icon="pin"
      heading="Places"
      description="The places you have been, by how often, will be here."
    />
  );
}
