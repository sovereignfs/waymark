import { describe, expect, it } from 'vitest';
import { ITEM_KINDS, checkItem, isTime } from './item-format';

/** What an item may be (DESIGN.md §10.5): a place or a title, a kind, times in order, fixed only with a start. */
describe('an item', () => {
  it('needs a place or a title, either alone or both', () => {
    expect(checkItem({}, false)).toMatchObject({ ok: false });
    expect(checkItem({ title: '   ' }, false)).toMatchObject({ ok: false });
    expect(checkItem({ title: 'Dinner' }, false)).toMatchObject({ ok: true });
    expect(checkItem({}, true)).toMatchObject({ ok: true });
    expect(checkItem({ title: 'Dinner' }, true)).toMatchObject({ ok: true });
  });

  it('has a kind, other when none is given, and one of the six', () => {
    expect(checkItem({ title: 'x' }, false)).toMatchObject({ ok: true, value: { kind: 'other' } });
    for (const kind of ITEM_KINDS)
      expect(checkItem({ title: 'x', kind }, false)).toMatchObject({ ok: true, value: { kind } });
    for (const kind of ['Sight', 'museum', '', 5, {}])
      expect(checkItem({ title: 'x', kind }, false), String(kind)).toMatchObject({ ok: false });
  });

  it('has times that are HH:mm, an end only with a start, and after it', () => {
    for (const good of ['00:00', '09:05', '23:59']) expect(isTime(good), good).toBe(true);
    for (const badTime of ['24:00', '9:05', '09:5', '09:60', '0905', '09:05:00', '', 905, null])
      expect(isTime(badTime), String(badTime)).toBe(false);
    expect(checkItem({ title: 'x', start: '09:00', end: '10:30' }, false)).toMatchObject({
      ok: true,
      value: { start: '09:00', end: '10:30' },
    });
    expect(checkItem({ title: 'x', start: '09:00' }, false)).toMatchObject({
      ok: true,
      value: { end: null },
    });
    expect(checkItem({ title: 'x', end: '10:00' }, false)).toMatchObject({ ok: false });
    expect(checkItem({ title: 'x', start: '10:00', end: '10:00' }, false)).toMatchObject({
      ok: false,
    });
    expect(checkItem({ title: 'x', start: '10:00', end: '09:00' }, false)).toMatchObject({
      ok: false,
    });
    expect(checkItem({ title: 'x', start: '25:00' }, false)).toMatchObject({ ok: false });
  });

  it('is fixed only with a start time, and a flexible one may have a time as a guide', () => {
    expect(checkItem({ title: 'Reservation', fixed: true }, false)).toMatchObject({ ok: false });
    expect(checkItem({ title: 'Reservation', fixed: true, end: '20:00' }, false)).toMatchObject({
      ok: false,
    });
    expect(checkItem({ title: 'Reservation', fixed: true, start: '19:00' }, false)).toMatchObject({
      ok: true,
      value: { fixed: true },
    });
    expect(checkItem({ title: 'Wander', start: '15:00' }, false)).toMatchObject({
      ok: true,
      value: { fixed: false },
    });
    expect(checkItem({ title: 'x', fixed: 'yes' }, false)).toMatchObject({ ok: false });
  });

  it('has a title of one line of at most 200 characters, and notes of at most 2,000, trimmed', () => {
    expect(checkItem({ title: 'x'.repeat(201) }, false)).toMatchObject({ ok: false });
    expect(checkItem({ title: 'a\nb' }, false)).toMatchObject({ ok: false });
    expect(checkItem({ title: 5 }, false)).toMatchObject({ ok: false });
    expect(
      checkItem({ title: '  Dinner  ', notes: '  Table for two\nby the window  ' }, false),
    ).toMatchObject({
      ok: true,
      value: { title: 'Dinner', notes: 'Table for two\nby the window' },
    });
    expect(checkItem({ title: 'x', notes: 'y'.repeat(2001) }, false)).toMatchObject({ ok: false });
    expect(checkItem({ title: 'x', notes: '   ' }, false)).toMatchObject({
      ok: true,
      value: { notes: undefined },
    });
  });

  it('says what is wrong without repeating what was typed', () => {
    const refused = checkItem({ title: 'Secret plan\nline two', start: 'nonsense' }, false);
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.sentence).not.toContain('Secret');
      expect(refused.sentence).not.toContain('nonsense');
    }
  });
});
