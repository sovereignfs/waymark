'use client';

import { type FormEvent, useMemo, useState } from 'react';
import {
  Badge,
  Button,
  Combobox,
  ConfirmDialog,
  Dialog,
  EmptyState,
  FormField,
  Input,
  useToast,
} from '@sovereignfs/ui';
import { deletePlace, mergePlaces, updatePlace } from '../actions/places';
import type { Context } from '../actions/types';
import { useLocal } from '../local/LocalProvider';
import { goTo } from './checkin-location';
import { checkinsAt, placeLine, visitsSentence } from './placelist';
import styles from './Timeline.module.css';
import { localDateOf, localTimeOf } from './timeline';
import { usePageLocation } from './useLocation';

/** What an action is given that it must not read for itself (`actions/types.ts`): ids, the time and the zone the device is in. */
const context = (): Context => ({
  ids: { newId: () => crypto.randomUUID() },
  now: Date.now(),
  deviceZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
});

const day = (checkin: Parameters<typeof localDateOf>[0]) =>
  new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', dateStyle: 'medium' }).format(
    new Date(`${localDateOf(checkin)}T12:00:00Z`),
  );

/**
 * A place's page (DESIGN.md §20.8): its name, category and address, **"You've been here 4 times"**, the first and last visit and its check-ins, newest first, and what a person can do to it: **rename it or change its
 * category** (the place sent again whole, as an edit of a check-in is), **merge it into another** of their places (its check-ins move, §4.1), and **delete it, only when no check-in is at it**. Every one is a change
 * recorded on the device and sent when there is a network, so all of it works offline. Moving its point and the small map wait for `Map` (17.1, in `sovereign`), and the trips it was part of for trips (9.7).
 */
export function PlaceDetail({ id }: { id: string }) {
  const local = useLocal();
  const toast = useToast();
  const loc = usePageLocation();
  const [editing, setEditing] = useState(false);
  const [merging, setMerging] = useState(false);
  const [asking, setAsking] = useState(false);
  const [name, setName] = useState('');
  const [category, setCategory] = useState('');
  const [into, setInto] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const carried = new URLSearchParams(loc.search).get('q');
  const search = carried ? `?${new URLSearchParams({ q: carried }).toString()}` : '';
  const back = `/places${search}`;

  const place = local?.places.find((each) => each.id === id);
  const here = useMemo(() => checkinsAt(local?.checkins ?? [], id), [local?.checkins, id]);
  const others = useMemo(
    () =>
      (local?.places ?? [])
        .filter((each) => each.id !== id)
        .map((each) => ({
          value: each.id,
          label: [each.name, placeLine(each)].filter(Boolean).join(' · '),
        })),
    [local?.places, id],
  );

  if (!local || !local.ready)
    return (
      <div className={styles.detail}>
        <p className={styles.when} role="status">
          Loading…
        </p>
      </div>
    );
  if (!place)
    return (
      <div className={styles.detail}>
        <EmptyState
          icon="search"
          heading="That place is not here"
          description="It may have been merged into another or deleted, or it is on another device that has not sent it yet."
          action={
            <Button type="button" variant="secondary" onClick={() => goTo(back)}>
              Back to your places
            </Button>
          }
        />
      </div>
    );

  const first = here[here.length - 1];
  const last = here[0];
  const line = placeLine(place);

  function startEdit() {
    setName(place?.name ?? '');
    setCategory(place?.category ?? '');
    setProblem(undefined);
    setEditing(true);
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    const made = updatePlace(place, { name, category }, context());
    if (!made.ok) return void setProblem(made.sentence);
    setEditing(false);
    await local?.record(made.mutation);
    toast.show({ title: 'Saved', category: 'success', duration: 3000 });
  }

  async function merge() {
    const target = local?.places.find((each) => each.id === into);
    const made = mergePlaces(place, target, local?.checkins ?? [], context());
    if (!made.ok) return void setProblem(made.sentence);
    setMerging(false);
    // In order, the delete last: the outbox sends them in the order they were recorded.
    for (const mutation of made.mutations) await local?.record(mutation);
    toast.show({
      title: `Merged: ${made.moved} ${made.moved === 1 ? 'check-in' : 'check-ins'} moved`,
      category: 'success',
      duration: 4000,
    });
    goTo(`/places/${target?.id}${search}`, 'replace');
  }

  async function remove() {
    const made = deletePlace(place, local?.checkins ?? [], context());
    setAsking(false);
    if (!made.ok) return void toast.show({ title: made.sentence, category: 'error' });
    await local?.record(made.mutation);
    toast.show({ title: 'Deleted', category: 'success', duration: 3000 });
    goTo(back, 'replace');
  }

  return (
    <article className={styles.detail} aria-label="Place">
      <Button
        type="button"
        variant="secondary"
        size="sm"
        className={styles.back}
        onClick={() => goTo(back)}
      >
        ← Places
      </Button>
      <h1>{place.name}</h1>
      {line ? <p className={styles.when}>{line}</p> : null}
      {place.address?.street ? <p className={styles.when}>{place.address.street}</p> : null}
      <p className={styles.when} aria-live="polite">
        <strong>{visitsSentence(here.length)}</strong>
        {first && last && here.length > 1
          ? `. First on ${day(first)}, last on ${day(last)}.`
          : first
            ? `, on ${day(first)}.`
            : '.'}
      </p>
      <div className={styles.actions}>
        <Button type="button" onClick={startEdit}>
          Edit
        </Button>
        <Button
          type="button"
          variant="secondary"
          disabled={others.length === 0}
          onClick={() => {
            setInto(null);
            setProblem(undefined);
            setMerging(true);
          }}
        >
          Merge into…
        </Button>
        <Button
          type="button"
          variant="secondary"
          disabled={here.length > 0}
          onClick={() => setAsking(true)}
        >
          Delete
        </Button>
      </div>
      {here.length > 0 ? (
        <p className={styles.when}>
          A place with check-ins is not deleted: merge it into another, or delete its check-ins
          first.
        </p>
      ) : null}
      {here.length > 0 ? (
        <section aria-label="Check-ins here">
          <h2>Check-ins here</h2>
          <ul className={styles.visitList}>
            {here.map((checkin) => {
              const href = `/c/${checkin.id}`;
              return (
                <li key={checkin.id}>
                  <a
                    href={href}
                    className={styles.visit}
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
                      goTo(href);
                    }}
                  >
                    <span>{day(checkin)}</span>
                    <span className={styles.when}>{localTimeOf(checkin)}</span>
                    {checkin.note ? (
                      <span className={styles.line}>{checkin.note.split('\n')[0]}</span>
                    ) : null}
                    {checkin.companions.length > 0 ? (
                      <Badge>{checkin.companions.length} with you</Badge>
                    ) : null}
                  </a>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      <Dialog open={editing} onClose={() => setEditing(false)} title="Edit this place" size="sm">
        <form onSubmit={(event) => void save(event)} className={styles.form}>
          <FormField label="Name">
            {(field) => (
              <Input
                {...field}
                name="name"
                value={name}
                autoComplete="off"
                onChange={(event) => setName(event.target.value)}
              />
            )}
          </FormField>
          <FormField label="Category" hint="Café, museum, home. Leave empty for none.">
            {(field) => (
              <Input
                {...field}
                name="category"
                value={category}
                autoComplete="off"
                onChange={(event) => setCategory(event.target.value)}
              />
            )}
          </FormField>
          {problem ? (
            <p role="alert" className={styles.problem}>
              {problem}
            </p>
          ) : null}
          <div className={styles.actions}>
            <Button type="submit">Save</Button>
            <Button type="button" variant="secondary" onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </div>
        </form>
      </Dialog>

      <Dialog
        open={merging}
        onClose={() => setMerging(false)}
        title="Merge into another place"
        size="sm"
      >
        <div className={styles.form}>
          <p className={styles.when}>
            Its {here.length === 1 ? 'check-in moves' : `${here.length} check-ins move`} to the
            place you choose, and this place is deleted. Their times and notes stay as they are.
          </p>
          <Combobox
            aria-label="The place to merge into"
            options={others}
            value={into}
            onChange={setInto}
            placeholder="Choose a place"
            searchPlaceholder="Search your places"
            emptyMessage="No place matches"
          />
          {problem ? (
            <p role="alert" className={styles.problem}>
              {problem}
            </p>
          ) : null}
          <div className={styles.actions}>
            <Button type="button" disabled={into === null} onClick={() => void merge()}>
              Merge
            </Button>
            <Button type="button" variant="secondary" onClick={() => setMerging(false)}>
              Cancel
            </Button>
          </div>
        </div>
      </Dialog>

      <ConfirmDialog
        open={asking}
        onClose={() => setAsking(false)}
        onConfirm={() => void remove()}
        title="Delete this place?"
        message="No check-in is at it. It is deleted for good."
        confirmLabel="Delete"
        cancelLabel="Keep it"
        destructive
      />
    </article>
  );
}
