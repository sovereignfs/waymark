'use client';

import { useEffect } from 'react';
import { keptKey, parseKept, prune } from '../map/offline';
import { localDate } from '../places/tz';
import { dropTiles } from '../sw/tiles';
import { useLocal } from '../local/LocalProvider';

/**
 * Lets go of the maps this device kept for a trip that has ended or is gone (DESIGN.md §14.5), once the store has been read: the record is the device's own (`src/map/offline.ts`), and a file is dropped only when no trip that is
 * still wanted needs it. Draws nothing.
 */
export function KeptMaps() {
  const local = useLocal();
  const ready = Boolean(local?.ready);
  const accountId = local?.accountId;
  const trips = local?.trips;
  useEffect(() => {
    if (!ready || !accountId || !trips) return;
    try {
      const key = keptKey(accountId);
      const kept = parseKept(window.localStorage.getItem(key));
      if (Object.keys(kept).length === 0) return;
      const today = localDate(Date.now(), Intl.DateTimeFormat().resolvedOptions().timeZone);
      const result = prune(kept, today, new Set(trips.map((trip) => trip.id)));
      if (Object.keys(result.kept).length === Object.keys(kept).length) return;
      window.localStorage.setItem(key, JSON.stringify(result.kept));
      if (result.drop.length > 0) void dropTiles(result.drop);
    } catch {
      // A browser that will not say: the maps stay until sign-out or Settings.
    }
  }, [ready, accountId, trips]);
  return null;
}
