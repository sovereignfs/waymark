'use client';

import { useMemo } from 'react';
import { Avatar, Badge, EmptyState, Icon } from '@sovereignfs/ui';
import { type JournalCheckin, type JournalEntry, journalOfTrip, sentenceOf } from '../journal';
import { useLocal } from '../local/LocalProvider';
import type { TripData } from '../local/store';
import { PhotoImage } from './PhotoImage';
import type { ItemKind } from '../trips/item-format';
import { KIND_ICON } from './plan';
import styles from './Journal.module.css';

const dateText = (date: string) =>
  new Intl.DateTimeFormat('en-GB', {
    timeZone: 'UTC',
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  }).format(new Date(`${date}T12:00:00Z`));

const timeOf = (checkin: JournalCheckin): string =>
  new Date(checkin.at + checkin.offsetMin * 60_000).toISOString().slice(11, 16);

const STATUS: Record<
  'done' | 'skipped' | 'planned',
  { label: string; status: 'active' | 'failed' | 'neutral' }
> = {
  done: { label: 'Done', status: 'active' },
  skipped: { label: 'Skipped', status: 'failed' },
  planned: { label: 'Planned', status: 'neutral' },
};

/** The check-ins an entry is made of, with their photos. */
function Checkins({ checkins }: { checkins: readonly JournalCheckin[] }) {
  return (
    <ul className={styles.checkins}>
      {checkins.map((checkin) => (
        <li key={checkin.id}>
          <span className={styles.muted}>
            {timeOf(checkin)}
            {checkin.note ? ` · ${checkin.note}` : ''}
          </span>
          {/* The reader's own photos, and those of check-ins shared with the trip, which `/api/media` serves to its members (§11.3). */}
          {checkin.photos.length > 0 ? (
            <span className={styles.photos}>
              {checkin.photos.map((id) => (
                <span key={id} className={styles.photo}>
                  <PhotoImage id={id} thumb alt="Photo" />
                </span>
              ))}
            </span>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function Entry({ entry }: { entry: JournalEntry }) {
  if (entry.kind === 'found')
    return (
      <li className={`${styles.entry} ${styles.found}`} data-entry="found">
        <span className={styles.icon}>
          <Icon name="map-pin" aria-hidden />
        </span>
        <div className={styles.entryMain}>
          <div className={styles.entryTitle}>
            <strong>{entry.checkin.place.name}</strong>
            <Badge size="xs" variant="status" status="pending">
              Found on the way
            </Badge>
          </div>
          <Checkins checkins={[entry.checkin]} />
          <span className={styles.who}>
            <Avatar name={entry.by.name} size="sm" /> {entry.by.name}
          </span>
        </div>
      </li>
    );
  const { item } = entry;
  const name = item.title?.trim() || item.place?.name || 'Something planned';
  const state = STATUS[entry.status];
  return (
    <li className={styles.entry} data-entry={entry.status} data-item={item.id}>
      <span className={styles.icon}>
        <Icon name={KIND_ICON[(item.kind as ItemKind | undefined) ?? 'other']} aria-hidden />
      </span>
      <div className={styles.entryMain}>
        <div className={styles.entryTitle}>
          <strong>{name}</strong>
          {item.start ? <span className={styles.muted}>{item.start}</span> : null}
          <Badge size="xs" variant="status" status={state.status}>
            {state.label}
          </Badge>
        </div>
        {item.title && item.place ? <span className={styles.muted}>{item.place.name}</span> : null}
        {entry.checkins.length > 0 ? <Checkins checkins={entry.checkins} /> : null}
        {entry.by.length > 0 ? (
          <span className={styles.who}>
            {entry.by.map((who) => (
              <span key={who.accountId} className={styles.person}>
                <Avatar name={who.name} size="sm" /> {who.name}
              </span>
            ))}
          </span>
        ) : null}
      </div>
    </li>
  );
}

/**
 * The Journal (DESIGN.md §13, §20.10): **each day, the plan beside what happened**, from the first day to today (or to the last day). A day reads as a sentence, "5 planned, 3 done, 1 skipped, 2 found on the way", and then a
 * list in time order: each item as done, skipped or planned with who checked in there, and each check-in that matched nothing as found on the way. It is made on the device by `src/journal/` from the trip's rows, the reader's own
 * check-ins linked to the trip and the copies others shared with it, so what is seen is only what the reader is given and it opens with no network.
 */
export function JournalView({ data, now }: { data: TripData; now: number }) {
  const local = useLocal();
  const journal = useMemo(
    () =>
      local
        ? journalOfTrip(
            data,
            data.sets?.trip.id ?? '',
            local.checkins,
            local.places,
            local.accountId,
            now,
            Intl.DateTimeFormat().resolvedOptions().timeZone,
          )
        : undefined,
    [local, data, now],
  );
  if (!local || !journal) return null;
  if (journal.days.length === 0)
    return (
      <EmptyState
        icon="calendar-days"
        heading="Nothing to look back on yet"
        description={
          data.sets?.days.length
            ? 'The journal starts on the trip’s first day.'
            : 'Give the trip’s stops dates, and its days are here to look back on.'
        }
      />
    );
  return (
    <div className={styles.journal}>
      {journal.days.map((day) => (
        <section
          key={day.date}
          className={styles.day}
          aria-label={dateText(day.date)}
          data-date={day.date}
        >
          <header>
            <h2>
              {dateText(day.date)}
              {day.title ? <span className={styles.muted}> · {day.title}</span> : null}
            </h2>
            <p className={styles.muted}>{day.stops.join(' → ')}</p>
            <p className={styles.sentence} data-sentence>
              {sentenceOf(day.counts)}
            </p>
          </header>
          {day.entries.length === 0 ? (
            <p className={styles.muted}>Nothing was planned, and nothing was found.</p>
          ) : (
            <ol className={styles.entries}>
              {day.entries.map((entry) => (
                <Entry
                  key={entry.kind === 'found' ? `f${entry.checkin.id}` : `i${entry.item.id}`}
                  entry={entry}
                />
              ))}
            </ol>
          )}
        </section>
      ))}
    </div>
  );
}
