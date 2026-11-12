'use client';

import Link from 'next/link';
import { useMemo } from 'react';
import { AvatarStack, Badge, Button, EmptyState, Icon, Input } from '@sovereignfs/ui';
import { NewTripDialog } from './NewTripDialog';
import styles from './Trips.module.css';
import {
  CHIPS,
  DOT,
  STATUS_LABEL,
  type TripCard,
  chipCounts,
  datesText,
  daysText,
  groupTrips,
  isChip,
} from './trips';
import { useTripCards } from './useTrips';
import { usePageLocation } from './useLocation';

/**
 * `/trips` (DESIGN.md §20.9): every trip the account is in, **drawn from the device** so that it opens with no network. Status chips and a search narrow it; the groups are in the order of the design, and each card has the one
 * action its status and the reader's role allow. The chip, the search and the open dialog are in the address (`?status=`, `?q=`, `?new=1`), as the timeline's filters are.
 */
function Card({ card }: { card: TripCard }) {
  return (
    <li className={styles.card} data-trip={card.id} data-status={card.status}>
      <div className={styles.title}>
        <span className={styles.dot} style={{ background: DOT[card.color] }} aria-hidden />
        <Link href={`/t/${card.id}`}>{card.name}</Link>
      </div>
      <p className={styles.meta}>
        {datesText(card.startDate, card.endDate)}
        {card.days !== null ? ` · ${daysText(card.days)}` : ''}
      </p>
      {card.stops.length > 0 ? <p className={styles.route}>{card.stops.join(' → ')}</p> : null}
      <div className={styles.foot}>
        <Badge>{STATUS_LABEL[card.status]}</Badge>
        {card.people.length > 1 ? (
          <AvatarStack people={card.people} max={4} size="sm" label="Members" />
        ) : null}
        <Link href={card.action.href} className={styles.action}>
          {card.action.label}
        </Link>
      </div>
    </li>
  );
}

export function TripsView() {
  const loc = usePageLocation();
  const { ready, cards } = useTripCards();
  const params = new URLSearchParams(loc.search);
  const chipParam = params.get('status');
  const chip = isChip(chipParam) ? chipParam : 'all';
  const q = params.get('q')?.slice(0, 200) ?? '';
  const creating = params.get('new') === '1';

  const counts = useMemo(() => chipCounts(cards), [cards]);
  const groups = useMemo(() => groupTrips(cards, chip, q), [cards, chip, q]);

  return (
    <div className={styles.page}>
      <div className={styles.head}>
        <h1>Trips</h1>
        <Button onClick={() => loc.setQuery({ new: '1' })}>
          <Icon name="plus" aria-hidden /> New trip
        </Button>
      </div>

      <div className={styles.tools}>
        <div className={styles.search}>
          <Input
            type="search"
            aria-label="Search trips"
            placeholder="Search trips and stops"
            value={q}
            onChange={(event) => loc.setQuery({ q: event.target.value || undefined })}
          />
        </div>
        <ul className={styles.chips} aria-label="Status">
          {CHIPS.map((each) => (
            <li key={each}>
              <button
                type="button"
                className={styles.chip}
                aria-pressed={chip === each}
                onClick={() => loc.setQuery({ status: each === 'all' ? undefined : each })}
              >
                {STATUS_LABEL[each]} <span className={styles.count}>{counts[each]}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>

      {!ready ? (
        <p role="status" className={styles.meta}>
          Loading your trips…
        </p>
      ) : cards.length === 0 ? (
        <EmptyState
          icon="luggage"
          heading="No trips yet"
          description="A trip is a folder for the places you plan to go, with the people going and the people following."
          action={
            <Button onClick={() => loc.setQuery({ new: '1' })}>
              <Icon name="plus" aria-hidden /> New trip
            </Button>
          }
        />
      ) : groups.length === 0 ? (
        <EmptyState
          icon="search"
          heading="No trip matches"
          description="Try another word, or another status."
        />
      ) : (
        groups.map((group) => (
          <section
            key={group.status}
            className={styles.group}
            aria-label={STATUS_LABEL[group.status]}
          >
            <h2>{STATUS_LABEL[group.status]}</h2>
            <ul className={styles.cards}>
              {group.trips.map((card) => (
                <Card key={card.id} card={card} />
              ))}
            </ul>
          </section>
        ))
      )}

      <NewTripDialog open={creating} onClose={() => loc.setQuery({ new: undefined })} />
    </div>
  );
}
