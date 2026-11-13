'use client';

import { Icon, SplitPane } from '@sovereignfs/ui';
import type { TripData } from '../local/store';
import { PlanView } from './PlanView';
import { TripMapView } from './TripMapView';
import styles from './TripMap.module.css';
import { usePageLocation } from './useLocation';

/**
 * The Plan, and the trip's map beside it if the person asks (DESIGN.md §20.10): `?beside=map` in the address, so a link and a reload keep it and the same page is the same at every width. **The design system's
 * `SplitPane` puts them side by side where there is room and stacks them where there is not**; nothing here asks how wide the screen is.
 */
export function PlanWithMap({ tripId, data }: { tripId: string; data: TripData }) {
  const loc = usePageLocation();
  const beside = new URLSearchParams(loc.search).get('beside') === 'map';
  return (
    <>
      <button
        type="button"
        className={styles.toggle}
        aria-pressed={beside}
        onClick={() => loc.setQuery({ beside: beside ? undefined : 'map' })}
      >
        <Icon name="map-pin" aria-hidden /> Map beside the plan
      </button>
      {beside ? (
        <SplitPane
          primary={<PlanView tripId={tripId} data={data} />}
          secondary={<TripMapView data={data} />}
          defaultPrimarySize={58}
          minPrimarySize={35}
          maxPrimarySize={75}
          primaryLabel="Plan"
          secondaryLabel="Map"
        />
      ) : (
        <PlanView tripId={tripId} data={data} />
      )}
    </>
  );
}
