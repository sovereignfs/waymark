'use client';

import { DndContext, type DragEndEvent, closestCorners, useDroppable } from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { type FormEvent, useMemo, useState } from 'react';
import {
  Badge,
  Button,
  Dialog,
  EmptyState,
  FormField,
  GripIcon,
  Icon,
  Input,
  StepStrip,
  Textarea,
  useReorderSensors,
} from '@sovereignfs/ui';
import { deleteItem, editDay, moveItem } from '../actions/items';
import { useLocal } from '../local/LocalProvider';
import type { TripData } from '../local/store';
import type { DayRecord, ItemRecord, StopRecord } from '../sync/trip-format';
import { AddStopDialog, DatesDialog, RemoveStopDialog } from './StopDialogs';
import { ItemDialog } from './ItemDialog';
import { NO_CONNECTION, NOT_DONE, askOp } from './ops';
import {
  KIND_ICON,
  KIND_LABEL,
  dayDropId,
  daysOfStop,
  dropOf,
  nudgeOf,
  selectedStop,
  stopsInOrder,
  type PlanDay,
} from './plan';
import { actionContext } from './planContext';
import styles from './Plan.module.css';
import { isEditor } from './trip';
import { datesText } from './trips';
import { usePageLocation } from './useLocation';

const dateText = (date: string) =>
  new Intl.DateTimeFormat('en-GB', {
    timeZone: 'UTC',
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  }).format(new Date(`${date}T12:00:00Z`));

/** One item of a day: its kind, time, title or place, whether it is fixed and not yet sent, and (for someone who can edit) a handle to drag it by and the buttons that do the same without a pointer. */
function ItemRow({
  item,
  pending,
  editable,
  first,
  last,
  onEdit,
  onNudge,
  onDelete,
}: {
  item: ItemRecord;
  pending: boolean;
  editable: boolean;
  first: boolean;
  last: boolean;
  onEdit: () => void;
  onNudge: (direction: 'up' | 'down') => void;
  onDelete: () => void;
}) {
  const sortable = useSortable({ id: item.id, disabled: !editable });
  const { transform } = sortable;
  const style = {
    transform: transform ? `translate3d(${transform.x}px, ${transform.y}px, 0)` : undefined,
    transition: sortable.transition,
  };
  const name = item.title?.trim() || item.place?.name || 'Something planned';
  return (
    <li
      ref={sortable.setNodeRef}
      style={style}
      className={`${styles.item} ${sortable.isDragging ? styles.dragging : ''}`}
      data-item={item.id}
    >
      {editable ? (
        <button
          type="button"
          className={styles.handle}
          aria-label={`Drag ${name}`}
          {...sortable.attributes}
          {...sortable.listeners}
        >
          <GripIcon size={16} />
        </button>
      ) : null}
      <span className={styles.kind} title={KIND_LABEL[item.kind]}>
        <Icon name={KIND_ICON[item.kind]} aria-hidden />
        <span className={styles.srOnly}>{KIND_LABEL[item.kind]}</span>
      </span>
      <span className={styles.itemMain}>
        <span className={styles.itemTitle}>{name}</span>
        {item.title && item.place ? <span className={styles.muted}>{item.place.name}</span> : null}
      </span>
      {item.start ? (
        <span className={styles.time}>
          {item.start}
          {item.end ? `–${item.end}` : ''}
        </span>
      ) : null}
      {item.fixed ? <Badge size="xs">Fixed</Badge> : null}
      {pending ? (
        <span role="img" aria-label="Not sent yet" title="Not sent yet" className={styles.clock}>
          <Icon name="clock" aria-hidden />
        </span>
      ) : null}
      {editable ? (
        <span className={styles.itemActions}>
          <Button
            variant="ghost"
            aria-label={`Move ${name} up`}
            disabled={first}
            onClick={() => onNudge('up')}
          >
            <Icon name="chevron-up" aria-hidden />
          </Button>
          <Button
            variant="ghost"
            aria-label={`Move ${name} down`}
            disabled={last}
            onClick={() => onNudge('down')}
          >
            <Icon name="chevron-down" aria-hidden />
          </Button>
          <Button variant="ghost" aria-label={`Edit ${name}`} onClick={onEdit}>
            <Icon name="pencil" aria-hidden />
          </Button>
          <Button variant="ghost" aria-label={`Delete ${name}`} onClick={onDelete}>
            <Icon name="trash-2" aria-hidden />
          </Button>
        </span>
      ) : null}
    </li>
  );
}

/** A day: its date and title, its notes, its items in a list that is also a place to drop one (an empty day included), and _Add_ at the foot. */
function DayColumn({
  plan,
  index,
  data,
  editable,
  onAdd,
  onEditItem,
  onNudge,
  onDelete,
  onWords,
}: {
  plan: PlanDay;
  index: number;
  data: TripData;
  editable: boolean;
  onAdd: () => void;
  onEditItem: (item: ItemRecord) => void;
  onNudge: (itemId: string, direction: 'up' | 'down') => void;
  onDelete: (item: ItemRecord) => void;
  onWords: () => void;
}) {
  const drop = useDroppable({ id: dayDropId(plan.day.id), disabled: !editable });
  return (
    <section
      className={styles.day}
      aria-label={`Day ${index + 1}, ${dateText(plan.day.date)}`}
      data-day={plan.day.id}
    >
      <header className={styles.dayHead}>
        <div>
          <h3>
            {dateText(plan.day.date)}
            {plan.day.title ? <span className={styles.dayTitle}> · {plan.day.title}</span> : null}
          </h3>
          {plan.day.notes ? <p className={styles.muted}>{plan.day.notes}</p> : null}
        </div>
        {editable ? (
          <Button
            variant="ghost"
            aria-label={`Edit the words of ${dateText(plan.day.date)}`}
            onClick={onWords}
          >
            <Icon name="pencil" aria-hidden />
          </Button>
        ) : null}
      </header>
      <SortableContext
        items={plan.items.map((item) => item.id)}
        strategy={verticalListSortingStrategy}
      >
        <ul
          ref={drop.setNodeRef}
          className={`${styles.items} ${drop.isOver ? styles.over : ''}`}
          aria-label={`Items of ${dateText(plan.day.date)}`}
        >
          {plan.items.map((item, at) => (
            <ItemRow
              key={item.id}
              item={item}
              pending={data.pending.has(item.id)}
              editable={editable}
              first={at === 0}
              last={at === plan.items.length - 1}
              onEdit={() => onEditItem(item)}
              onNudge={(direction) => onNudge(item.id, direction)}
              onDelete={() => onDelete(item)}
            />
          ))}
        </ul>
      </SortableContext>
      {plan.items.length === 0 ? <p className={styles.muted}>Nothing planned yet.</p> : null}
      {editable ? (
        <Button variant="secondary" onClick={onAdd}>
          <Icon name="plus" aria-hidden /> Add an item
        </Button>
      ) : null}
    </section>
  );
}

/** A day's title and notes (DESIGN.md §10.4), written through the one path like an item. */
function WordsDialog({
  day,
  tripId,
  onClose,
}: {
  day: DayRecord | undefined;
  tripId: string;
  onClose: () => void;
}) {
  const local = useLocal();
  const [title, setTitle] = useState(day?.title ?? '');
  const [notes, setNotes] = useState(day?.notes ?? '');
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const [seen, setSeen] = useState(day?.id);
  if (day?.id !== seen) {
    setSeen(day?.id);
    setTitle(day?.title ?? '');
    setNotes(day?.notes ?? '');
    setProblem(undefined);
  }
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!day || !local) return;
    const made = editDay(
      tripId,
      day,
      { title: title.trim() || undefined, notes: notes.trim() || undefined },
      actionContext(),
    );
    if (!made.ok) return setProblem(made.sentence);
    await local.record(made.mutation);
    onClose();
  };
  return (
    <Dialog open={Boolean(day)} onClose={onClose} title="The day’s words" size="sm">
      <form className={styles.form} onSubmit={(event) => void submit(event)}>
        <FormField label="Title">
          {(field) => (
            <Input
              {...field}
              name="title"
              value={title}
              maxLength={120}
              autoComplete="off"
              onChange={(event) => setTitle(event.target.value)}
            />
          )}
        </FormField>
        <FormField label="Notes">
          {(field) => (
            <Textarea
              {...field}
              name="notes"
              rows={4}
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
          <Button type="submit">Save</Button>
        </div>
      </form>
    </Dialog>
  );
}

/**
 * The Plan (DESIGN.md §20.10): **the stops across the top, the selected stop's days below.** An Organizer or Traveler can add, re-date, move and remove stops (online: the server decides, §15.7), and add, change, move,
 * reorder and delete items and the words of a day (offline: through the one write path, shown at once, with a clock until the server has them). Items are dragged by their handle within a day and to another; the same moves are
 * buttons and a Day field, so nothing needs a pointer. A Follower sees the same, and has none of the controls.
 */
export function PlanView({ tripId, data }: { tripId: string; data: TripData }) {
  const local = useLocal();
  const loc = usePageLocation();
  const sensors = useReorderSensors();
  const sets = data.sets;
  const editable = isEditor(data.role);
  const asked = new URLSearchParams(loc.search).get('stop');
  const stop = sets ? selectedStop(sets.stops, asked) : undefined;
  const plan = useMemo(
    () => (stop ? daysOfStop(data.days, data.items, stop.id) : []),
    [stop, data.days, data.items],
  );

  const [adding, setAdding] = useState(false);
  const [dates, setDates] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [item, setItem] = useState<{ dayId: string; item?: ItemRecord | undefined } | undefined>(
    undefined,
  );
  const [words, setWords] = useState<DayRecord | undefined>(undefined);
  const [deleting, setDeleting] = useState<ItemRecord | undefined>(undefined);
  const [notice, setNotice] = useState<string | undefined>(undefined);

  if (!sets) return null;
  const ordered = stopsInOrder(sets.stops);

  const apply = async (moving: ItemRecord, dayId: string, before: string | null) => {
    const others = data.items.filter((each) => each.dayId === dayId && each.id !== moving.id);
    const made = moveItem(tripId, moving, dayId, others, before, actionContext());
    if (!made.ok) return setNotice(made.sentence);
    setNotice(undefined);
    await local?.record(made.mutation);
  };
  const onDragEnd = (event: DragEndEvent) => {
    if (!event.over) return;
    const moving = data.items.find((each) => each.id === event.active.id);
    const drop = dropOf(plan, String(event.active.id), String(event.over.id));
    if (moving && drop) void apply(moving, drop.dayId, drop.before);
  };
  const nudge = (itemId: string, direction: 'up' | 'down') => {
    const moving = data.items.find((each) => each.id === itemId);
    const drop = nudgeOf(plan, itemId, direction);
    if (moving && drop) void apply(moving, drop.dayId, drop.before);
  };
  const remove = async (target: ItemRecord) => {
    const made = deleteItem(tripId, target.id, actionContext());
    if (made.ok) await local?.record(made.mutation);
    setDeleting(undefined);
  };
  const move = async (target: StopRecord, before: string | null) => {
    const answer = await askOp({ op: 'stop.move', tripId, stopId: target.id, before });
    if (!answer) setNotice(NO_CONNECTION);
    else if (!answer.ok) setNotice(answer.sentence ?? NOT_DONE);
    else {
      setNotice(undefined);
      await local?.syncNow();
    }
  };
  const choose = (id: string) => loc.setQuery({ stop: id });

  const undated = ordered.filter((each) => each.arrive === null);
  const at = stop ? undated.findIndex((each) => each.id === stop.id) : -1;

  return (
    <div className={styles.plan}>
      {ordered.length === 0 ? (
        <EmptyState
          icon="map-pin"
          heading="No stops yet"
          description={
            editable
              ? 'A trip is a row of stops, each a place and the days there.'
              : 'The trip has no stops yet.'
          }
          action={
            editable ? <Button onClick={() => setAdding(true)}>Add a stop</Button> : undefined
          }
        />
      ) : (
        <StepStrip
          aria-label="Stops"
          items={ordered.map((each) => ({ id: each.id }))}
          activeId={stop?.id ?? null}
          {...(editable ? { onAdd: () => setAdding(true), addLabel: 'Add a stop' } : {})}
          renderItem={(entry, state) => {
            const each = ordered.find((candidate) => candidate.id === entry.id);
            if (!each) return null;
            return (
              <button
                type="button"
                className={styles.stopChip}
                aria-pressed={state.isActive}
                onClick={() => choose(each.id)}
              >
                <span className={styles.stopName}>{each.place.name}</span>
                <span className={styles.muted}>{datesText(each.arrive, each.depart)}</span>
              </button>
            );
          }}
        />
      )}

      {notice ? (
        <p role="alert" className={styles.problem}>
          {notice}
        </p>
      ) : null}

      {stop ? (
        <div className={styles.stopPanel}>
          <div className={styles.stopHead}>
            <h2>{stop.place.name}</h2>
            <span className={styles.muted}>{datesText(stop.arrive, stop.depart)}</span>
            {editable ? (
              <span className={styles.stopActions}>
                <Button variant="secondary" onClick={() => setDates(true)}>
                  Change dates
                </Button>
                {stop.arrive === null && at > 0 ? (
                  <Button
                    variant="ghost"
                    onClick={() => void move(stop, undated[at - 1]?.id ?? null)}
                  >
                    Move earlier
                  </Button>
                ) : null}
                {stop.arrive === null && at >= 0 && at < undated.length - 1 ? (
                  <Button
                    variant="ghost"
                    onClick={() => void move(stop, undated[at + 2]?.id ?? null)}
                  >
                    Move later
                  </Button>
                ) : null}
                <Button variant="ghost" onClick={() => setRemoving(true)}>
                  Remove the stop
                </Button>
              </span>
            ) : null}
          </div>
          {stop.note ? <p>{stop.note}</p> : null}

          {plan.length === 0 ? (
            <EmptyState
              icon="calendar-days"
              heading="No days yet"
              description={
                editable
                  ? 'A stop’s days come from its dates. Give it dates to plan its days.'
                  : 'This stop has no dates yet.'
              }
              action={
                editable ? <Button onClick={() => setDates(true)}>Change dates</Button> : undefined
              }
            />
          ) : (
            <DndContext sensors={sensors} collisionDetection={closestCorners} onDragEnd={onDragEnd}>
              <div className={styles.days}>
                {plan.map((each, index) => (
                  <DayColumn
                    key={each.day.id}
                    plan={each}
                    index={index}
                    data={data}
                    editable={editable}
                    onAdd={() => setItem({ dayId: each.day.id })}
                    onEditItem={(target) => setItem({ dayId: target.dayId, item: target })}
                    onNudge={nudge}
                    onDelete={setDeleting}
                    onWords={() => setWords(each.day)}
                  />
                ))}
              </div>
            </DndContext>
          )}

          {editable ? (
            <>
              <DatesDialog
                open={dates}
                onClose={() => setDates(false)}
                tripId={tripId}
                stop={stop}
                data={data}
              />
              <RemoveStopDialog
                open={removing}
                onClose={() => setRemoving(false)}
                tripId={tripId}
                stop={stop}
                data={data}
                onRemoved={() => loc.setQuery({ stop: undefined })}
              />
            </>
          ) : null}
        </div>
      ) : null}

      {editable ? (
        <>
          <AddStopDialog
            open={adding}
            onClose={() => setAdding(false)}
            tripId={tripId}
            onAdded={() => undefined}
          />
          <ItemDialog
            open={Boolean(item)}
            onClose={() => setItem(undefined)}
            tripId={tripId}
            data={data}
            dayId={item?.dayId ?? ''}
            item={item?.item}
          />
          <WordsDialog day={words} tripId={tripId} onClose={() => setWords(undefined)} />
          <Dialog
            open={Boolean(deleting)}
            onClose={() => setDeleting(undefined)}
            title="Delete this item?"
            size="sm"
          >
            <div className={styles.form}>
              <p>
                <strong>{deleting?.title?.trim() || deleting?.place?.name || 'This item'}</strong>{' '}
                will be removed from the plan.
              </p>
              <div className={styles.actions}>
                <Button variant="secondary" onClick={() => setDeleting(undefined)}>
                  Keep it
                </Button>
                <Button variant="destructive" onClick={() => deleting && void remove(deleting)}>
                  Delete the item
                </Button>
              </div>
            </div>
          </Dialog>
        </>
      ) : null}
    </div>
  );
}
