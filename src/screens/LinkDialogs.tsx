'use client';

import { type FormEvent, useState } from 'react';
import { Button, Dialog, FormField, Input, Select } from '@sovereignfs/ui';
import { useLocal } from '../local/LocalProvider';
import type { LinkView } from '../trips/links';
import { LINK_TITLE_MAX, LINK_URL_MAX } from '../trips/link-format';
import { LINK_KINDS_OFFERED } from './files';
import { NOT_DONE, NO_CONNECTION, askOp } from './ops';
import styles from './Files.module.css';

/**
 * A trip's links, made and changed (DESIGN.md §10.7, §20.10): a title, an `https` address and a kind, **_Expenses in Tally_ offered first** (a Tally group's address, shown with Tally's name; with no title it is called that).
 * The app never fetches a link: the address is checked for what it is (`https` only) and opened by the person's own browser. Online operations (`link.add`, `link.update`, `link.remove`), then a sync.
 */
export function LinkDialog({
  tripId,
  open,
  link,
  initialKind,
  onClose,
}: {
  tripId: string;
  open: boolean;
  /** The link being changed; none for a new one. */
  link?: LinkView | undefined;
  /** For a new link: the kind it starts as. */
  initialKind?: 'tally' | 'other' | undefined;
  onClose: () => void;
}) {
  const local = useLocal();
  const [url, setUrl] = useState('');
  const [title, setTitle] = useState('');
  const [kind, setKind] = useState<'tally' | 'other'>('tally');
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [seen, setSeen] = useState<string | undefined>(undefined);
  // The form starts from the link, or empty, each time it is opened.
  const key = open ? `${link?.id ?? 'new'}:${initialKind ?? ''}` : undefined;
  if (key !== seen) {
    setSeen(key);
    if (open) {
      setUrl(link?.url ?? '');
      setTitle(
        link && !(link.kind === 'tally' && link.title === 'Expenses in Tally')
          ? link.title
          : (link?.title ?? ''),
      );
      setKind(link?.kind ?? initialKind ?? 'tally');
      setProblem(undefined);
      setBusy(false);
    }
  }

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setProblem(undefined);
    const fields = {
      url: url.trim(),
      kind,
      ...(title.trim() === '' ? {} : { title: title.trim() }),
    };
    const answer = link
      ? await askOp({
          op: 'link.update',
          tripId,
          linkId: link.id,
          ...fields,
          title:
            title.trim() === ''
              ? kind === 'tally'
                ? 'Expenses in Tally'
                : link.title
              : title.trim(),
        })
      : await askOp({ op: 'link.add', tripId, ...fields });
    if (!answer) setProblem(NO_CONNECTION);
    else if (!answer.ok) setProblem(answer.sentence ?? NOT_DONE);
    else {
      await local?.syncNow();
      setBusy(false);
      return onClose();
    }
    setBusy(false);
  };

  return (
    <Dialog open={open} onClose={onClose} title={link ? 'Change the link' : 'Add a link'} size="sm">
      <form className={styles.form} onSubmit={(event) => void save(event)}>
        <FormField label="Kind">
          {(field) => (
            <Select
              {...field}
              name="kind"
              value={kind}
              onChange={(event) => setKind(event.target.value as 'tally' | 'other')}
            >
              {LINK_KINDS_OFFERED.map((each) => (
                <option key={each.kind} value={each.kind}>
                  {each.label}
                </option>
              ))}
            </Select>
          )}
        </FormField>
        <FormField
          label="Address"
          hint={
            kind === 'tally'
              ? 'The address of the trip’s group in Tally. It starts with https://.'
              : 'It starts with https://.'
          }
        >
          {(field) => (
            <Input
              {...field}
              type="url"
              name="url"
              value={url}
              maxLength={LINK_URL_MAX}
              autoComplete="off"
              onChange={(event) => setUrl(event.target.value)}
            />
          )}
        </FormField>
        <FormField
          label="Title"
          hint={kind === 'tally' ? 'Left empty, it is called Expenses in Tally.' : undefined}
        >
          {(field) => (
            <Input
              {...field}
              name="title"
              value={title}
              maxLength={LINK_TITLE_MAX}
              autoComplete="off"
              onChange={(event) => setTitle(event.target.value)}
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
            {link ? 'Save' : 'Add the link'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/** Taking a link away asks first. */
export function RemoveLinkDialog({
  tripId,
  link,
  onClose,
}: {
  tripId: string;
  link: LinkView | undefined;
  onClose: () => void;
}) {
  const local = useLocal();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const remove = async () => {
    if (!link) return;
    setBusy(true);
    setProblem(undefined);
    const answer = await askOp({ op: 'link.remove', tripId, linkId: link.id });
    if (!answer) setProblem(NO_CONNECTION);
    else if (!answer.ok) setProblem(answer.sentence ?? NOT_DONE);
    else {
      await local?.syncNow();
      setBusy(false);
      return onClose();
    }
    setBusy(false);
  };
  return (
    <Dialog open={Boolean(link)} onClose={onClose} title="Remove this link?" size="sm">
      <div className={styles.form}>
        <p>
          <strong>{link?.title}</strong> will be taken off the trip for everyone.
        </p>
        {problem ? (
          <p role="alert" className={styles.problem}>
            {problem}
          </p>
        ) : null}
        <div className={styles.actions}>
          <Button variant="secondary" onClick={onClose}>
            Keep it
          </Button>
          <Button variant="destructive" disabled={busy} onClick={() => void remove()}>
            Remove the link
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
