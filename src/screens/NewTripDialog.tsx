'use client';

import { type FormEvent, useState } from 'react';
import { Button, Dialog, FormField, Input } from '@sovereignfs/ui';
import { useLocal } from '../local/LocalProvider';
import type { Candidate } from '../places/providers';
import { DEFAULT_COLOR, TRIP_NAME_MAX, type TripColor } from '../trips/format';
import styles from './Trips.module.css';
import { TripColorPicker } from './TripColorPicker';
import { askOp as ask } from './ops';
import { usePlaceSearch } from './usePlaceSearch';

/**
 * _New trip_ (DESIGN.md §20.9): a name, a colour and, if the person has one in mind, the first stop. **An online operation** (trips are the server's to decide, §15.7): it needs a connection and says so in a sentence when
 * there is none, and the trip is then pulled into the device so that the list and the sidebar show it at once.
 */
export function NewTripDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const local = useLocal();
  const [name, setName] = useState('');
  const [color, setColor] = useState<TripColor>(DEFAULT_COLOR);
  const [where, setWhere] = useState('');
  const [stop, setStop] = useState<Candidate | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const search = usePlaceSearch(stop ? '' : where, undefined);

  const close = () => {
    setName('');
    setColor(DEFAULT_COLOR);
    setWhere('');
    setStop(undefined);
    setProblem(undefined);
    setBusy(false);
    onClose();
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    const trimmed = name.trim();
    if (trimmed === '') return setProblem('Give the trip a name.');
    setBusy(true);
    setProblem(undefined);
    const made = await ask({ op: 'trip.create', name: trimmed, color });
    if (!made) {
      setBusy(false);
      return setProblem('A trip is made on the server, and there is no connection to it now.');
    }
    if (!made.ok || !made.trip) {
      setBusy(false);
      return setProblem('That trip could not be made.');
    }
    if (stop) {
      // The trip stands without its first stop if this fails: say so, and it can be added from the plan.
      const added = await ask({
        op: 'stop.add',
        tripId: made.trip.id,
        place: {
          name: stop.name,
          lat: stop.lat,
          lng: stop.lng,
          address: stop.address,
          category: stop.category,
          source: stop.source,
          sourceId: stop.sourceId,
        },
      });
      if (!added?.ok) {
        await local?.syncNow();
        setBusy(false);
        return setProblem(
          'The trip was made, but its first stop was not added. You can add it from the plan.',
        );
      }
    }
    await local?.syncNow();
    close();
  };

  const results = stop ? [] : search.found;
  return (
    <Dialog open={open} onClose={close} title="New trip" size="sm">
      <form onSubmit={(event) => void submit(event)} className={styles.form}>
        <FormField label="Name">
          {(field) => (
            <Input
              {...field}
              name="name"
              value={name}
              maxLength={TRIP_NAME_MAX}
              autoComplete="off"
              onChange={(event) => setName(event.target.value)}
            />
          )}
        </FormField>
        <TripColorPicker value={color} onChange={setColor} />
        {stop ? (
          <div className={styles.chosen}>
            <span>
              First stop: <strong>{stop.name}</strong>
            </span>
            <Button type="button" variant="ghost" onClick={() => setStop(undefined)}>
              Change
            </Button>
          </div>
        ) : (
          <>
            <FormField
              label="First stop (optional)"
              hint="Search for a place. You can add stops later."
            >
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
            {results.length > 0 ? (
              <ul className={styles.found} aria-label="Places found">
                {results.map((each) => (
                  <li key={each.sourceId}>
                    <button type="button" onClick={() => setStop(each)}>
                      {each.name}
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
            {search.status === 'offline' ? (
              <p className={styles.hint}>Searching for a place needs a connection.</p>
            ) : search.status === 'unavailable' ? (
              <p className={styles.hint}>
                Place search is not answering now. Try again in a moment.
              </p>
            ) : search.status === 'off' ? (
              <p className={styles.hint}>Place search is not set up on this server.</p>
            ) : null}
          </>
        )}
        {problem ? (
          <p role="alert" className={styles.problem}>
            {problem}
          </p>
        ) : null}
        <div className={styles.actions}>
          <Button type="button" variant="secondary" onClick={close}>
            Cancel
          </Button>
          <Button type="submit" disabled={busy}>
            {busy ? 'Making the trip…' : 'Make the trip'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
