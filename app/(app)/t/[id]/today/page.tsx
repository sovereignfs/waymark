import { requireAccount } from '@/src/auth/session';
import { Placeholder } from '@/src/screens/Placeholder';

export const metadata = { title: 'Trip Mode' };

/** Trip Mode (DESIGN.md §14.2), until its screen is built: the rules (`src/today/`) are done, and this says so rather than showing a page that is not found. */
export default async function Page() {
  await requireAccount();
  return (
    <Placeholder
      icon="route"
      heading="Trip Mode"
      description="Today's plan, with what is next and how to get there, is not built yet."
    />
  );
}
