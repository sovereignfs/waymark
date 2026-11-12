'use client';

import { usePageLocation } from './useLocation';
import { Placeholder } from './Placeholder';
import { STATUS_LABEL, datesText } from './trips';
import { useTripCards } from './useTrips';

/** What `/t/<id>` shows until the trip's own page is built: the trip's name and dates from the device, and an honest line about the rest. A trip the device does not hold is the same page, which says no more than that it is not here. */
export function TripPlaceholder({ id }: { id: string }) {
  usePageLocation();
  const { ready, cards } = useTripCards();
  const card = cards.find((each) => each.id === id);
  if (!ready) return <p role="status">Loading the trip…</p>;
  if (!card)
    return (
      <Placeholder
        icon="luggage"
        heading="This trip is not here"
        description="It may have been deleted, or you may not be a member of it."
      />
    );
  return (
    <Placeholder
      icon="luggage"
      heading={card.name}
      description={`${STATUS_LABEL[card.status]} · ${datesText(card.startDate, card.endDate)}. The trip's own page is not built yet.`}
    />
  );
}
