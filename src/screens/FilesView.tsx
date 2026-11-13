'use client';

import { type FormEvent, useMemo, useState } from 'react';
import {
  Badge,
  Button,
  Dialog,
  EmptyState,
  FileDropzone,
  FormField,
  Icon,
  Input,
  Select,
} from '@sovereignfs/ui';
import { useLocal } from '../local/LocalProvider';
import type { TripData } from '../local/store';
import type { AttachmentView } from '../trips/attachments';
import {
  ATTACHMENT_KINDS,
  ATTACHMENT_TITLE_MAX,
  type AttachmentKind,
} from '../trips/attachment-format';
import { KIND_ICON, KIND_LABEL, groupFiles, sizeText, typeText } from './files';
import { NOT_DONE, NO_CONNECTION, askOp } from './ops';
import { dayChoices } from './plan';
import styles from './Files.module.css';

const MAX_MB = 15;

/** The sentence for an upload the server answered with a status. */
async function sentenceOf(reply: Response): Promise<string> {
  if (reply.status === 404) return 'This trip is not here, or you may not add files to it.';
  if (reply.status === 429) return 'Too many files at once. Try again in a minute.';
  try {
    const body = (await reply.json()) as { message?: string };
    if (body.message) return body.message;
  } catch {
    // No sentence in the body: the generic one below.
  }
  return 'That file could not be added.';
}

/** A file's own title, from its name, without the extension: what the title field starts as. */
const titleOfName = (name: string): string =>
  name.replace(/\.[^./\\]+$/, '').slice(0, ATTACHMENT_TITLE_MAX);

/**
 * The Files (DESIGN.md §10.6, §20.10): a trip's attachments **by day and kind**, upload by choosing or dropping (`FileDropzone`), open in a new tab or download, rename (title, kind, day) and delete. **The view does not
 * exist for a Follower** (`viewsFor`): bookings carry names, numbers and addresses, and the device is never given one for them. Uploads and changes are online (§15.7) and the answer is pulled into the device at once.
 */
export function FilesView({ tripId, data }: { tripId: string; data: TripData }) {
  const local = useLocal();
  const sets = data.sets;
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState('');
  const [kind, setKind] = useState<AttachmentKind>('other');
  const [dayId, setDayId] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const [editing, setEditing] = useState<AttachmentView | undefined>(undefined);
  const [deleting, setDeleting] = useState<AttachmentView | undefined>(undefined);

  const attachments = sets?.attachments ?? [];
  const groups = useMemo(
    () => (sets ? groupFiles(attachments, sets.stops, data.days) : []),
    [sets, attachments, data.days],
  );
  const days = useMemo(() => (sets ? dayChoices(sets.stops, data.days) : []), [sets, data.days]);
  if (!sets) return null;

  const upload = async (event: FormEvent) => {
    event.preventDefault();
    if (!file || busy) return;
    if (title.trim() === '') return setProblem('Give the file a title.');
    if (file.size > MAX_MB * 1024 * 1024) return setProblem(`A file is at most ${MAX_MB} MB.`);
    setBusy(true);
    setProblem(undefined);
    try {
      const query = new URLSearchParams({ kind, ...(dayId ? { day: dayId } : {}) });
      const reply = await fetch(`/api/trips/${tripId}/attachments?${query}`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'content-type': file.type || 'application/octet-stream',
          'x-attachment-title': encodeURIComponent(title.trim()),
        },
        body: file,
      });
      if (!reply.ok) setProblem(await sentenceOf(reply));
      else {
        await local?.syncNow();
        setFile(null);
        setTitle('');
      }
    } catch {
      setProblem(NO_CONNECTION);
    }
    setBusy(false);
  };

  return (
    <div className={styles.files}>
      <form
        className={styles.upload}
        onSubmit={(event) => void upload(event)}
        aria-label="Add a file"
      >
        <FileDropzone
          ariaLabel="Choose a file to add, or drop it here"
          label={file ? file.name : 'Choose a PDF or a photo'}
          hint={file ? sizeText(file.size) : `or drop it here, up to ${MAX_MB} MB`}
          accept="application/pdf,image/*"
          onFileSelect={(next) => {
            setFile(next);
            setProblem(undefined);
            if (next && title.trim() === '') setTitle(titleOfName(next.name));
          }}
        />
        {file ? (
          <>
            <FormField label="Title">
              {(field) => (
                <Input
                  {...field}
                  name="title"
                  value={title}
                  maxLength={ATTACHMENT_TITLE_MAX}
                  autoComplete="off"
                  onChange={(event) => setTitle(event.target.value)}
                />
              )}
            </FormField>
            <div className={styles.row2}>
              <FormField label="Kind">
                {(field) => (
                  <Select
                    {...field}
                    name="kind"
                    value={kind}
                    onChange={(event) => setKind(event.target.value as AttachmentKind)}
                  >
                    {ATTACHMENT_KINDS.map((each) => (
                      <option key={each} value={each}>
                        {KIND_LABEL[each]}
                      </option>
                    ))}
                  </Select>
                )}
              </FormField>
              <FormField label="On">
                {(field) => (
                  <Select
                    {...field}
                    name="day"
                    value={dayId}
                    onChange={(event) => setDayId(event.target.value)}
                  >
                    <option value="">The trip</option>
                    {days.map((each) => (
                      <option key={each.id} value={each.id}>
                        {each.label}
                      </option>
                    ))}
                  </Select>
                )}
              </FormField>
            </div>
            <div className={styles.actions}>
              <Button type="button" variant="secondary" onClick={() => setFile(null)}>
                Cancel
              </Button>
              <Button type="submit" disabled={busy}>
                {busy ? 'Adding…' : 'Add the file'}
              </Button>
            </div>
          </>
        ) : null}
        {problem ? (
          <p role="alert" className={styles.problem}>
            {problem}
          </p>
        ) : null}
      </form>

      {groups.length === 0 ? (
        <EmptyState
          icon="file"
          heading="No files yet"
          description="Bookings, tickets and receipts for the trip, or for one of its days, are kept here for the people going."
        />
      ) : (
        groups.map((group) => (
          <section
            key={group.dayId ?? group.label}
            className={styles.group}
            aria-label={group.label}
          >
            <h2>{group.label}</h2>
            <ul className={styles.list}>
              {group.files.map((each) => (
                <li key={each.id} className={styles.file} data-file={each.id}>
                  {each.thumbId ? (
                    <img
                      className={styles.thumb}
                      src={`/api/media/${each.thumbId}`}
                      alt=""
                      loading="lazy"
                    />
                  ) : (
                    <span className={styles.icon}>
                      <Icon name={KIND_ICON[each.kind]} aria-hidden />
                    </span>
                  )}
                  <span className={styles.main}>
                    <span className={styles.name}>{each.title}</span>
                    <span className={styles.muted}>
                      {typeText(each.type)} · {sizeText(each.bytes)}
                    </span>
                  </span>
                  <Badge size="xs" variant="role" uppercase={false}>
                    {KIND_LABEL[each.kind]}
                  </Badge>
                  <span className={styles.rowActions}>
                    <a
                      className={styles.link}
                      href={`/api/media/${each.fileId}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      aria-label={`Open ${each.title}`}
                    >
                      Open
                    </a>
                    <a
                      className={styles.link}
                      href={`/api/media/${each.fileId}`}
                      download={each.title}
                      aria-label={`Download ${each.title}`}
                    >
                      Download
                    </a>
                    <Button
                      variant="ghost"
                      aria-label={`Edit ${each.title}`}
                      onClick={() => setEditing(each)}
                    >
                      <Icon name="pencil" aria-hidden />
                    </Button>
                    <Button
                      variant="ghost"
                      aria-label={`Delete ${each.title}`}
                      onClick={() => setDeleting(each)}
                    >
                      <Icon name="trash-2" aria-hidden />
                    </Button>
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ))
      )}

      <EditDialog
        tripId={tripId}
        file={editing}
        days={days}
        onClose={() => setEditing(undefined)}
      />
      <DeleteDialog tripId={tripId} file={deleting} onClose={() => setDeleting(undefined)} />
    </div>
  );
}

/** A file’s title, kind and day: `attachment.update`, then a sync. */
function EditDialog({
  tripId,
  file,
  days,
  onClose,
}: {
  tripId: string;
  file: AttachmentView | undefined;
  days: { id: string; label: string }[];
  onClose: () => void;
}) {
  const local = useLocal();
  const [title, setTitle] = useState('');
  const [kind, setKind] = useState<AttachmentKind>('other');
  const [dayId, setDayId] = useState('');
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [seen, setSeen] = useState<string | undefined>(undefined);
  if (file && file.id !== seen) {
    setSeen(file.id);
    setTitle(file.title);
    setKind(file.kind);
    setDayId(file.dayId ?? '');
    setProblem(undefined);
    setBusy(false);
  }
  if (!file && seen) setSeen(undefined);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!file) return;
    if (title.trim() === '') return setProblem('Give the file a title.');
    setBusy(true);
    const answer = await askOp({
      op: 'attachment.update',
      tripId,
      attachmentId: file.id,
      title: title.trim(),
      kind,
      dayId: dayId === '' ? null : dayId,
    });
    if (!answer) setProblem(NO_CONNECTION);
    else if (!answer.ok) setProblem(answer.sentence ?? NOT_DONE);
    else {
      await local?.syncNow();
      return onClose();
    }
    setBusy(false);
  };

  return (
    <Dialog open={Boolean(file)} onClose={onClose} title="Change the file" size="sm">
      <form className={styles.form} onSubmit={(event) => void save(event)}>
        <FormField label="Title">
          {(field) => (
            <Input
              {...field}
              name="title"
              value={title}
              maxLength={ATTACHMENT_TITLE_MAX}
              autoComplete="off"
              onChange={(event) => setTitle(event.target.value)}
            />
          )}
        </FormField>
        <div className={styles.row2}>
          <FormField label="Kind">
            {(field) => (
              <Select
                {...field}
                name="kind"
                value={kind}
                onChange={(event) => setKind(event.target.value as AttachmentKind)}
              >
                {ATTACHMENT_KINDS.map((each) => (
                  <option key={each} value={each}>
                    {KIND_LABEL[each]}
                  </option>
                ))}
              </Select>
            )}
          </FormField>
          <FormField label="On">
            {(field) => (
              <Select
                {...field}
                name="day"
                value={dayId}
                onChange={(event) => setDayId(event.target.value)}
              >
                <option value="">The trip</option>
                {days.map((each) => (
                  <option key={each.id} value={each.id}>
                    {each.label}
                  </option>
                ))}
              </Select>
            )}
          </FormField>
        </div>
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
            Save
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/** Deleting a file asks first: the file goes with the row. */
function DeleteDialog({
  tripId,
  file,
  onClose,
}: {
  tripId: string;
  file: AttachmentView | undefined;
  onClose: () => void;
}) {
  const local = useLocal();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const remove = async () => {
    if (!file) return;
    setBusy(true);
    setProblem(undefined);
    const answer = await askOp({ op: 'attachment.delete', tripId, attachmentId: file.id });
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
    <Dialog open={Boolean(file)} onClose={onClose} title="Delete this file?" size="sm">
      <div className={styles.form}>
        <p>
          <strong>{file?.title}</strong> will be deleted for everyone in the trip. This cannot be
          undone.
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
            Delete the file
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
