import type { IconName } from '@sovereignfs/ui';
import type { AttachmentView } from '../trips/attachments';
import { ATTACHMENT_KINDS, type AttachmentKind } from '../trips/attachment-format';
import type { DayRecord, StopRecord } from '../sync/trip-format';
import { dayChoices } from './plan';

/**
 * A trip's Files (DESIGN.md §10.6, §20.10), apart from how they look: the attachments **by day and kind**, and the words for a file's type and size. Pure, from the rows the device holds (`TripSets.attachments`, which a Follower is
 * never given: for one the list is empty and the view does not exist). An attachment on the trip comes first, then those on each day in the order of the trip's days; within a group by kind (receipt, booking, accommodation,
 * ticket, other), then title.
 */
export const KIND_LABEL: Readonly<Record<AttachmentKind, string>> = {
  receipt: 'Receipt',
  booking: 'Booking',
  accommodation: 'Accommodation',
  ticket: 'Ticket',
  other: 'Other',
};
export const KIND_ICON: Readonly<Record<AttachmentKind, IconName>> = {
  receipt: 'file-text',
  booking: 'calendar',
  accommodation: 'house',
  ticket: 'file',
  other: 'file',
};
export { ATTACHMENT_KINDS };

export interface FileGroup {
  /** `null` for the trip itself. */
  readonly dayId: string | null;
  readonly label: string;
  readonly files: readonly AttachmentView[];
}

export function groupFiles(
  attachments: readonly AttachmentView[],
  stops: readonly StopRecord[],
  days: readonly DayRecord[],
): FileGroup[] {
  const order = new Map(ATTACHMENT_KINDS.map((kind, index) => [kind, index]));
  const sorted = (files: readonly AttachmentView[]) =>
    [...files].sort(
      (a, b) =>
        (order.get(a.kind) ?? 0) - (order.get(b.kind) ?? 0) ||
        a.title.localeCompare(b.title) ||
        a.id.localeCompare(b.id),
    );
  const groups: FileGroup[] = [];
  const onTrip = attachments.filter((file) => file.dayId === null);
  if (onTrip.length > 0) groups.push({ dayId: null, label: 'On the trip', files: sorted(onTrip) });
  for (const choice of dayChoices(stops, days)) {
    const here = attachments.filter((file) => file.dayId === choice.id);
    if (here.length > 0)
      groups.push({ dayId: choice.id, label: choice.label, files: sorted(here) });
  }
  // A file on a day this device does not hold (the day was removed): kept in view, on the trip’s side, rather than lost.
  const known = new Set(days.map((day) => day.id));
  const stray = attachments.filter((file) => file.dayId !== null && !known.has(file.dayId));
  if (stray.length > 0) groups.push({ dayId: null, label: 'Other', files: sorted(stray) });
  return groups;
}

/** A size as a person reads it: "812 KB", "3.4 MB". */
export function sizeText(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** What a file is called for a person: a PDF, or a photo. */
export function typeText(type: string): string {
  if (type === 'application/pdf') return 'PDF';
  if (type.startsWith('image/')) return 'Image';
  return 'File';
}

/** The kinds of link a person can add, **Expenses in Tally first** (DESIGN.md §10.7). */
export const LINK_KINDS_OFFERED: readonly { kind: 'tally' | 'other'; label: string }[] = [
  { kind: 'tally', label: 'Expenses in Tally' },
  { kind: 'other', label: 'Another link' },
];
