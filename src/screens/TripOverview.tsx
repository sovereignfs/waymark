'use client';

import { useMemo, useState } from 'react';
import { Select, StepStrip, useToast } from '@sovereignfs/ui';
import { journalOfTrip } from '../journal';
import { useLocal } from '../local/LocalProvider';
import type { TripData } from '../local/store';
import type { ShareChoice } from '../sharing/rules';
import { SHARE_CHOICES } from '../sharing/rules';
import { NOT_DONE, NO_CONNECTION, askOp } from './ops';
import styles from './Trip.module.css';
import { type NextThing, SHARE_LABEL, overviewOf, sharesChoice } from './trip';
import { datesText, daysText } from './trips';

const dateText = (date: string) =>
  new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', dateStyle: 'medium' }).format(
    new Date(`${date}T12:00:00Z`),
  );

const inText = (minutes: number): string =>
  minutes < 60
    ? `in ${minutes} min`
    : minutes < 24 * 60
      ? `in ${Math.floor(minutes / 60)} h${minutes % 60 ? ` ${minutes % 60} min` : ''}`
      : `on ${dateText(new Date(Date.now() + minutes * 60_000).toISOString().slice(0, 10))}`;

/** The one line for the next thing (the Overview and Trip Mode agree: both are `src/today/`'s). */
function nextSentence(next: NextThing): string {
  switch (next.kind) {
    case 'item':
      return next.timed && next.inMinutes !== null
        ? `${next.title}, ${inText(next.inMinutes)}`
        : `${next.title}, on ${dateText(next.dayDate)}`;
    case 'starts':
      return `The trip starts on ${dateText(next.date)}.`;
    case 'ended':
      return `The trip ended on ${dateText(next.date)}.`;
    case 'nothing':
      return 'Nothing is left on the plan for today.';
    case 'undated':
      return 'Give a stop its dates, and the trip has a first day.';
  }
}

/**
 * The Overview (DESIGN.md §20.10): the stops in order with their dates (`StepStrip`), the trip's figures, the next thing for the reader, the links with Tally's first, and for a Traveler their choice about sharing check-ins
 * with the trip. Everything but the sharing choice reads the device. **The stops are not yet on a map:** the map waits for the app's own (7.4, 11.4), and the list of the same is here.
 */
export function TripOverview({ data, now }: { data: TripData; now: number }) {
  const local = useLocal();
  const toast = useToast();
  const sets = data.sets;
  const overview = useMemo(() => {
    if (!sets || !local) return undefined;
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const journal = journalOfTrip(
      data,
      sets.trip.id,
      local.checkins,
      local.places,
      local.accountId,
      now,
      zone,
    );
    return journal
      ? overviewOf(
          { sets, items: data.items, days: data.days, done: data.done, journal },
          now,
          zone,
        )
      : undefined;
  }, [sets, local, data, now]);
  const [saving, setSaving] = useState(false);
  if (!sets || !overview) return null;
  const me = sets.members.find((member) => member.self);
  const choice: ShareChoice = me?.share ?? 'ask';

  const choose = async (next: string) => {
    setSaving(true);
    const answer = await askOp({ op: 'member.share', tripId: sets.trip.id, choice: next });
    if (!answer) toast.show({ title: NO_CONNECTION, category: 'error' });
    else if (!answer.ok) toast.show({ title: NOT_DONE, category: 'error' });
    else await local?.syncNow();
    setSaving(false);
  };

  const { figures } = overview;
  return (
    <div className={styles.overview}>
      <section aria-label="Stops" className={styles.section}>
        <h2>Stops</h2>
        {overview.stops.length === 0 ? (
          <p className={styles.muted}>No stops yet. The plan is where they are added.</p>
        ) : (
          <>
            <StepStrip
              aria-label="The stops in order"
              items={overview.stops.map((stop) => ({ id: stop.id }))}
              activeId={null}
              renderItem={(item, state) => {
                const stop = overview.stops.find((each) => each.id === item.id);
                return (
                  <span className={styles.step}>
                    <span className={styles.stepIndex}>{state.index + 1}</span>
                    <span>{stop?.name}</span>
                  </span>
                );
              }}
            />
            <ol className={styles.stops}>
              {overview.stops.map((stop) => (
                <li key={stop.id}>
                  <strong>{stop.name}</strong>
                  <span className={styles.muted}>
                    {datesText(stop.arrive, stop.depart)}
                    {stop.days !== null ? ` · ${daysText(stop.days)}` : ''}
                  </span>
                </li>
              ))}
            </ol>
          </>
        )}
      </section>

      <section aria-label="Figures" className={styles.section}>
        <h2>In figures</h2>
        <dl className={styles.figures}>
          <div>
            <dt>Days</dt>
            <dd>{figures.days ?? '–'}</dd>
          </div>
          <div>
            <dt>Stops</dt>
            <dd>{figures.stops}</dd>
          </div>
          <div>
            <dt>Places planned</dt>
            <dd>{figures.places}</dd>
          </div>
          <div>
            <dt>Places visited</dt>
            <dd>{figures.visited}</dd>
          </div>
          <div>
            <dt>Check-ins</dt>
            <dd>{figures.checkins}</dd>
          </div>
        </dl>
      </section>

      <section aria-label="Next" className={styles.section}>
        <h2>Next</h2>
        <p>{nextSentence(overview.next)}</p>
      </section>

      <section aria-label="Links" className={styles.section}>
        <h2>Links</h2>
        {overview.links.length === 0 ? (
          <p className={styles.muted}>No links yet.</p>
        ) : (
          <ul className={styles.links}>
            {overview.links.map((link) => (
              <li key={link.id}>
                <a href={link.url} target="_blank" rel="noopener noreferrer">
                  {link.title}
                </a>
                {link.kind === 'tally' ? <span className={styles.muted}> · Tally</span> : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      {sharesChoice(data.role) ? (
        <section aria-label="Sharing" className={styles.section}>
          <h2>Your check-ins on this trip</h2>
          <label className={styles.choice}>
            <span>Share them with the trip&rsquo;s members?</span>
            <Select
              name="share"
              value={choice}
              disabled={saving}
              onChange={(event) => void choose(event.target.value)}
            >
              {SHARE_CHOICES.map((each) => (
                <option key={each} value={each}>
                  {SHARE_LABEL[each]}
                </option>
              ))}
            </Select>
          </label>
          <p className={styles.muted}>
            Only you can change this. Followers see what is shared and share none of their own.
          </p>
        </section>
      ) : null}
    </div>
  );
}
