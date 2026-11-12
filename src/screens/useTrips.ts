'use client';

import { useEffect, useMemo, useState } from 'react';
import { useLocal } from '../local/LocalProvider';
import { type TripCard, cardsOf } from './trips';

/** How often a status is worked out again while a page is open: a trip begins at a midnight, and the screen should not wait for a reload to say so. */
export const TICK_MS = 60_000;

/**
 * The trips the device holds as cards, with each status worked out against the device's clock (`trips.ts`). `ready` is false until the store has been read once, so that "no trips" is not said of a store that is still opening.
 */
export function useTripCards(): { ready: boolean; cards: readonly TripCard[] } {
  const local = useLocal();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, []);
  const trips = local?.trips;
  const cards = useMemo(() => cardsOf(trips ?? [], now), [trips, now]);
  return { ready: Boolean(local?.ready), cards };
}
