'use client';

import { useMemo, useState } from 'react';
import { Badge, Button, FormField, Select, useToast } from '@sovereignfs/ui';
import { editCheckin } from '../actions/checkins';
import type { CheckinView } from '../actions/types';
import { autoLinkFor, candidatesOf } from '../autolink/device';
import { useLocal } from '../local/LocalProvider';
import type { ShareChoice } from '../sharing/rules';
import { NOT_DONE, NO_CONNECTION, askOp } from './ops';
import { actionContext } from './planContext';
import styles from './Timeline.module.css';
import { DOT } from './trips';

const SHARE_WORDS: Readonly<Record<CheckinView['share'], string>> = {
  trip: 'Follow what I chose for the trip',
  on: 'Share with the trip',
  off: 'Keep private',
};

/**
 * A check-in's trip and who it is shared with (DESIGN.md §11.3, §12, §20.6): **the trip it falls into**, suggested by the app (the dates and the nearest stop) or chosen by the person, with _Change_ and _Unlink_ (a link made or taken
 * away by hand is the person's, and nothing automatic changes it again); **whether it is shared with the trip's members**, which is the person's own: their choice for the trip, overridden by this check-in's own word. The
 * first time a check-in falls into a trip with other people, and the person has not said, it **asks once**: _Share your check-ins on <trip> with its N members?_ Links and sharing are changes recorded on the device, which work with no network.
 */
export function CheckinTrip({ checkin }: { checkin: CheckinView }) {
  const local = useLocal();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const entries = local?.trips ?? [];
  const linked = entries.find((entry) => entry.id === checkin.tripId);
  const mine = linked?.sets?.members.find((member) => member.self);
  const others = (linked?.sets?.members.length ?? 1) - 1;
  // The trips the person goes on, to choose among.
  const choices = useMemo(
    () =>
      candidatesOf(entries)
        .filter((candidate) => candidate.goes)
        .flatMap((candidate) => {
          const sets = entries.find((entry) => entry.id === candidate.id)?.sets;
          return sets ? [{ id: candidate.id, name: sets.trip.name, color: sets.trip.color }] : [];
        })
        .sort((a, b) => a.name.localeCompare(b.name)),
    [entries],
  );
  if (!local || (choices.length === 0 && !checkin.tripId)) return null;

  const change = (patch: Parameters<typeof editCheckin>[1]) => {
    const made = editCheckin(checkin, patch, {
      ...actionContext(),
      link: autoLinkFor(entries, local.places),
    });
    if (!made.ok) {
      toast.show({ title: made.sentence, category: 'error' });
      return Promise.resolve();
    }
    return local.record(made.mutation);
  };

  const choose = async (choice: ShareChoice) => {
    if (!linked) return;
    setBusy(true);
    const answer = await askOp({ op: 'member.share', tripId: linked.id, choice });
    if (!answer) toast.show({ title: NO_CONNECTION, category: 'error' });
    else if (!answer.ok) toast.show({ title: NOT_DONE, category: 'error' });
    else await local.syncNow();
    setBusy(false);
  };

  const effective: ShareChoice | 'private' =
    checkin.share === 'on' ? 'on' : checkin.share === 'off' ? 'private' : (mine?.share ?? 'ask');
  const asks = Boolean(linked) && checkin.share === 'trip' && effective === 'ask' && others > 0;

  return (
    <section className={styles.trip} aria-label="Trip">
      {linked?.sets ? (
        <p className={styles.tripLine}>
          <span
            className={styles.tripDot}
            style={{ background: DOT[linked.sets.trip.color] }}
            aria-hidden
          />
          Part of <a href={`/t/${linked.id}`}>{linked.sets.trip.name}</a>
          <Badge size="xs" variant="role" uppercase={false}>
            {checkin.linkSource === 'manual' ? 'Linked by you' : 'Suggested'}
          </Badge>
          {effective === 'on' ? (
            <Badge size="xs" variant="status" status="active">
              Shared with the trip
            </Badge>
          ) : null}
        </p>
      ) : checkin.tripId ? (
        <p className={styles.tripLine}>Linked to a trip that is not on this device.</p>
      ) : (
        <p className={styles.tripLine}>Not part of a trip.</p>
      )}

      <div className={styles.tripActions}>
        {choices.length > 0 ? (
          <FormField label={checkin.tripId ? 'Change the trip' : 'Link to a trip'}>
            {(field) => (
              <Select
                {...field}
                name="trip"
                value=""
                onChange={(event) =>
                  event.target.value && void change({ trip: { tripId: event.target.value } })
                }
              >
                <option value="">Choose a trip</option>
                {choices
                  .filter((choice) => choice.id !== checkin.tripId)
                  .map((choice) => (
                    <option key={choice.id} value={choice.id}>
                      {choice.name}
                    </option>
                  ))}
              </Select>
            )}
          </FormField>
        ) : null}
        {checkin.tripId ? (
          <Button variant="secondary" onClick={() => void change({ trip: null })}>
            Unlink
          </Button>
        ) : null}
        {checkin.tripId && checkin.linkSource === 'manual' ? (
          <Button variant="ghost" onClick={() => void change({ trip: 'auto' })}>
            Let Waymark suggest
          </Button>
        ) : null}
      </div>

      {linked ? (
        <FormField label="Sharing this check-in">
          {(field) => (
            <Select
              {...field}
              name="share"
              value={checkin.share}
              onChange={(event) =>
                void change({ share: event.target.value as CheckinView['share'] })
              }
            >
              {(Object.keys(SHARE_WORDS) as CheckinView['share'][]).map((each) => (
                <option key={each} value={each}>
                  {SHARE_WORDS[each]}
                </option>
              ))}
            </Select>
          )}
        </FormField>
      ) : null}

      {asks && linked?.sets ? (
        <div className={styles.ask} role="group" aria-label="Share your check-ins">
          <p>
            Share your check-ins on <strong>{linked.sets.trip.name}</strong> with its {others}{' '}
            {others === 1 ? 'member' : 'members'}?
          </p>
          <div className={styles.tripActions}>
            <Button disabled={busy} onClick={() => void choose('on')}>
              Share them
            </Button>
            <Button variant="secondary" disabled={busy} onClick={() => void choose('off')}>
              Keep them private
            </Button>
          </div>
          <p className={styles.muted}>Only you can change this, from the trip’s page.</p>
        </div>
      ) : null}
    </section>
  );
}
