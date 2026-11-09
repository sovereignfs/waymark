import { EmptyState, type IconName } from '@sovereignfs/ui';

/** What a place of the shell shows until its own task fills it (epic 7): it says what will be here, and nothing that is not true yet. */
export function Placeholder({
  icon,
  heading,
  description,
}: {
  icon: IconName;
  heading: string;
  description: string;
}) {
  return <EmptyState icon={icon} heading={heading} description={description} />;
}
