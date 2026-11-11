'use client';

import { useState } from 'react';
import { Badge, Button, ConfirmDialog, EmptyState, useToast } from '@sovereignfs/ui';
import { deleteCheckin } from '../actions/checkins';
import { useLocal } from '../local/LocalProvider';
import { goTo, openCheckIn } from './checkin-location';
import { PhotoImage } from './PhotoImage';
import styles from './Timeline.module.css';
import { carriedQuery, localDateOf, localTimeOf } from './timeline';
import { usePageLocation } from './useLocation';

/**
 * A check-in's page (DESIGN.md §9.4, §20.6): the place, the moment on the clock where it was made, the note, the photos, who was there, and **Edit** (the sheet, filled in) and **Delete** (asked about, and for good,
 * with its photos). Both work with no network: they are changes recorded on the device and sent when there is one. The trip link and sharing rows join with 9.7 and 10.3, and the place links to its page with 7.5.
 * The photo viewer is 17.6's: here the photos are shown as they are, from the device while they are only there.
 */
export function CheckinDetail({ id }: { id: string }) {
  const local = useLocal();
  const toast = useToast();
  const loc = usePageLocation();
  const [asking, setAsking] = useState(false);
  const back = `/checkins${carriedQuery(loc.search)}`;

  if (!local || !local.ready)
    return (
      <div className={styles.detail}>
        <p className={styles.when} role="status">
          Loading…
        </p>
      </div>
    );
  const checkin = local.checkins.find((each) => each.id === id);
  const place = checkin ? local.places.find((each) => each.id === checkin.placeId) : undefined;

  if (!checkin)
    return (
      <div className={styles.detail}>
        <EmptyState
          icon="search"
          heading="That check-in is not here"
          description="It may have been deleted, or it is on another device that has not sent it yet."
          action={
            <Button type="button" variant="secondary" onClick={() => goTo(back)}>
              Back to your check-ins
            </Button>
          }
        />
      </div>
    );

  const date = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', dateStyle: 'full' }).format(
    new Date(`${localDateOf(checkin)}T12:00:00Z`),
  );
  const photos = checkin.photos ?? [];

  async function remove() {
    if (!checkin) return;
    const made = deleteCheckin(checkin, {
      ids: { newId: () => crypto.randomUUID() },
      now: Date.now(),
      deviceZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    });
    setAsking(false);
    if (!made.ok) return void toast.show({ title: made.sentence, category: 'error' });
    await local?.record(made.mutation);
    toast.show({ title: 'Deleted', category: 'success', duration: 3000 });
    goTo(back, 'replace');
  }

  return (
    <article className={styles.detail} aria-label="Check-in">
      <Button
        type="button"
        variant="secondary"
        size="sm"
        className={styles.back}
        onClick={() => goTo(back)}
      >
        ← Check-ins
      </Button>
      <h1>
        {place ? (
          <a
            href={`/places/${place.id}`}
            className={styles.placeLink}
            onClick={(event) => {
              if (
                event.defaultPrevented ||
                event.button !== 0 ||
                event.metaKey ||
                event.ctrlKey ||
                event.shiftKey ||
                event.altKey
              )
                return;
              event.preventDefault();
              goTo(`/places/${place.id}`);
            }}
          >
            {place.name}
          </a>
        ) : (
          'A place'
        )}
      </h1>
      <p className={styles.when}>
        {date}, {localTimeOf(checkin)} ({checkin.tz})
      </p>
      {checkin.note ? <p className={styles.note}>{checkin.note}</p> : null}
      {photos.length > 0 ? (
        <ul className={styles.photos} aria-label="Photos">
          {photos.map((photo, index) => (
            <li key={photo}>
              <PhotoImage id={photo} alt={`Photo ${index + 1} of ${photos.length}`} />
            </li>
          ))}
        </ul>
      ) : null}
      {checkin.companions.length > 0 ? (
        <ul className={styles.chips} aria-label="With">
          {checkin.companions.map((name) => (
            <li key={name}>
              <Badge>{name}</Badge>
            </li>
          ))}
        </ul>
      ) : null}
      <div className={styles.actions}>
        <Button type="button" onClick={() => openCheckIn({ mode: 'edit', id: checkin.id })}>
          Edit
        </Button>
        <Button type="button" variant="secondary" onClick={() => setAsking(true)}>
          Delete
        </Button>
      </div>
      <ConfirmDialog
        open={asking}
        onClose={() => setAsking(false)}
        onConfirm={() => void remove()}
        title="Delete this check-in?"
        message="It is deleted for good, with its photos. There is no history and no way to get it back."
        confirmLabel="Delete"
        cancelLabel="Keep it"
        destructive
      />
    </article>
  );
}
