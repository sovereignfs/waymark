'use client';

import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useMemo } from 'react';
import { AvatarStack, Badge, Button, EmptyState, Icon } from '@sovereignfs/ui';
import { figures } from '../figures/figures';
import { journalOfTrip } from '../journal';
import { useLocal } from '../local/LocalProvider';
import { localDate } from '../places/tz';
import { openCheckIn } from './checkin-location';
import styles from './Home.module.css';
import { isNewPerson, nearestPlace, nextTrip, ongoingTrip, recently, untilText } from './home';
import { fitKeyOf, mapPlacesOf, markersOf } from './mapview';
import { PhotoImage } from './PhotoImage';
import { placeLine } from './placelist';
import { localDateOf, localTimeOf } from './timeline';
import { nextSentence } from './TripOverview';
import { overviewOf } from './trip';
import { DOT, STATUS_LABEL, datesText } from './trips';
import { useMapStyle } from './useMapStyle';
import { usePosition } from './usePosition';
import { useTripData } from './useTrip';
import { useTripCards } from './useTrips';

// MapLibre is loaded only where a map is drawn, and never on the server.
const Map = dynamic(() => import('@sovereignfs/ui/map').then((mod) => mod.Map), {
  ssr: false,
  loading: () => null,
});

const dayText = (checkin: { at: number; offsetMin: number }) =>
  new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', dateStyle: 'medium' }).format(
    new Date(`${localDateOf(checkin)}T12:00:00Z`),
  );

/** _Now_ on an ongoing trip: its Trip Mode card: where the person is on the plan, what is next and _Open Trip Mode_. The next thing is Today's own answer (`src/today/`), so it is what Trip Mode will say. */
function TripModeCard({ id, name, color }: { id: string; name: string; color: keyof typeof DOT }) {
  const local = useLocal();
  const { data } = useTripData(id);
  const text = useMemo(() => {
    if (!data?.sets || !local) return undefined;
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const now = Date.now();
    const journal = journalOfTrip(
      data,
      id,
      local.checkins,
      local.places,
      local.accountId,
      now,
      zone,
    );
    if (!journal) return undefined;
    return nextSentence(
      overviewOf(
        { sets: data.sets, items: data.items, days: data.days, done: data.done, journal },
        now,
        zone,
      ).next,
    );
  }, [data, local, id]);
  return (
    <section className={styles.card} aria-label="Now">
      <h2>
        <span className={styles.dot} style={{ background: DOT[color] }} aria-hidden /> {name}
      </h2>
      <p className={styles.muted}>On now</p>
      {text ? <p>{text}</p> : null}
      <Link className={styles.primaryLink} href={`/t/${id}/today`}>
        <Icon name="route" aria-hidden /> Open Trip Mode
      </Link>
    </section>
  );
}

/** The year on a small map: the places checked in at this year, the same markers as the map's, and no filters. */
function YearMap({ markers, fitKey }: { markers: ReturnType<typeof markersOf>; fitKey: string }) {
  const style = useMapStyle();
  if (style.status !== 'on' || markers.length === 0) return null;
  return (
    <div className={styles.yearMap}>
      <Map
        styleUrl={style.url}
        workerUrl="/api/map/worker/maplibre-gl-worker.mjs"
        ariaLabel="Where you have been this year"
        markers={markers}
        cluster
        fitKey={fitKey}
      />
    </div>
  );
}

/**
 * Home (DESIGN.md §20.4), which is the front address `/` for someone signed in: **where the person is, then what is next.** _Now_: on an ongoing trip its Trip Mode card, otherwise _Check in_, large, with the nearest of their
 * places when the position is already known; _Next trip_; _Recently_, the last ten check-ins with photos; and the year's figures with a small map. **It paints from the device's store** with nothing to wait for once the store has
 * been read, and a new person sees two empty states side by side. The server's page and the offline shell draw this one.
 */
export function HomeScreen() {
  const local = useLocal();
  const { ready, cards } = useTripCards();
  const { state: position } = usePosition(true);
  const here = position.status === 'granted' ? position.position : undefined;

  const checkins = local?.checkins;
  const places = local?.places;
  const nearby = useMemo(() => nearestPlace(places ?? [], here), [places, here]);
  const last = useMemo(() => recently(checkins ?? []), [checkins]);
  const now = Date.now();
  const offsetMin = -new Date(now).getTimezoneOffset();
  const numbers = useMemo(
    () => figures(checkins ?? [], places ?? [], { now, offsetMin }),
    // The year is the viewer's and moves only at a midnight: a figure is worked out again when the store changes.
    [checkins, places],
  );
  const year = new Date(now).getFullYear();
  const yearPlaces = useMemo(
    () => mapPlacesOf(checkins ?? [], places ?? [], { q: '', year }),
    [checkins, places, year],
  );

  if (!local || !local.ready || !ready) return null;
  const on = ongoingTrip(cards);
  const next = nextTrip(cards);
  const today = localDate(now, Intl.DateTimeFormat().resolvedOptions().timeZone);
  const placeById = new globalThis.Map(local.places.map((place) => [place.id, place]));

  if (isNewPerson(local.checkins, cards))
    return (
      <div className={styles.page}>
        <h1 className={styles.heading}>Home</h1>
        <div className={styles.empties}>
          <EmptyState
            icon="map-pin"
            heading="Check in where you are"
            description="A place, a note, a photo. Everywhere you have been will be here, and on a map."
            action={
              <div className={styles.actions}>
                <Button type="button" onClick={() => openCheckIn()}>
                  Check in
                </Button>
                <Link className={styles.secondaryLink} href="/settings">
                  Import from Swarm
                </Link>
              </div>
            }
          />
          <EmptyState
            icon="luggage"
            heading="Plan a trip"
            description="Stops, days and things to do, with the people going and the people following."
            action={
              <Link className={styles.primaryLink} href="/trips?new=1">
                New trip
              </Link>
            }
          />
        </div>
      </div>
    );

  return (
    <div className={styles.page}>
      <h1 className={styles.heading}>Home</h1>

      {on ? (
        <TripModeCard id={on.id} name={on.name} color={on.color} />
      ) : (
        <section className={styles.card} aria-label="Now">
          <h2>Now</h2>
          <Button type="button" className={styles.big} onClick={() => openCheckIn()}>
            <Icon name="plus" aria-hidden /> Check in
          </Button>
          {nearby ? (
            <p className={styles.muted}>
              You are near <strong>{nearby.place.name}</strong>
              {nearby.metres < 1000 ? ` (${Math.round(nearby.metres)} m)` : ''}.
            </p>
          ) : null}
        </section>
      )}

      {next && next.startDate ? (
        <section className={styles.card} aria-label="Next trip">
          <h2>Next trip</h2>
          <p className={styles.tripName}>
            <span className={styles.dot} style={{ background: DOT[next.color] }} aria-hidden />
            <Link href={`/t/${next.id}`}>{next.name}</Link>
            <Badge size="xs">{STATUS_LABEL[next.status]}</Badge>
          </p>
          <p className={styles.muted}>
            {datesText(next.startDate, next.endDate)}, {untilText(next.startDate, today)}
          </p>
          {next.people.length > 0 ? (
            <AvatarStack people={next.people} max={5} size="sm" label="Going" />
          ) : null}
        </section>
      ) : null}

      {last.length > 0 ? (
        <section className={styles.card} aria-label="Recently">
          <h2>Recently</h2>
          <ol className={styles.recent}>
            {last.map((checkin) => {
              const where = placeById.get(checkin.placeId);
              const photo = checkin.photos?.[0];
              return (
                <li key={checkin.id}>
                  <Link
                    href={`/c/${checkin.id}`}
                    className={styles.recentRow}
                    data-checkin={checkin.id}
                  >
                    {photo ? (
                      <span className={styles.thumb}>
                        <PhotoImage id={photo} thumb alt="First photo" />
                      </span>
                    ) : (
                      <span className={styles.thumb} aria-hidden>
                        <Icon name="map-pin" aria-hidden />
                      </span>
                    )}
                    <span className={styles.recentMain}>
                      <span className={styles.name}>{where?.name ?? 'A place'}</span>
                      <span className={styles.muted}>
                        {dayText(checkin)}, {localTimeOf(checkin)}
                        {where ? ` · ${placeLine(where)}` : ''}
                      </span>
                    </span>
                  </Link>
                </li>
              );
            })}
          </ol>
        </section>
      ) : null}

      <section className={styles.card} aria-label="Figures">
        <h2>Figures</h2>
        <dl className={styles.figures}>
          <div>
            <dt>Check-ins this year</dt>
            <dd>{numbers.thisYear}</dd>
          </div>
          <div>
            <dt>Places</dt>
            <dd>{numbers.places}</dd>
          </div>
          <div>
            <dt>Countries</dt>
            <dd>{numbers.countries.length}</dd>
          </div>
        </dl>
        <YearMap markers={markersOf(yearPlaces)} fitKey={fitKeyOf(yearPlaces)} />
      </section>
    </div>
  );
}
