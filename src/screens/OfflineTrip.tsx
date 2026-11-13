'use client';

import { useEffect, useMemo, useState } from 'react';
import { Button, Progress } from '@sovereignfs/ui';
import { type Kept, forget, keepFor, keptKey, parseKept } from '../map/offline';
import { tripTiles } from '../map/tilemath';
import { dropTiles, keepTiles } from '../sw/tiles';
import { useLocal } from '../local/LocalProvider';
import type { StopRecord } from '../sync/trip-format';
import styles from './Trip.module.css';

const read = (accountId: string): Kept => {
  try {
    return parseKept(window.localStorage.getItem(keptKey(accountId)));
  } catch {
    return {};
  }
};
const write = (accountId: string, kept: Kept) => {
  try {
    window.localStorage.setItem(keptKey(accountId), JSON.stringify(kept));
  } catch {
    // A browser that will not keep it: the maps are kept all the same, and are let go of at sign-out.
  }
};

/**
 * _Download for offline_ on a trip that is upcoming or on (DESIGN.md §14.5): the map's tiles **around each stop, to a street level, and a bounded number for the trip**, fetched through this server into the service worker's cache of
 * public map files, so that Trip Mode and the trip's map draw with no network. The trip's rows are always on the device (sync); this is the map. They are removed when the trip ends, when the trip is gone, at sign-out and from
 * Settings. The person can do it at once on Wi-Fi, and it says how it went.
 */
export function OfflineTrip({
  tripId,
  stops,
  endDate,
}: {
  tripId: string;
  stops: readonly StopRecord[];
  endDate: string | null;
}) {
  const local = useLocal();
  const accountId = local?.accountId;
  const [kept, setKept] = useState<Kept>({});
  const [working, setWorking] = useState<{ progress: number; total: number } | undefined>(
    undefined,
  );
  const [sentence, setSentence] = useState<string | undefined>(undefined);
  useEffect(() => {
    if (accountId) setKept(read(accountId));
  }, [accountId]);

  const points = useMemo(
    () => stops.map((stop) => ({ lat: stop.place.lat, lng: stop.place.lng })),
    [stops],
  );
  if (!accountId || !endDate || points.length === 0) return null;
  const mine = kept[tripId];

  const download = async () => {
    setSentence(undefined);
    const urls = tripTiles(points);
    setWorking({ progress: 0, total: urls.length });
    const result = await keepTiles(urls, setWorking);
    setWorking(undefined);
    if (!result.ok)
      return setSentence('This browser cannot keep maps for later, so the map needs a connection.');
    const next = keepFor(read(accountId), tripId, urls, endDate);
    write(accountId, next);
    setKept(next);
    setSentence(
      result.failed > 0
        ? `${result.kept} of ${result.total} map files are kept; the rest could not be fetched. Try again when the connection is better.`
        : undefined,
    );
  };

  const remove = async () => {
    const gone = forget(read(accountId), tripId);
    write(accountId, gone.kept);
    setKept(gone.kept);
    await dropTiles(gone.drop);
  };

  return (
    <section aria-label="Offline" className={styles.section}>
      <h2>Offline</h2>
      {working ? (
        <>
          <p className={styles.muted} role="status">
            Downloading the map around the stops…
          </p>
          <Progress
            label="Map files downloaded"
            value={Math.round((working.progress / Math.max(1, working.total)) * 100)}
          />
        </>
      ) : mine ? (
        <>
          <p>The map around the stops is kept on this device, and the trip with it.</p>
          <div className={styles.linkAdd}>
            <Button variant="secondary" onClick={() => void download()}>
              Download again
            </Button>
            <Button variant="ghost" onClick={() => void remove()}>
              Remove from this device
            </Button>
          </div>
        </>
      ) : (
        <>
          <p className={styles.muted}>
            The trip’s plan is always on this device. Download the map around its stops to use Trip
            Mode and the map with no connection.
          </p>
          <Button onClick={() => void download()}>Download for offline</Button>
        </>
      )}
      {sentence ? (
        <p role="status" className={styles.muted}>
          {sentence}
        </p>
      ) : null}
    </section>
  );
}
