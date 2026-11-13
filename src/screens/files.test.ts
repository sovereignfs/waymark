import { describe, expect, it } from 'vitest';
import type { DayRecord, StopRecord } from '../sync/trip-format';
import type { AttachmentView } from '../trips/attachments';
import { LINK_KINDS_OFFERED, groupFiles, sizeText, typeText } from './files';

/** A trip's Files (DESIGN.md §10.6, §20.10) without a browser: the attachments by day and kind. */
const stop = (id: string, name: string, arrive: string, depart: string): StopRecord =>
  ({
    id,
    place: { id: `p${id}`, name, lat: 0, lng: 0, tz: 'Europe/Lisbon', countryCode: 'PT' },
    arrive,
    depart,
    position: id,
    version: 1,
  }) as unknown as StopRecord;
const day = (id: string, stopId: string, date: string): DayRecord => ({
  id,
  stopId,
  date,
  title: undefined,
  notes: undefined,
  version: 1,
});
const file = (
  id: string,
  title: string,
  kind: AttachmentView['kind'],
  dayId: string | null,
): AttachmentView => ({
  id,
  dayId,
  kind,
  title,
  fileId: `f-${id}`,
  thumbId: null,
  type: 'application/pdf',
  bytes: 1000,
  createdBy: null,
  createdAt: 1,
  seq: 1,
});
const stops = [
  stop('b', 'Sintra', '2026-06-12', '2026-06-13'),
  stop('a', 'Lisbon', '2026-06-10', '2026-06-11'),
];
const days = [
  day('d11', 'a', '2026-06-11'),
  day('d10', 'a', '2026-06-10'),
  day('e12', 'b', '2026-06-12'),
];

describe('the files of a trip', () => {
  it('are the trip’s first, then each day’s in the order of the trip, each by kind and then title', () => {
    const got = groupFiles(
      [
        file('1', 'Pena ticket', 'ticket', 'e12'),
        file('2', 'Hotel', 'accommodation', null),
        file('3', 'Flight', 'booking', null),
        file('4', 'Lunch', 'receipt', 'd10'),
        file('5', 'Dinner', 'receipt', 'd10'),
        file('6', 'Airport taxi', 'other', 'd10'),
      ],
      stops,
      days,
    );
    expect(got.map((group) => group.label.split(' · ')[0])).toEqual([
      'On the trip',
      expect.stringContaining('Wed 10 Jun'),
      expect.stringContaining('Fri 12 Jun'),
    ]);
    expect(got[0]?.files.map((f) => f.title)).toEqual(['Flight', 'Hotel']);
    expect(got[1]?.files.map((f) => f.title)).toEqual(['Dinner', 'Lunch', 'Airport taxi']);
    expect(got[2]?.files.map((f) => f.title)).toEqual(['Pena ticket']);
  });

  it('are nothing when there are none, and a group is only there when it has a file', () => {
    expect(groupFiles([], stops, days)).toEqual([]);
    expect(groupFiles([file('1', 'x', 'other', 'd11')], stops, days)).toHaveLength(1);
  });

  it('keep a file on a day the device does not hold in view, and do not lose it', () => {
    const got = groupFiles([file('1', 'Orphan', 'other', 'gone')], stops, days);
    expect(got).toHaveLength(1);
    expect(got[0]?.files[0]?.title).toBe('Orphan');
  });
});

describe('words', () => {
  it('say a size as a person reads it, and a type as what it is', () => {
    expect(sizeText(512)).toBe('512 B');
    expect(sizeText(2048)).toBe('2 KB');
    expect(sizeText(3.4 * 1024 * 1024)).toBe('3.4 MB');
    expect(typeText('application/pdf')).toBe('PDF');
    expect(typeText('image/webp')).toBe('Image');
    expect(typeText('text/html')).toBe('File');
  });
  it('offer Expenses in Tally first among the links', () => {
    expect(LINK_KINDS_OFFERED[0]).toEqual({ kind: 'tally', label: 'Expenses in Tally' });
  });
});
