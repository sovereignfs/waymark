'use client';

import { type FormEvent, useEffect, useMemo, useState } from 'react';
import { Button, Checkbox, Dialog, FormField, Input, Select, Textarea } from '@sovereignfs/ui';
import { createItem, editItem, moveItem } from '../actions/items';
import { useLocal } from '../local/LocalProvider';
import type { TripData } from '../local/store';
import type { Candidate } from '../places/providers';
import type { ItemRecord } from '../sync/trip-format';
import { ITEM_KINDS, ITEM_NOTES_MAX, ITEM_TITLE_MAX, type ItemKind } from '../trips/item-format';
import { KIND_LABEL, dayChoices, tripPlaces } from './plan';
import { actionContext } from './planContext';
import { NO_CONNECTION, askOp } from './ops';
import styles from './Plan.module.css';
import { usePlaceSearch } from './usePlaceSearch';

/**
 * An item, made or changed (DESIGN.md §10.5, §20.10): a title or a place of the trip's (at least one), a kind, a start and an end time, fixed (which needs a start), notes and the day it is on. **Written through the one
 * path** (`createItem`, `editItem`, `moveItem` and `local.record`), so it shows at once, works with no network and is sent when there is one; the rules are the server's, run here first, and a refusal is a sentence
 * here. **A new place is the one online part** (`item.add`, `item.update`: the place is made on the server, §7.1), and the person's own choices of the trip's places need none.
 */
export function ItemDialog({
  open,
  onClose,
  tripId,
  data,
  dayId,
  item,
}: {
  open: boolean;
  onClose: () => void;
  tripId: string;
  data: TripData;
  /** The day a new item is made on (and the day an existing one starts on). */
  dayId: string;
  item?: ItemRecord | undefined;
}) {
  const local = useLocal();
  const sets = data.sets;
  const [title, setTitle] = useState('');
  const [kind, setKind] = useState<ItemKind>('activity');
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [fixed, setFixed] = useState(false);
  const [notes, setNotes] = useState('');
  const [day, setDay] = useState(dayId);
  const [placeId, setPlaceId] = useState('');
  const [found, setFound] = useState<Candidate | undefined>(undefined);
  const [where, setWhere] = useState('');
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const search = usePlaceSearch(found ? '' : where, undefined);

  // The form starts from the item each time it is opened.
  useEffect(() => {
    if (!open) return;
    setTitle(item?.title ?? '');
    setKind(item?.kind ?? 'activity');
    setStart(item?.start ?? '');
    setEnd(item?.end ?? '');
    setFixed(item?.fixed ?? false);
    setNotes(item?.notes ?? '');
    setDay(item?.dayId ?? dayId);
    setPlaceId(item?.place?.id ?? '');
    setFound(undefined);
    setWhere('');
    setProblem(undefined);
    setBusy(false);
  }, [open, item, dayId]);

  const days = useMemo(() => (sets ? dayChoices(sets.stops, data.days) : []), [sets, data.days]);
  const places = useMemo(
    () => (sets ? tripPlaces(sets.stops, data.items) : []),
    [sets, data.items],
  );
  if (!sets) return null;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || !local) return;
    setBusy(true);
    setProblem(undefined);
    const ctx = actionContext();
    const input = {
      title: title.trim() === '' ? undefined : title.trim(),
      notes: notes.trim() === '' ? undefined : notes.trim(),
      kind,
      start: start === '' ? null : start,
      end: end === '' ? null : end,
      fixed,
      placeId: placeId === '' ? null : placeId,
    };
    const there = data.items
      .filter((each) => each.dayId === day && each.id !== item?.id)
      .sort((a, b) => (a.position < b.position ? -1 : a.position > b.position ? 1 : 0));

    // A place that has to be made is made on the server, with the rest of the item.
    if (found) {
      const place = {
        name: found.name,
        lat: found.lat,
        lng: found.lng,
        address: found.address,
        category: found.category,
        source: found.source,
        sourceId: found.sourceId,
      };
      const fields = {
        title: input.title,
        notes: input.notes,
        kind: input.kind,
        start: input.start,
        end: input.end,
        fixed: input.fixed,
        place,
      };
      const answer = item
        ? await askOp({ op: 'item.update', tripId, itemId: item.id, ...fields })
        : await askOp({ op: 'item.add', tripId, dayId: day, ...fields });
      if (!answer) {
        setBusy(false);
        return setProblem(NO_CONNECTION);
      }
      if (!answer.ok) {
        setBusy(false);
        return setProblem(answer.sentence ?? 'That item could not be saved.');
      }
      if (item && day !== item.dayId)
        await askOp({ op: 'item.move', tripId, itemId: item.id, dayId: day, before: null });
      await local.syncNow();
      return onClose();
    }

    const made = item
      ? editItem(tripId, item, input, ctx)
      : createItem(tripId, day, input, there, null, ctx);
    if (!made.ok) {
      setBusy(false);
      return setProblem(made.sentence);
    }
    await local.record(made.mutation);
    // Another day: the edit is whole, and the move is its own change, in order.
    if (item && day !== item.dayId) {
      const moved = moveItem(
        tripId,
        { ...item, ...input, place: item.place },
        day,
        there,
        null,
        ctx,
      );
      if (!moved.ok) {
        setBusy(false);
        return setProblem(moved.sentence);
      }
      await local.record(moved.mutation);
    }
    onClose();
  };

  return (
    <Dialog open={open} onClose={onClose} title={item ? 'Edit the item' : 'Add an item'} size="md">
      <form onSubmit={(event) => void submit(event)} className={styles.form}>
        <FormField label="Title">
          {(field) => (
            <Input
              {...field}
              name="title"
              value={title}
              maxLength={ITEM_TITLE_MAX}
              autoComplete="off"
              onChange={(event) => setTitle(event.target.value)}
            />
          )}
        </FormField>

        {found ? (
          <div className={styles.chosen}>
            <span>
              Place: <strong>{found.name}</strong>
            </span>
            <Button type="button" variant="ghost" onClick={() => setFound(undefined)}>
              Change
            </Button>
          </div>
        ) : (
          <>
            <FormField label="Place" hint="One this trip has, or search for another.">
              {(field) => (
                <Select
                  {...field}
                  name="place"
                  value={placeId}
                  onChange={(event) => setPlaceId(event.target.value)}
                >
                  <option value="">No place</option>
                  {places.map((place) => (
                    <option key={place.id} value={place.id}>
                      {place.name}
                    </option>
                  ))}
                </Select>
              )}
            </FormField>
            <FormField label="Search for a place">
              {(field) => (
                <Input
                  {...field}
                  name="search"
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
                    <button type="button" onClick={() => setFound(each)}>
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
            ) : null}
          </>
        )}

        <div className={styles.row2}>
          <FormField label="Kind">
            {(field) => (
              <Select
                {...field}
                name="kind"
                value={kind}
                onChange={(event) => setKind(event.target.value as ItemKind)}
              >
                {ITEM_KINDS.map((each) => (
                  <option key={each} value={each}>
                    {KIND_LABEL[each]}
                  </option>
                ))}
              </Select>
            )}
          </FormField>
          <FormField label="Day">
            {(field) => (
              <Select
                {...field}
                name="day"
                value={day}
                onChange={(event) => setDay(event.target.value)}
              >
                {days.map((each) => (
                  <option key={each.id} value={each.id}>
                    {each.label}
                  </option>
                ))}
              </Select>
            )}
          </FormField>
        </div>

        <div className={styles.row2}>
          <FormField label="Start">
            {(field) => (
              <Input
                {...field}
                type="time"
                name="start"
                value={start}
                onChange={(event) => {
                  setStart(event.target.value);
                  // Fixed needs a time, and an end needs a start: taking the time away takes them with it.
                  if (event.target.value === '') {
                    setFixed(false);
                    setEnd('');
                  }
                }}
              />
            )}
          </FormField>
          <FormField label="End">
            {(field) => (
              <Input
                {...field}
                type="time"
                name="end"
                value={end}
                disabled={start === ''}
                onChange={(event) => setEnd(event.target.value)}
              />
            )}
          </FormField>
        </div>

        <Checkbox
          checked={fixed}
          disabled={start === ''}
          onChange={setFixed}
          label={
            start === '' ? 'Fixed (give it a start time first)' : 'Fixed: a commitment at this time'
          }
        />

        <FormField label="Notes">
          {(field) => (
            <Textarea
              {...field}
              name="notes"
              rows={3}
              maxLength={ITEM_NOTES_MAX}
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
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
            {item ? 'Save' : 'Add'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
