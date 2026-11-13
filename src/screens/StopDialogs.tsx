'use client';

import { type FormEvent, useEffect, useState } from 'react';
import {
  Button,
  ConfirmDialog,
  Dialog,
  DateRangePicker,
  FormField,
  Input,
  Select,
} from '@sovereignfs/ui';
import { useLocal } from '../local/LocalProvider';
import type { TripData } from '../local/store';
import type { Candidate } from '../places/providers';
import type { StopRecord } from '../sync/trip-format';
import { NO_CONNECTION, NOT_DONE, type OpAnswer, askOp } from './ops';
import { dayChoices } from './plan';
import styles from './Plan.module.css';
import { usePlaceSearch } from './usePlaceSearch';

/** Runs an operation on the trip and pulls the answer into the device. Says what happened in a sentence when it did not. */
async function run(
  local: ReturnType<typeof useLocal>,
  body: Record<string, unknown>,
): Promise<{ ok: true } | { ok: false; answer: OpAnswer | undefined; sentence: string }> {
  const answer = await askOp(body);
  if (!answer) return { ok: false, answer, sentence: NO_CONNECTION };
  if (!answer.ok) return { ok: false, answer, sentence: answer.sentence ?? NOT_DONE };
  await local?.syncNow();
  return { ok: true };
}

/** _Add a stop_ (DESIGN.md §10.3): a place through the place search, and dates if they are known. A stop may have none yet. */
export function AddStopDialog({
  open,
  onClose,
  tripId,
  onAdded,
}: {
  open: boolean;
  onClose: () => void;
  tripId: string;
  onAdded?: () => void;
}) {
  const local = useLocal();
  const [where, setWhere] = useState('');
  const [place, setPlace] = useState<Candidate | undefined>(undefined);
  const [range, setRange] = useState<{ start: string | null; end: string | null }>({
    start: null,
    end: null,
  });
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const search = usePlaceSearch(place ? '' : where, undefined);

  useEffect(() => {
    if (!open) return;
    setWhere('');
    setPlace(undefined);
    setRange({ start: null, end: null });
    setProblem(undefined);
    setBusy(false);
  }, [open]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    if (!place) return setProblem('Search for the stop’s place and choose it.');
    setBusy(true);
    setProblem(undefined);
    const done = await run(local, {
      op: 'stop.add',
      tripId,
      place: {
        name: place.name,
        lat: place.lat,
        lng: place.lng,
        address: place.address,
        category: place.category,
        source: place.source,
        sourceId: place.sourceId,
      },
      ...(range.start && range.end ? { arrive: range.start, depart: range.end } : {}),
    });
    if (!done.ok) {
      setBusy(false);
      return setProblem(done.sentence);
    }
    onAdded?.();
    onClose();
  };

  return (
    <Dialog open={open} onClose={onClose} title="Add a stop" size="sm">
      <form onSubmit={(event) => void submit(event)} className={styles.form}>
        {place ? (
          <div className={styles.chosen}>
            <span>
              Place: <strong>{place.name}</strong>
            </span>
            <Button type="button" variant="ghost" onClick={() => setPlace(undefined)}>
              Change
            </Button>
          </div>
        ) : (
          <>
            <FormField label="Place" hint="Search for where the stop is.">
              {(field) => (
                <Input
                  {...field}
                  name="stop"
                  value={where}
                  autoComplete="off"
                  onChange={(event) => setWhere(event.target.value)}
                />
              )}
            </FormField>
            {search.found.length > 0 ? (
              <ul className={styles.found} aria-label="Places found">
                {search.found.map((each) => (
                  <li key={each.sourceId}>
                    <button type="button" onClick={() => setPlace(each)}>
                      {each.name}
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
            {search.status === 'offline' ? (
              <p className={styles.hint}>Searching for a place needs a connection.</p>
            ) : search.status === 'unavailable' ? (
              <p className={styles.hint}>Place search is not answering now.</p>
            ) : search.status === 'off' ? (
              <p className={styles.hint}>Place search is not set up on this server.</p>
            ) : null}
          </>
        )}
        <FormField
          label="Dates"
          hint="Optional. A stop with no dates comes after those that have them."
        >
          {() => (
            <DateRangePicker
              aria-label="Arrival and departure"
              value={range}
              onChange={(next) => setRange(next)}
              placeholder="Choose arrival and departure"
            />
          )}
        </FormField>
        {problem ? (
          <p role="alert" className={styles.problem}>
            {problem}
          </p>
        ) : null}
        <div className={styles.actions}>
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={busy}>
            Add the stop
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/**
 * A stop's dates (DESIGN.md §10.3, §10.4). **Shrinking a stop over a day that has items is never silent**: the server refuses, naming the days, and this offers to move their items to another day of the trip or delete them,
 * then tries again. Every other change just happens.
 */
export function DatesDialog({
  open,
  onClose,
  tripId,
  stop,
  data,
}: {
  open: boolean;
  onClose: () => void;
  tripId: string;
  stop: StopRecord;
  data: TripData;
}) {
  const local = useLocal();
  const [range, setRange] = useState<{ start: string | null; end: string | null }>({
    start: stop.arrive,
    end: stop.depart,
  });
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | undefined>(undefined);
  /** The days that have items and would go, when the server says so. */
  const [over, setOver] = useState<readonly string[] | undefined>(undefined);
  const [target, setTarget] = useState('');

  useEffect(() => {
    if (!open) return;
    setRange({ start: stop.arrive, end: stop.depart });
    setProblem(undefined);
    setOver(undefined);
    setBusy(false);
  }, [open, stop.arrive, stop.depart, stop.id]);

  const sets = data.sets;
  if (!sets) return null;
  const change = (clear: boolean) =>
    clear
      ? { op: 'stop.update', tripId, stopId: stop.id, arrive: null, depart: null }
      : { op: 'stop.update', tripId, stopId: stop.id, arrive: range.start, depart: range.end };
  const clearing = range.start === null && range.end === null;

  const save = async () => {
    setBusy(true);
    setProblem(undefined);
    const done = await run(local, change(clearing));
    if (done.ok) return onClose();
    setBusy(false);
    if (done.answer?.reason === 'items') {
      // The server names the dates; the days are this stop's on those dates.
      const dates = new Set(done.answer.days ?? []);
      return setOver(
        data.days
          .filter((day) => day.stopId === stop.id && dates.has(day.date))
          .map((day) => day.id),
      );
    }
    setProblem(done.sentence);
  };

  /** Moves or deletes the items of the days that would go, then tries again. */
  const resolve = async (how: 'move' | 'delete') => {
    if (!over) return;
    setBusy(true);
    setProblem(undefined);
    for (const dayId of over) {
      const step = await run(
        local,
        how === 'move'
          ? { op: 'day.moveItems', tripId, fromDayId: dayId, toDayId: target }
          : { op: 'day.clearItems', tripId, dayId },
      );
      if (!step.ok) {
        setBusy(false);
        return setProblem(step.sentence);
      }
    }
    setOver(undefined);
    const done = await run(local, change(clearing));
    if (done.ok) return onClose();
    setBusy(false);
    setProblem(done.sentence);
  };

  const candidates = dayChoices(sets.stops, data.days).filter((each) => !over?.includes(each.id));
  const goes = over
    ? dayChoices(sets.stops, data.days).filter((each) => over.includes(each.id))
    : [];

  return (
    <Dialog open={open} onClose={onClose} title={`Dates for ${stop.place.name}`} size="sm">
      {over ? (
        <div className={styles.form}>
          <p>
            These days would go, and they have items on them:{' '}
            {goes.map((each) => each.label).join('; ')}.
          </p>
          <FormField label="Move their items to">
            {(field) => (
              <Select
                {...field}
                name="target"
                value={target}
                onChange={(event) => setTarget(event.target.value)}
              >
                <option value="">Choose a day</option>
                {candidates.map((each) => (
                  <option key={each.id} value={each.id}>
                    {each.label}
                  </option>
                ))}
              </Select>
            )}
          </FormField>
          {problem ? (
            <p role="alert" className={styles.problem}>
              {problem}
            </p>
          ) : null}
          <div className={styles.actions}>
            <Button type="button" variant="secondary" onClick={() => setOver(undefined)}>
              Back
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={busy}
              onClick={() => void resolve('delete')}
            >
              Delete the items
            </Button>
            <Button
              type="button"
              disabled={busy || target === ''}
              onClick={() => void resolve('move')}
            >
              Move the items
            </Button>
          </div>
        </div>
      ) : (
        <div className={styles.form}>
          <FormField label="Arrival and departure">
            {() => (
              <DateRangePicker
                aria-label="Arrival and departure"
                value={range}
                onChange={(next) => setRange(next)}
                placeholder="Choose arrival and departure"
              />
            )}
          </FormField>
          <Button
            type="button"
            variant="ghost"
            disabled={clearing}
            onClick={() => setRange({ start: null, end: null })}
          >
            Take the dates away
          </Button>
          {problem ? (
            <p role="alert" className={styles.problem}>
              {problem}
            </p>
          ) : null}
          <div className={styles.actions}>
            <Button type="button" variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button
              type="button"
              disabled={busy || (range.start === null) !== (range.end === null)}
              onClick={() => void save()}
            >
              Save
            </Button>
          </div>
        </div>
      )}
    </Dialog>
  );
}

/** Removing a stop (DESIGN.md §10.3): its days and their items go with it, so it asks first. */
export function RemoveStopDialog({
  open,
  onClose,
  tripId,
  stop,
  data,
  onRemoved,
}: {
  open: boolean;
  onClose: () => void;
  tripId: string;
  stop: StopRecord;
  data: TripData;
  onRemoved: () => void;
}) {
  const local = useLocal();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const days = data.days.filter((day) => day.stopId === stop.id);
  const items = data.items.filter((item) => days.some((day) => day.id === item.dayId)).length;
  return (
    <ConfirmDialog
      open={open}
      onClose={onClose}
      title="Remove this stop?"
      destructive
      confirmLabel={busy ? 'Removing…' : 'Remove the stop'}
      pending={busy}
      error={problem}
      message={
        <>
          <strong>{stop.place.name}</strong> will be removed from the trip
          {days.length > 0
            ? `, with its ${days.length === 1 ? 'day' : `${days.length} days`}${items > 0 ? ` and the ${items === 1 ? 'item' : `${items} items`} on them` : ''}`
            : ''}
          . This cannot be undone.
        </>
      }
      onConfirm={() => {
        setBusy(true);
        setProblem(undefined);
        void run(local, { op: 'stop.remove', tripId, stopId: stop.id }).then((done) => {
          setBusy(false);
          if (done.ok) {
            onRemoved();
            onClose();
          } else setProblem(done.sentence);
        });
      }}
    />
  );
}
