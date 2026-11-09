import { site } from '@/src/site';
import { AppShell } from '@/src/ui/AppShell';
import { ButtonLink, EmptyState } from '@sovereignfs/ui';

export const metadata = { title: 'Not found' };

/** A page, a check-in or a trip that is not there, or is not this person's: the same answer for both (DESIGN.md §5.2), with a way back. */
export default function NotFound() {
  return (
    <AppShell name={site.name}>
      <EmptyState
        icon="search"
        heading="That is not here"
        description="It may have been deleted, or the address may be wrong."
        action={<ButtonLink href="/">Go back to Waymark</ButtonLink>}
      />
    </AppShell>
  );
}
