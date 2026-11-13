'use client';

import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { Badge, Button, EmptyState, Icon } from '@sovereignfs/ui';
import { markDone } from '../actions/items';
import { directionsLink, platformOf } from '../directions/directions';
import { journalOfTrip } from '../journal';
import { useLocal } from '../local/LocalProvider';
import { type TodayItemView, todayOfTrip } from '../today';
import type { ItemRecord } from '../sync/trip-format';
import { openCheckIn } from './checkin-location';
import { actionContext } from './planContext';
import { KIND_ICON } from './plan';
import styles from './TripModeScreen.module.css';
import { countdownText, dayLine, screenOf, tripDayNumber } from './tripmode';
import { tripMapOf } from './tripmap';
import { DOT, datesText } from './trips';
import { usePosition } from './usePosition';
import { useMapStyle } from './useMapStyle';
import { useTripData } from './useTrip';
import { useTripCards } from './useTrips';

// MapLibre is loaded only where a map is drawn, and never on the server.
const Map = dynamic(() => import('@sovereignfs/ui/map').then((mod) => mod.Map), {
  ssr: false,
  loading: () => null,
});

const nameOf = (item: ItemRecord) => item.title?.trim() || item.place?.name || 'Something planned';

/**
 * Trip Mode (DESIGN.md §14.2), at `/t/<id>/today`: **today on the trip, phone first and the same screen wider.** For a Traveler or an Organizer who is going, on a trip that is on: the day and the stop (both on a travel day), a map of the day's
 * items numbered with the person's own position, **Next** with its countdown, _Directions_ (the device's own maps, `src/directions/`) and _Check in_ (the sheet filled in with the item's place and the trip), and the day's items with _Done_ for
 * each. **Everything is drawn from the device**, so it works with no network (the tiles are the server's and are the map's only part that is not); what is done is the journal's (a check-in at the item's place) and the person's own mark.
 * Outside the trip's dates it says when the trip starts or that it ended, and for someone who is not going it says Trip Mode is for the people going; each with a way to the plan.
 */
export function TripMode({ id }: { id: string }) {
  const local = useLocal();
  const { loading, data } = useTripData(id);
  const { cards } = useTripCards();
  const style = useMapStyle();
  const { state: position } = usePosition(true);
  const [now, setNow] = useState(() => Date.now());
  const [directions, setDirections] = useState<
    (to: { lat: number; lng: number; name: string }) => string | undefined
  >(() => () => undefined);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  // The device's own maps, decided from what the browser says of itself, once it is in the browser.
  useEffect(() => {
    const platform = platformOf({
      userAgent: navigator.userAgent,
      platform: navigator.platform,
      maxTouchPoints: navigator.maxTouchPoints,
    });
    setDirections(
      () => (to: { lat: number; lng: number; name: string }) => directionsLink(platform, to),
    );
  }, []);

  const card = cards.find((each) => each.id === id);
  const sets = data?.sets;
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  const model = useMemo(() => {
    if (!data || !sets || !local || !card) return undefined;
    const journal = journalOfTrip(
      data,
      id,
      local.checkins,
      local.places,
      local.accountId,
      now,
      zone,
    );
    // Done is the journal's (a check-in at the item's place that day) and the person's own mark.
    const done = new Set([...data.done, ...(journal?.doneItems ?? [])]);
    const today = todayOfTrip(
      { stops: sets.stops, days: data.days, items: data.items, done },
      now,
      zone,
    );
    const screen = screenOf({
      role: data.role,
      going: sets.trip.going,
      status: card.status,
      state: today.state,
      edge: today.edge,
    });
    return { today, screen, doneByJournal: journal?.doneItems ?? new Set<string>() };
  }, [data, sets, local, card, id, now, zone]);

  if (loading || !local?.ready)
    return (
      <p role="status" className={styles.note}>
        Loading…
      </p>
    );
  if (!data || !sets || !card || !model)
    return (
      <EmptyState
        icon="luggage"
        heading="This trip is not here"
        description="It may have been deleted, or you may not be a member of it."
        action={<Link href="/trips">All trips</Link>}
      />
    );

  const { today, screen } = model;
  const header = (
    <header className={styles.header}>
      <Link href={`/t/${id}`} className={styles.back}>
        <Icon name="chevron-left" aria-hidden />{' '}
        <span className={styles.dot} style={{ background: DOT[card.color] }} aria-hidden />{' '}
        {card.name}
      </Link>
    </header>
  );
  const away = (heading: string, description: string) => (
    <div className={styles.page}>
      {header}
      <EmptyState
        icon="route"
        heading={heading}
        description={description}
        action={<Link href={`/t/${id}?view=plan`}>Open the plan</Link>}
      />
    </div>
  );

  const dateText = (date: string) =>
    new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', dateStyle: 'long' }).format(
      new Date(`${date}T12:00:00Z`),
    );
  switch (screen.kind) {
    case 'not-going':
      return away(
        'Trip Mode is for the people going',
        'Followers, and Organizers who are not going, read the plan and the journal instead.',
      );
    case 'not-ready':
      return away(
        'Trip Mode needs a trip that is ready',
        'An Organizer marks the trip ready when its planning is done.',
      );
    case 'before':
      return away(
        `The trip starts on ${dateText(screen.date)}`,
        `${datesText(card.startDate, card.endDate)}. Trip Mode is here from its first day.`,
      );
    case 'after':
      return away(
        `The trip ended on ${dateText(screen.date)}`,
        'Its journal has what was planned beside what happened.',
      );
    case 'between':
      return away(
        'Between two stops today',
        'There is nothing planned on a day that is in neither of them.',
      );
    case 'during':
      break;
  }

  const stopNames = today.stopIds
    .map((stopId) => sets.stops.find((stop) => stop.id === stopId)?.place.name ?? '')
    .filter(Boolean);
  const dayNumber = tripDayNumber(data.days, today.date);
  const current = today.days.at(-1);
  const next = today.next;
  const nextItem = next ? data.items.find((each) => each.id === next.item.id) : undefined;
  const placed = nextItem?.place;
  const toNext = placed
    ? directions({ lat: placed.lat, lng: placed.lng, name: nameOf(nextItem as ItemRecord) })
    : undefined;

  // The map: the current day's items, numbered in the order shown, and the person's position.
  const names = new globalThis.Map(sets.members.map((member) => [member.accountId, member.name]));
  const map = current
    ? tripMapOf(
        { stops: sets.stops, days: data.days, items: data.items, shared: [], names },
        { kind: 'day', dayId: current.day.id },
      )
    : undefined;

  const toggle = async (view: TodayItemView<ItemRecord>) => {
    const made = markDone(id, view.item.id, !data.done.has(view.item.id), actionContext());
    if (made.ok) await local.record(made.mutation);
  };

  return (
    <div className={styles.page}>
      {header}
      <h1 className={styles.title}>{dayLine(stopNames, dayNumber)}</h1>

      {style.status === 'on' &&
      map &&
      map.markers.length + (position.status === 'granted' ? 1 : 0) > 0 ? (
        <div className={styles.map}>
          <Map
            styleUrl={style.url}
            workerUrl="/api/map/worker/maplibre-gl-worker.mjs"
            ariaLabel="Today on the map"
            markers={map.markers.map((marker) => ({
              ...marker,
              selected: marker.id === (next ? `item:${next.item.id}` : ''),
            }))}
            {...(position.status === 'granted' ? { position: position.position } : {})}
            fitKey={`${current?.day.id ?? ''}:${map.markers.length}`}
            {...(map.line.length > 1 ? { line: map.line } : {})}
          />
        </div>
      ) : null}

      {today.empty || !current ? (
        <EmptyState
          icon="calendar-days"
          heading="Nothing is planned for today"
          description="Enjoy it, or add something in the plan."
          action={<Link href={`/t/${id}?view=plan`}>Open the plan</Link>}
        />
      ) : (
        <>
          <section className={styles.next} aria-label="Next">
            <span className={styles.label}>Next</span>
            {next && nextItem ? (
              <>
                <h2 className={styles.nextName}>{nameOf(nextItem)}</h2>
                <p className={styles.muted}>
                  {next.inMinutes !== null ? countdownText(next.inMinutes) : 'untimed'}
                  {nextItem.place && nextItem.title ? ` · ${nextItem.place.name}` : ''}
                </p>
                <div className={styles.actions}>
                  {toNext ? (
                    <a className={styles.secondary} href={toNext}>
                      <Icon name="route" aria-hidden /> Directions
                    </a>
                  ) : null}
                  <Button
                    onClick={() =>
                      openCheckIn({ mode: 'new', from: { tripId: id, itemId: nextItem.id } })
                    }
                  >
                    <Icon name="plus" aria-hidden /> Check in
                  </Button>
                </div>
              </>
            ) : (
              <p>That is everything for today.</p>
            )}
          </section>

          {today.days.map((view) => (
            <section
              key={view.day.id}
              className={styles.day}
              aria-label={`Items of ${view.day.date}`}
              data-day={view.day.id}
            >
              {today.days.length > 1 ? (
                <h3>{sets.stops.find((stop) => stop.id === view.day.stopId)?.place.name}</h3>
              ) : null}
              <ol className={styles.items}>
                {view.items.map((entry) => {
                  const byCheckin = model.doneByJournal.has(entry.item.id);
                  return (
                    <li
                      key={entry.item.id}
                      className={styles.item}
                      data-item={entry.item.id}
                      data-done={entry.done}
                    >
                      <span className={styles.mark} aria-hidden>
                        {entry.done ? '✓' : entry.item.fixed ? '●' : '○'}
                      </span>
                      <span className={styles.kind}>
                        <Icon
                          name={KIND_ICON[(entry.item.kind as keyof typeof KIND_ICON) ?? 'other']}
                          aria-hidden
                        />
                      </span>
                      <span className={styles.itemMain}>
                        <span className={entry.done ? styles.struck : styles.name}>
                          {nameOf(entry.item)}
                        </span>
                        <span className={styles.muted}>
                          {entry.item.start
                            ? `${entry.item.start}${entry.item.end ? `–${entry.item.end}` : ''}`
                            : 'any time'}
                          {entry.item.fixed ? ' · fixed' : ''}
                        </span>
                      </span>
                      {entry.item.fixed ? <Badge size="xs">Fixed</Badge> : null}
                      {byCheckin ? (
                        <span className={styles.muted}>Checked in</span>
                      ) : (
                        <Button
                          variant="ghost"
                          aria-pressed={entry.done}
                          aria-label={`${entry.done ? 'Not done' : 'Done'}: ${nameOf(entry.item)}`}
                          onClick={() => void toggle(entry)}
                        >
                          {entry.done ? 'Undo' : 'Done'}
                        </Button>
                      )}
                    </li>
                  );
                })}
              </ol>
            </section>
          ))}
        </>
      )}
    </div>
  );
}
