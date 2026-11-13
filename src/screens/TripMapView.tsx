'use client';

import dynamic from 'next/dynamic';
import { useMemo, useState } from 'react';
import { EmptyState, FormField, Icon, Select } from '@sovereignfs/ui';
import type { TripData } from '../local/store';
import { dayChoices } from './plan';
import styles from './TripMap.module.css';
import { type MapView, tripMapOf } from './tripmap';
import { usePageLocation } from './useLocation';
import { useMapStyle } from './useMapStyle';

// MapLibre is only loaded where a map is drawn, and never on the server.
const Map = dynamic(() => import('@sovereignfs/ui/map').then((mod) => mod.Map), {
  ssr: false,
  loading: () => <p className={styles.mapNote}>Loading the map…</p>,
});

/**
 * The trip's map (DESIGN.md §8.2, §20.10): the whole trip (the stops in order, joined by a line) or one day (its items in plan order, numbered), with the check-ins shared with the trip as a second kind of marker, and **the list of the
 * same beside it**, made from the same rows (`tripmap.ts`), so a map is never the only way to reach a place. The day is in the address (`?day=`). With no map on this server, or none reachable, the list stands alone and says why.
 */
export function TripMapView({ data }: { data: TripData }) {
  const loc = usePageLocation();
  const style = useMapStyle();
  const [selected, setSelected] = useState<string | undefined>(undefined);
  const sets = data.sets;

  const dayId = new URLSearchParams(loc.search).get('day');
  const view = useMemo<MapView>(
    () =>
      dayId && data.days.some((day) => day.id === dayId)
        ? { kind: 'day', dayId }
        : { kind: 'trip' },
    [dayId, data.days],
  );
  const names = useMemo(
    () =>
      new globalThis.Map((sets?.members ?? []).map((member) => [member.accountId, member.name])),
    [sets?.members],
  );
  const model = useMemo(
    () =>
      sets
        ? tripMapOf(
            { stops: sets.stops, days: data.days, items: data.items, shared: data.shared, names },
            view,
          )
        : undefined,
    [sets, data.days, data.items, data.shared, names, view],
  );
  if (!sets || !model) return null;
  const choices = dayChoices(sets.stops, data.days);

  return (
    <div className={styles.wrap}>
      <div className={styles.bar}>
        <FormField label="Show" className={styles.pick}>
          {(field) => (
            <Select
              {...field}
              name="day"
              value={view.kind === 'day' ? view.dayId : ''}
              onChange={(event) => loc.setQuery({ day: event.target.value || undefined })}
            >
              <option value="">The whole trip</option>
              {choices.map((choice) => (
                <option key={choice.id} value={choice.id}>
                  {choice.label}
                </option>
              ))}
            </Select>
          )}
        </FormField>
      </div>

      {sets.stops.length === 0 ? (
        <EmptyState
          icon="map-pin"
          heading="Nothing to show"
          description="Add a stop in the plan, and it is on the map."
        />
      ) : (
        <div className={styles.body}>
          <div className={styles.map}>
            {style.status === 'on' ? (
              <Map
                styleUrl={style.url}
                workerUrl="/api/map/worker/maplibre-gl-worker.mjs"
                ariaLabel={view.kind === 'day' ? 'The day on the map' : 'The trip on the map'}
                markers={model.markers.map((marker) => ({
                  ...marker,
                  selected: marker.id === selected,
                }))}
                line={model.line}
                fitKey={model.fitKey}
                onMarkerSelect={setSelected}
              />
            ) : (
              <p className={styles.mapNote} role="status">
                {style.status === 'checking'
                  ? 'Loading the map…'
                  : style.status === 'off'
                    ? 'There is no map on this server. The list has the same places.'
                    : 'The map cannot be reached now. The list has the same places.'}
              </p>
            )}
          </div>
          <div>
            {model.rows.length === 0 ? (
              <p className={styles.empty}>Nothing is planned or shared for this day.</p>
            ) : (
              <ol className={styles.list} aria-label="On the map">
                {model.rows.map((row) => (
                  <li key={row.id}>
                    <button
                      type="button"
                      className={styles.row}
                      aria-pressed={row.id === selected}
                      disabled={false}
                      onClick={() => setSelected(row.id === selected ? undefined : row.id)}
                      data-row={row.id}
                    >
                      <span className={styles.rowName}>
                        {row.kind === 'shared' ? (
                          <span className={styles.shared}>
                            <Icon name="map-pin" aria-hidden />
                          </span>
                        ) : null}
                        {row.label}
                      </span>
                      {row.detail ? <span className={styles.detail}>{row.detail}</span> : null}
                    </button>
                  </li>
                ))}
              </ol>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
