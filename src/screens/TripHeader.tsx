'use client';

import { useState } from 'react';
import { AvatarStack, Badge, Button, Icon, useToast } from '@sovereignfs/ui';
import { useLocal } from '../local/LocalProvider';
import type { TripData } from '../local/store';
import type { Role } from '../trips/format';
import { TripMenu } from './TripMenu';
import { NOT_DONE, NO_CONNECTION, askOp } from './ops';
import styles from './Trip.module.css';
import { DOT, STATUS_LABEL, type TripCard, datesText, daysText } from './trips';
import { ROLE_LABEL, headerActions } from './trip';

/**
 * A trip's header (DESIGN.md §20.10): the dot, the name, the dates and days, the status, the members' initials, **the reader's own role**, and what their role may do with the trip: an Organizer's _Mark ready_ or _Back to
 * planning_ and menu, and _Open Trip Mode_ when the trip is on and they are going. A Traveler or a Follower is offered none of an Organizer's. What is shown is `headerActions`'s, tested for each role; what is allowed is
 * the server's, whatever the page shows.
 */
export function TripHeader({ card, data }: { card: TripCard; data: TripData }) {
  const local = useLocal();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const sets = data.sets;
  if (!sets) return null;
  const actions = headerActions({
    role: data.role,
    status: card.status,
    going: sets.trip.going,
    readyAt: sets.trip.readyAt,
    hasDatedStop: sets.stops.some((stop) => stop.arrive !== null),
  });

  const ready = async (op: 'trip.ready' | 'trip.planning') => {
    setBusy(true);
    const answer = await askOp({ op, tripId: card.id });
    if (!answer) toast.show({ title: NO_CONNECTION, category: 'error' });
    else if (!answer.ok) toast.show({ title: NOT_DONE, category: 'error' });
    else await local?.syncNow();
    setBusy(false);
  };

  return (
    <header className={styles.header}>
      <div className={styles.titleRow}>
        <span className={styles.dot} style={{ background: DOT[card.color] }} aria-hidden />
        <h1 className={styles.name}>{card.name}</h1>
        <Badge>{STATUS_LABEL[card.status]}</Badge>
        <Badge variant="role" uppercase={false}>
          {ROLE_LABEL[data.role as Role] ?? data.role}
        </Badge>
      </div>
      <p className={styles.meta}>
        {datesText(card.startDate, card.endDate)}
        {card.days !== null ? ` · ${daysText(card.days)}` : ''}
        {card.datesPassed ? ' · the dates have passed' : ''}
      </p>
      <div className={styles.headRow}>
        {card.people.length > 0 ? (
          <AvatarStack people={card.people} max={5} size="sm" label="Members" />
        ) : null}
        <div className={styles.headActions}>
          {actions.tripMode ? (
            <a className={styles.primaryLink} href={`/t/${card.id}/today`}>
              <Icon name="route" aria-hidden /> Open Trip Mode
            </a>
          ) : null}
          {actions.markReady !== 'hidden' ? (
            <Button
              disabled={busy || actions.markReady === 'disabled'}
              onClick={() => void ready('trip.ready')}
              title={actions.markReady === 'disabled' ? 'Give a stop its dates first' : undefined}
            >
              Mark ready
            </Button>
          ) : null}
          {actions.backToPlanning ? (
            <Button variant="secondary" disabled={busy} onClick={() => void ready('trip.planning')}>
              Back to planning
            </Button>
          ) : null}
          {actions.menu ? <TripMenu tripId={card.id} name={card.name} color={card.color} /> : null}
        </div>
      </div>
    </header>
  );
}
