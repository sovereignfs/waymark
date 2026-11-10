'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Position } from './checkin-flow';

/**
 * The device's position for _Here_ (DESIGN.md §9.2): **asked for when it is first used and never needed**. If the browser has already been told yes, it is read at once, without a question; if it has been told no, it is
 * not asked again, and _Here_ is not offered, with a sentence that says why; a device that cannot tell is the same. Checking in never waits on it.
 */
export type PositionState =
  | { status: 'idle' }
  | { status: 'asking' }
  | { status: 'granted'; position: Position }
  | { status: 'denied' | 'unavailable' };

/** `enabled` is false for a form that has no use for the position (changing a check-in): nothing is read, and nothing is asked. */
export function usePosition(enabled = true): { state: PositionState; ask: () => void } {
  const [state, setState] = useState<PositionState>({ status: 'idle' });
  const asked = useRef(false);

  const ask = useCallback(() => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      setState({ status: 'unavailable' });
      return;
    }
    asked.current = true;
    setState({ status: 'asking' });
    navigator.geolocation.getCurrentPosition(
      (found) =>
        setState({
          status: 'granted',
          position: { lat: found.coords.latitude, lng: found.coords.longitude },
        }),
      (error) => setState({ status: error.code === 1 ? 'denied' : 'unavailable' }),
      { enableHighAccuracy: false, timeout: 10_000, maximumAge: 60_000 },
    );
  }, []);

  // Told yes already: read it without asking. Told no: say so. Otherwise wait to be asked.
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    const permissions = typeof navigator !== 'undefined' ? navigator.permissions : undefined;
    if (!permissions?.query) return;
    permissions
      .query({ name: 'geolocation' })
      .then((status) => {
        if (!alive || asked.current) return;
        if (status.state === 'granted') ask();
        else if (status.state === 'denied') setState({ status: 'denied' });
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [ask, enabled]);

  return { state, ask };
}
