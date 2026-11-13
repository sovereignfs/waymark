'use client';

import { useEffect, useState } from 'react';
import { useLocal } from '../local/LocalProvider';
import type { TripData } from '../local/store';

/**
 * A trip's rows from the device (`LocalStore.tripView`), read again whenever the store has been (a sync, a change in the outbox). `loading` until the store has been read once; `undefined` data for a trip the device does not
 * hold, which is also what a trip the person has left, been removed from or never was in looks like.
 */
export function useTripData(id: string): { loading: boolean; data: TripData | undefined } {
  const local = useLocal();
  const ready = Boolean(local?.ready);
  const revision = local?.revision ?? 0;
  const [state, setState] = useState<{ loading: boolean; data: TripData | undefined }>({
    loading: true,
    data: undefined,
  });
  useEffect(() => {
    if (!local || !ready) return;
    let current = true;
    void local.trip(id).then(
      (data) => current && setState({ loading: false, data }),
      () => current && setState({ loading: false, data: undefined }),
    );
    return () => {
      current = false;
    };
    // `local` is a new object whenever the store has been read again, which is when the revision counts up.
  }, [id, ready, revision, local]);
  return state;
}
