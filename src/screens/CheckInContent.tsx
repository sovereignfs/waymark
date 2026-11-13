'use client';

import { type FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Button,
  FormField,
  Input,
  SegmentedControl,
  TagInput,
  Textarea,
  useToast,
} from '@sovereignfs/ui';
import type { CheckinView } from '../actions/types';
import { autoLinkFor } from '../autolink/device';
import { useLocal } from '../local/LocalProvider';
import {
  type Option,
  buildOptions,
  planCheckIn,
  planEdit,
  selectionOf,
  zoneOfSelection,
} from './checkin-flow';
import type { CheckInFrom } from './checkin';
import { POSITION_SENTENCES, type Position } from './checkin-flow';
import styles from './CheckIn.module.css';
import { PhotoImage } from './PhotoImage';
import { PointPicker } from './PointPicker';
import { localDateOf, localTimeOf } from './timeline';
import { usePlaceSearch } from './usePlaceSearch';
import { useMapStyle } from './useMapStyle';
import { usePosition } from './usePosition';

/**
 * What is in the check-in sheet (DESIGN.md §9.2, §20.5): choose where, say when, add a note, photos and who was there, and press Check in. **Saving closes the sheet at once: the check-in is on the device and goes
 * when there is a network** (§15). Everything below the place is optional.
 *
 * The decisions are `checkin-flow.ts`'s (which places are offered, which moment, which action); this draws them and passes on what the person did. **Nothing here needs a network or the position**: the person's own places
 * are searched on the device; _Here_ is asked for when first used and left out, with a sentence, when it is refused; a place search that is off or out of reach says so; a new place can be made by name at the position, or a
 * point alone can be saved to be named later. _On the map_ is 17.1's, and is not offered until it exists.
 */
type Way = 'here' | 'search' | 'map';

const metres = (m: number | undefined) =>
  m === undefined
    ? ''
    : m < 1000
      ? `${Math.max(1, Math.round(m / 10) * 10)} m`
      : `${(m / 1000).toFixed(1)} km`;

const pad = (n: number) => String(n).padStart(2, '0');
const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const nowTime = () => {
  const d = new Date();
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

/**
 * `editing` is a check-in being changed (DESIGN.md §9.4): the same form, filled in, with the person's own places to move it to, its moment on the clock where it was made, its note, who was with them and its photos,
 * and **Save**. Here, the place search and a new place are for checking in, and are not offered.
 */
export function CheckInContent({
  onDone,
  editing,
  from,
}: {
  onDone: () => void;
  editing?: CheckinView | undefined;
  /** Opened from Trip Mode for a trip's item: its place is on offer first, and the check-in is of that trip. */
  from?: CheckInFrom | undefined;
}) {
  const local = useLocal();
  const toast = useToast();
  const { state: position, ask } = usePosition(!editing);
  const [way, setWay] = useState<Way>('search');
  const [query, setQuery] = useState('');
  const here = !editing && position.status === 'granted' ? position.position : undefined;
  // _On the map_: a point the person chose, which the places on offer are near, as _Here_'s position is. Offered only where the server has a map.
  const mapStyle = useMapStyle();
  const canMap = !editing && mapStyle.status === 'on';
  const [picked, setPicked] = useState<Position | undefined>(undefined);
  const anchor = way === 'map' ? picked : here;
  const search = usePlaceSearch(way === 'search' && !editing ? query : '', anchor);
  const [chosen, setChosen] = useState<string | undefined>(
    editing ? `mine:${editing.placeId}` : undefined,
  );
  const [newName, setNewName] = useState('');
  // The place of the item this check-in is for (from Trip Mode), read from the device, and chosen at first.
  const [prefill, setPrefill] = useState<{ name: string; point: Position } | undefined>(undefined);
  useEffect(() => {
    if (!from || !local) return;
    let alive = true;
    void local.trip(from.tripId).then((data) => {
      const place = data?.items.find((item) => item.id === from.itemId)?.place;
      if (!alive || !place) return;
      setPrefill({ name: place.name, point: { lat: place.lat, lng: place.lng } });
      setChosen('prefill');
      setNewName(place.name);
    });
    return () => {
      alive = false;
    };
  }, [from, local]);
  const [another, setAnother] = useState(false);
  const [date, setDate] = useState(editing ? localDateOf(editing) : today());
  const [time, setTime] = useState(editing ? localTimeOf(editing) : nowTime());
  const [note, setNote] = useState(editing?.note ?? '');
  const [companions, setCompanions] = useState<string[]>(editing ? [...editing.companions] : []);
  // The photos the check-in has, which can be taken away; the new ones are `files`.
  const [kept, setKept] = useState<string[]>(editing?.photos ? [...editing.photos] : []);
  const [files, setFiles] = useState<File[]>([]);
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  // The search field has the focus when the sheet opens on it, so typing is all it takes; the name of a new place has it when that is what was chosen.
  useEffect(() => {
    // After a moment: the sheet puts the focus where it likes as it opens, and this is where the person wants it.
    if (way !== 'search') return;
    const timer = setTimeout(() => searchRef.current?.focus(), 80);
    return () => clearTimeout(timer);
  }, [way]);
  useEffect(() => {
    if (chosen === 'new') nameRef.current?.focus();
  }, [chosen]);

  // Here is the first way when the device already allows it.
  useEffect(() => {
    if (position.status === 'granted')
      setWay((current) => (current === 'search' && query === '' ? 'here' : current));
  }, [position.status]);

  const canHere = position.status !== 'denied' && position.status !== 'unavailable';
  // Here is gone when it is refused: the person is left on Search, which does not need it.
  useEffect(() => {
    if (!canHere) setWay('search');
  }, [canHere]);

  const places = local?.places ?? [];
  const options = useMemo(() => {
    const built = buildOptions({
      places,
      query: way === 'search' ? query : '',
      position: anchor,
      found: search.found,
      reverse: way === 'search' ? undefined : search.reverse,
    });
    if (!editing)
      return prefill
        ? [
            { key: 'prefill', kind: 'new' as const, point: prefill.point },
            ...built.filter((option) => option.kind !== 'new'),
          ]
        : built;
    // Changing a check-in moves it among the person's own places, with the one it is at first.
    const mine = built.filter((option) => option.kind === 'mine');
    const current = places.find((place) => place.id === editing.placeId);
    return current && !mine.some((option) => option.key === `mine:${current.id}`)
      ? [
          { key: `mine:${current.id}`, kind: 'mine' as const, place: current, distance: undefined },
          ...mine,
        ]
      : mine;
  }, [places, query, way, anchor, search.found, search.reverse, editing, prefill]);
  // What is chosen, by its key, or by the key it had before the place was the person's own (a place the search offered arrives on the device while the sheet is open).
  const selected: Option | undefined =
    options.find((option) => option.key === chosen) ??
    options.find((option) => option.kind === 'mine' && chosen && option.aliases?.includes(chosen));
  const selection = selectionOf(selected, newName);
  const zone = selection ? zoneOfSelection(selection) : undefined;
  const photoUrls = useMemo(() => files.map((file) => URL.createObjectURL(file)), [files]);
  useEffect(() => () => photoUrls.forEach((url) => URL.revokeObjectURL(url)), [photoUrls]);

  const choose = (key: string) => {
    setChosen(key);
    setError(undefined);
  };

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!local || busy) return;
    // Enter in the search field with nothing chosen takes the first place on offer: a place of the person's, or the search's.
    const first = options.find((option) => option.kind === 'mine' || option.kind === 'found');
    const picked = selected ?? (selected === undefined ? first : undefined);
    const sel = selectionOf(picked, newName);
    setError(undefined);
    const photoIds = files.map(() => crypto.randomUUID());
    const ctx = {
      ids: { newId: () => crypto.randomUUID() },
      now: Date.now(),
      deviceZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      // The trip it falls into, decided here so that it shows at once with no network (the server decides again).
      // From Trip Mode the trip is the item's, and **the person's own choice** (a link by hand, which nothing automatic changes: two trips can share their dates and their place); otherwise the one the dates and
      // the place suggest.
      link: from
        ? () => ({ tripId: from.tripId, source: 'chosen' as const })
        : autoLinkFor(local.trips, local.places),
    };
    const plan = editing
      ? planEdit(
          editing,
          selectionOf(selected ?? options.find((o) => o.key === `mine:${editing.placeId}`), ''),
          { local: { date, time }, note, companions, photos: [...kept, ...photoIds] },
          ctx,
        )
      : planCheckIn(
          sel,
          places,
          { local: another ? { date, time } : undefined, note, companions, photos: photoIds },
          ctx,
        );
    if (!plan.ok) {
      setError(plan.sentence);
      return;
    }
    setBusy(true);
    try {
      for (const [index, file] of files.entries()) {
        const kept = await local.addPhoto(file, photoIds[index]);
        if (!kept.ok) {
          setError(kept.sentence);
          return;
        }
      }
      await local.record(plan.mutation);
      toast.show({ title: editing ? 'Saved' : 'Checked in', category: 'success', duration: 3000 });
      onDone();
    } catch {
      setError('This browser could not keep the check-in. Try again.');
    } finally {
      setBusy(false);
    }
  }

  if (!local)
    return (
      <div className={styles.form}>
        <Alert variant="error">
          This browser cannot keep check-ins on this device, so it cannot check in.
        </Alert>
      </div>
    );

  const needsName = selected?.kind === 'new';
  const hereNote =
    position.status === 'denied'
      ? POSITION_SENTENCES.denied
      : position.status === 'unavailable'
        ? POSITION_SENTENCES.unavailable
        : undefined;
  const searchNote =
    search.status === 'offline'
      ? POSITION_SENTENCES.offline
      : search.status === 'off'
        ? POSITION_SENTENCES.off
        : search.status === 'unavailable'
          ? POSITION_SENTENCES.unreachable
          : undefined;

  return (
    <form
      className={styles.form}
      noValidate
      onSubmit={(event) => void submit(event)}
      aria-label={editing ? 'Change check-in' : 'Check in'}
    >
      {editing ? null : (
        <SegmentedControl
          aria-label="How to find the place"
          value={way}
          onChange={(next) => {
            setWay(next);
            if (next === 'here' && position.status === 'idle') ask();
          }}
          options={[
            ...(canHere ? [{ value: 'here' as const, label: 'Here' }] : []),
            { value: 'search' as const, label: 'Search' },
            ...(canMap ? [{ value: 'map' as const, label: 'On the map' }] : []),
          ]}
        />
      )}
      {hereNote ? <p className={styles.hint}>{hereNote}</p> : null}

      {way === 'search' ? (
        <FormField
          label="Search for a place"
          hint={searchNote ?? 'Your own places first, then the place search.'}
        >
          {(field) => (
            <Input
              {...field}
              type="search"
              name="query"
              autoComplete="off"
              ref={searchRef}
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setChosen(undefined);
              }}
            />
          )}
        </FormField>
      ) : way === 'map' ? (
        <PointPicker
          value={picked}
          start={here}
          onPick={(point) => {
            setPicked(point);
            setChosen(undefined);
          }}
        />
      ) : position.status === 'asking' ? (
        <p className={styles.hint} role="status">
          Finding where you are…
        </p>
      ) : null}

      <fieldset className={styles.where}>
        <legend>Where</legend>
        {options.length === 0 ? (
          <p className={styles.hint}>
            {way === 'search'
              ? query.trim() === ''
                ? 'Type a name to search.'
                : 'Nothing found yet.'
              : way === 'map'
                ? picked
                  ? ''
                  : 'Choose a point on the map.'
                : position.status === 'granted'
                  ? ''
                  : 'Choose Search, or allow your position.'}
          </p>
        ) : (
          <ul className={styles.options}>
            {options.map((option) => (
              <li key={option.key}>
                <label className={styles.option}>
                  <input
                    type="radio"
                    name="where"
                    checked={selected?.key === option.key}
                    onChange={() => choose(option.key)}
                  />
                  <span className={styles.name}>
                    {option.kind === 'mine'
                      ? option.place.name
                      : option.kind === 'found'
                        ? option.candidate.name
                        : option.kind === 'new'
                          ? option.key === 'prefill'
                            ? (prefill?.name ?? 'The place')
                            : 'New place here…'
                          : `A place near ${option.point.lat.toFixed(4)}, ${option.point.lng.toFixed(4)}`}
                  </span>
                  <span className={styles.meta}>
                    {option.kind === 'mine'
                      ? `your place${option.distance !== undefined ? ` · ${metres(option.distance)}` : ''}`
                      : option.kind === 'found'
                        ? `${option.candidate.address?.city ?? option.candidate.category ?? 'from the place search'}${option.distance !== undefined ? ` · ${metres(option.distance)}` : ''}`
                        : option.kind === 'point'
                          ? 'named later'
                          : option.key === 'prefill'
                            ? 'from the plan'
                            : ''}
                  </span>
                  {option.kind === 'new' && option.key !== 'prefill' && chosen === option.key ? (
                    <span className={styles.newName}>
                      <Input
                        aria-label="Name of the new place"
                        ref={nameRef}
                        value={newName}
                        onChange={(event) => setNewName(event.target.value)}
                        placeholder="Name this place"
                        maxLength={200}
                      />
                    </span>
                  ) : null}
                </label>
              </li>
            ))}
          </ul>
        )}
      </fieldset>

      {editing ? (
        <div className={styles.moment}>
          <FormField label="Date">
            {(field) => (
              <Input
                {...field}
                type="date"
                name="date"
                max={today()}
                value={date}
                onChange={(event) => setDate(event.target.value)}
              />
            )}
          </FormField>
          <FormField label="Time">
            {(field) => (
              <Input
                {...field}
                type="time"
                name="time"
                value={time}
                onChange={(event) => setTime(event.target.value)}
              />
            )}
          </FormField>
          <p className={styles.hint}>On the clock where it was made ({editing.tz}).</p>
        </div>
      ) : (
        <div className={styles.moment}>
          <Button
            type="button"
            variant="secondary"
            aria-pressed={another}
            onClick={() => setAnother((on) => !on)}
          >
            {another ? 'Now' : 'Another time'}
          </Button>
          {another ? (
            <>
              <FormField label="Date">
                {(field) => (
                  <Input
                    {...field}
                    type="date"
                    name="date"
                    max={today()}
                    value={date}
                    onChange={(event) => setDate(event.target.value)}
                  />
                )}
              </FormField>
              <FormField label="Time">
                {(field) => (
                  <Input
                    {...field}
                    type="time"
                    name="time"
                    value={time}
                    onChange={(event) => setTime(event.target.value)}
                  />
                )}
              </FormField>
              <p className={styles.hint}>
                {zone
                  ? `On the clock where the place is (${zone}).`
                  : 'On the clock where the place is.'}
              </p>
            </>
          ) : (
            <p className={styles.hint}>Now</p>
          )}
        </div>
      )}

      <FormField label="Note">
        {(field) => (
          <Textarea
            {...field}
            name="note"
            rows={2}
            maxLength={2000}
            value={note}
            onChange={(event) => setNote(event.target.value)}
          />
        )}
      </FormField>

      <FormField label="With…" hint="Names of who was there; press Enter after each.">
        {(field) => (
          <TagInput
            {...field}
            value={companions}
            onChange={setCompanions}
            placeholder="Add a name"
          />
        )}
      </FormField>

      {kept.length > 0 ? (
        <ul className={styles.photos} aria-label="Photos it has">
          {kept.map((photo, index) => (
            <li key={photo} className={styles.photo}>
              <PhotoImage id={photo} thumb alt={`Photo ${index + 1}`} />
              <Button
                type="button"
                variant="secondary"
                size="sm"
                aria-label={`Take away photo ${index + 1}`}
                onClick={() => setKept((current) => current.filter((id) => id !== photo))}
              >
                ×
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
      <div>
        <label className={styles.hint} htmlFor="checkin-photos">
          Photos
        </label>
        <input
          id="checkin-photos"
          className={styles.file}
          type="file"
          name="photos"
          accept="image/*"
          multiple
          onChange={(event) => {
            const added = [...(event.target.files ?? [])];
            setFiles((current) => [...current, ...added].slice(0, Math.max(0, 10 - kept.length)));
            event.target.value = '';
          }}
        />
        {files.length > 0 ? (
          <ul className={styles.photos} aria-label="Photos to add">
            {files.map((file, index) => (
              <li key={`${file.name}-${index}`} className={styles.photo}>
                {}
                <img src={photoUrls[index]} alt={file.name} />
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  aria-label={`Remove ${file.name}`}
                  onClick={() => setFiles((current) => current.filter((_, at) => at !== index))}
                >
                  ×
                </Button>
              </li>
            ))}
          </ul>
        ) : null}
      </div>

      {error ? <Alert variant="error">{error}</Alert> : null}
      <div className={styles.actions}>
        <Button
          type="submit"
          loading={busy}
          disabled={
            (selection === undefined &&
              !options.some((o) => o.kind === 'mine' || o.kind === 'found')) ||
            (needsName && newName.trim() === '')
          }
        >
          {editing ? 'Save' : 'Check in'}
        </Button>
      </div>
    </form>
  );
}
