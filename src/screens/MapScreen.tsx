'use client';

import dynamic from 'next/dynamic';
import { useMemo, useState } from 'react';
import { Button, EmptyState } from '@sovereignfs/ui';
import { useLocal } from '../local/LocalProvider';
import { openCheckIn } from './checkin-location';
import { FilterBar } from './FilterBar';
import { fitKeyOf, mapPlacesOf, markersOf } from './mapview';
import { placeLine, visitsSentence } from './placelist';
import styles from './MapScreen.module.css';
import { filterOptions, isFiltered, localDateOf, parseFilters } from './timeline';
import { usePageLocation } from './useLocation';
import { useMapStyle } from './useMapStyle';
import { useTripCards } from './useTrips';

// MapLibre is loaded only where a map is drawn, and never on the server.
const Map = dynamic(() => import('@sovereignfs/ui/map').then((mod) => mod.Map), {
  ssr: false,
  loading: () => <p className={styles.note}>Loading the map…</p>,
});

/** The most rows of the list drawn at once: a decade is a few hundred places, and the map has them all. */
const LIST_LIMIT = 300;

const day = (checkin: { at: number; offsetMin: number }) =>
  new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', dateStyle: 'medium' }).format(
    new Date(`${localDateOf(checkin)}T12:00:00Z`),
  );

/**
 * The map (DESIGN.md §8.2, §20.7): **everywhere the person has checked in**, from the device's own store, each place a marker (clustered where they are close) that says how often; the timeline's filters (year, category,
 * country, trip, search) in the same query; a marker, or its row in the list beside it, selects the place and shows its visits and a way to open it. **The list is always there**, beside the map on a wide screen and under it on a
 * narrow one, and alone with a sentence where the server has no map (`WAYMARK_MAP_SOURCE=off`) or none can be reached (with no connection the tiles are not there), so a map is never the only way to reach a place.
 * The map asks no address but this server's. The style follows the theme.
 */
export function MapScreen() {
  const local = useLocal();
  const loc = usePageLocation();
  const style = useMapStyle();
  const { cards: trips } = useTripCards();
  const [selected, setSelected] = useState<string | undefined>(undefined);
  const filters = useMemo(() => parseFilters(loc.search), [loc.search]);
  const places = useMemo(
    () => mapPlacesOf(local?.checkins ?? [], local?.places ?? [], filters),
    [local?.checkins, local?.places, filters],
  );
  const options = useMemo(
    () =>
      filterOptions(
        local?.checkins ?? [],
        new globalThis.Map((local?.places ?? []).map((place) => [place.id, place])),
      ),
    [local?.checkins, local?.places],
  );
  const markers = useMemo(
    () => markersOf(places).map((marker) => ({ ...marker, selected: marker.id === selected })),
    [places, selected],
  );

  if (!local || !local.ready)
    return (
      <p className={styles.note} role="status">
        Loading your places…
      </p>
    );

  const set = (patch: Record<string, string | undefined>) => loc.setQuery(patch);
  const clear = () =>
    set({
      year: undefined,
      category: undefined,
      country: undefined,
      trip: undefined,
      q: undefined,
    });
  const chosen = places.find((each) => each.place.id === selected);

  if (local.checkins.length === 0)
    return (
      <EmptyState
        icon="map-pin"
        heading="Nothing on the map yet"
        description="Everywhere you check in will be on a map here."
        action={
          <Button type="button" onClick={() => openCheckIn()}>
            Check in
          </Button>
        }
      />
    );

  return (
    <div className={styles.page}>
      <FilterBar filters={filters} options={options} trips={trips} set={set} clear={clear} />
      <p className={styles.count} role="status">
        {places.length} {places.length === 1 ? 'place' : 'places'}
        {isFiltered(filters) ? ' match' : ''}
      </p>
      <div className={styles.body}>
        <div className={styles.map}>
          {style.status === 'on' ? (
            <Map
              styleUrl={style.url}
              workerUrl="/api/map/worker/maplibre-gl-worker.mjs"
              ariaLabel="Where you have been"
              markers={markers}
              cluster
              fitKey={fitKeyOf(places)}
              onMarkerSelect={setSelected}
            />
          ) : (
            <p className={styles.note} role="status">
              {style.status === 'checking'
                ? 'Loading the map…'
                : style.status === 'off'
                  ? 'There is no map on this server. The list has the same places.'
                  : 'The map cannot be reached now. The list has the same places.'}
            </p>
          )}
        </div>
        <div className={styles.side}>
          {chosen ? (
            <section className={styles.chosen} aria-label="The place chosen">
              <h2>{chosen.place.name}</h2>
              <p className={styles.muted}>{placeLine(chosen.place)}</p>
              <p>{visitsSentence(chosen.visits)}</p>
              {chosen.first && chosen.last ? (
                <p className={styles.muted}>
                  First {day(chosen.first)}, last {day(chosen.last)}
                </p>
              ) : null}
              <div className={styles.actions}>
                <a href={`/places/${chosen.place.id}`}>Open the place</a>
                <a href={`/c/${chosen.lastCheckinId}`}>Last check-in</a>
              </div>
            </section>
          ) : null}
          {places.length === 0 ? (
            <p className={styles.note}>No place matches. Clear the filters to see them all.</p>
          ) : (
            <ol className={styles.list} aria-label="Places on the map">
              {places.slice(0, LIST_LIMIT).map((each) => (
                <li key={each.place.id}>
                  <button
                    type="button"
                    className={styles.row}
                    aria-pressed={each.place.id === selected}
                    onClick={() =>
                      setSelected(each.place.id === selected ? undefined : each.place.id)
                    }
                    data-place={each.place.id}
                  >
                    <span className={styles.name}>{each.place.name}</span>
                    <span className={styles.muted}>
                      {each.visits === 1 ? '1 visit' : `${each.visits} visits`}
                    </span>
                  </button>
                </li>
              ))}
            </ol>
          )}
          {places.length > LIST_LIMIT ? (
            <p className={styles.muted}>
              And {places.length - LIST_LIMIT} more: the map has them all, and the filters narrow
              the list.
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}
