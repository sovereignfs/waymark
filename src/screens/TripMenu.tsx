'use client';

import { useState } from 'react';
import {
  Button,
  ConfirmDialog,
  Dialog,
  FormField,
  Icon,
  Input,
  Menu,
  useToast,
} from '@sovereignfs/ui';
import { useLocal } from '../local/LocalProvider';
import { TRIP_NAME_MAX, type TripColor } from '../trips/format';
import { goTo } from './checkin-location';
import { TripColorPicker } from './TripColorPicker';
import { NOT_DONE, NO_CONNECTION, type OpAnswer, askOp } from './ops';
import styles from './Trips.module.css';

type Open = 'rename' | 'color' | 'delete' | undefined;

/**
 * The trip's menu (DESIGN.md §20.10), an Organizer's: **rename, colour and delete**. Each is an online operation the server decides; the page changes when the device has the answer (a sync), and a refusal or no connection is
 * said in a sentence. Deleting asks first, saying what goes with the trip and what stays (the check-ins linked to it stay their owners').
 */
export function TripMenu({
  tripId,
  name,
  color,
}: {
  tripId: string;
  name: string;
  color: TripColor;
}) {
  const local = useLocal();
  const toast = useToast();
  const [menu, setMenu] = useState(false);
  const [open, setOpen] = useState<Open>(undefined);
  const [text, setText] = useState(name);
  const [chosen, setChosen] = useState<TripColor>(color);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const [deletion, setDeletion] = useState<OpAnswer['deletion']>(undefined);

  const close = () => {
    setOpen(undefined);
    setProblem(undefined);
    setBusy(false);
  };

  const change = async (body: Record<string, unknown>): Promise<boolean> => {
    setBusy(true);
    setProblem(undefined);
    const answer = await askOp({ tripId, ...body });
    if (!answer) {
      setBusy(false);
      setProblem(NO_CONNECTION);
      return false;
    }
    if (!answer.ok) {
      setBusy(false);
      setProblem(NOT_DONE);
      return false;
    }
    await local?.syncNow();
    return true;
  };

  const rename = async () => {
    if (text.trim() === '') return setProblem('Give the trip a name.');
    if (await change({ op: 'trip.update', name: text.trim() })) close();
  };
  const recolor = async () => {
    if (await change({ op: 'trip.update', color: chosen })) close();
  };
  const startDelete = async () => {
    const answer = await askOp({ op: 'trip.delete.preview', tripId });
    if (!answer) return toast.show({ title: NO_CONNECTION, category: 'error' });
    if (!answer.ok || !answer.deletion) return toast.show({ title: NOT_DONE, category: 'error' });
    setDeletion(answer.deletion);
    setOpen('delete');
  };
  const remove = async () => {
    if (await change({ op: 'trip.delete', confirm: true })) {
      close();
      goTo('/trips', 'replace');
    }
  };

  return (
    <>
      <Menu
        aria-label="Trip menu"
        open={menu}
        onClose={() => setMenu(false)}
        align="right"
        trigger={
          <Button
            variant="secondary"
            aria-label="Trip menu"
            aria-haspopup="menu"
            aria-expanded={menu}
            onClick={() => setMenu((each) => !each)}
          >
            <Icon name="ellipsis-vertical" aria-hidden />
          </Button>
        }
        items={[
          {
            label: 'Rename',
            icon: 'pencil',
            onSelect: () => {
              setText(name);
              setOpen('rename');
            },
          },
          {
            label: 'Change colour',
            icon: 'paint-bucket',
            onSelect: () => {
              setChosen(color);
              setOpen('color');
            },
          },
          { type: 'separator' },
          {
            label: 'Delete trip',
            icon: 'trash-2',
            destructive: true,
            onSelect: () => void startDelete(),
          },
        ]}
      />

      <Dialog open={open === 'rename'} onClose={close} title="Rename the trip" size="sm">
        <form
          className={styles.form}
          onSubmit={(event) => {
            event.preventDefault();
            void rename();
          }}
        >
          <FormField label="Name">
            {(field) => (
              <Input
                {...field}
                name="name"
                value={text}
                maxLength={TRIP_NAME_MAX}
                autoComplete="off"
                onChange={(event) => setText(event.target.value)}
              />
            )}
          </FormField>
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
              Save
            </Button>
          </div>
        </form>
      </Dialog>

      <Dialog open={open === 'color'} onClose={close} title="Change the colour" size="sm">
        <div className={styles.form}>
          <TripColorPicker value={chosen} onChange={setChosen} />
          {problem ? (
            <p role="alert" className={styles.problem}>
              {problem}
            </p>
          ) : null}
          <div className={styles.actions}>
            <Button type="button" variant="secondary" onClick={close}>
              Cancel
            </Button>
            <Button type="button" disabled={busy} onClick={() => void recolor()}>
              Save
            </Button>
          </div>
        </div>
      </Dialog>

      <ConfirmDialog
        open={open === 'delete'}
        onClose={close}
        title="Delete this trip?"
        destructive
        confirmLabel={busy ? 'Deleting…' : 'Delete trip'}
        pending={busy}
        error={problem}
        onConfirm={() => void remove()}
        message={
          deletion ? (
            <>
              <strong>{deletion.name}</strong> will be deleted for everyone: its{' '}
              {deletion.stops === 1 ? 'stop' : `${deletion.stops} stops`}, days, items, links and
              files, and{' '}
              {deletion.members === 1 ? 'its one member' : `its ${deletion.members} members`} lose
              it. The {deletion.linkedCheckins === 1 ? 'check-in' : 'check-ins'} linked to it (
              {deletion.linkedCheckins}) stay with whoever made them. This cannot be undone.
            </>
          ) : null
        }
      />
    </>
  );
}
