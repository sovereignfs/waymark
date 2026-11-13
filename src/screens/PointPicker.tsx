'use client';

import dynamic from 'next/dynamic';
import { loadMap } from './loadMap';
import type { Position } from './checkin-flow';
import { useMapStyle } from './useMapStyle';
import styles from './PointPicker.module.css';

// MapLibre is loaded only where a map is drawn, and never on the server.
const Map = dynamic(loadMap, {
  ssr: false,
  loading: () => <p className={styles.note}>Loading the map…</p>,
});

/**
 * _On the map_ (DESIGN.md §9.2, §20.5): the design system's `Map` as a place to choose a point: **a click or a tap chooses it, and with the map focused the arrow keys move it and Enter chooses its middle**. The point is the
 * position the sheet then offers places near, as _Here_ does. It needs the server's own map (`useMapStyle`) and is only drawn when there is one; the sheet does not offer the way otherwise.
 */
export function PointPicker({
  value,
  onPick,
  start,
}: {
  value: Position | undefined;
  onPick: (point: Position) => void;
  /** Where the map opens: the person's position if they have allowed it. */
  start: Position | undefined;
}) {
  const style = useMapStyle();
  if (style.status !== 'on')
    return (
      <p className={styles.note} role="status">
        {style.status === 'checking' ? 'Loading the map…' : 'The map is not available now.'}
      </p>
    );
  return (
    <div className={styles.picker}>
      <Map
        styleUrl={style.url}
        workerUrl="/api/map/worker/maplibre-gl-worker.mjs"
        ariaLabel="Choose a point on the map"
        pick={{ value: value ?? null, onPick }}
        {...(start ? { center: start, zoom: 13 } : {})}
      />
    </div>
  );
}
