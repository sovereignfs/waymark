import { EmptyState } from '@sovereignfs/ui';

/**
 * What is in the check-in sheet (DESIGN.md §9.2, §20.5). **The ways to check in are 7.2's**: here, for now, is what is true: the sheet is there, in the address, over any page, and closes back. It is replaced by
 * 7.2's content and nothing else of the sheet changes.
 */
export function CheckInContent() {
  return (
    <EmptyState
      icon="map-pin"
      heading="Check in"
      description="Choosing where you are, searching for a place and picking one on the map are coming. Close this to go back to where you were."
    />
  );
}
