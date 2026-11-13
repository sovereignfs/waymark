import { describe, expect, it } from 'vitest';
import { type Kept, forget, keepFor, keptKey, parseKept, prune } from './offline';

/** Which trips' maps the device has kept, and when they are let go of (DESIGN.md §14.5): a file only when no trip that is still wanted needs it. */
const A = ['/t/1', '/t/2', '/t/shared'];
const B = ['/t/3', '/t/shared'];
const base: Kept = keepFor(keepFor({}, 'a', A, '2026-06-10'), 'b', B, '2026-09-01');

describe('what the record holds', () => {
  it('is each trip with its files and its last day, and keeping again replaces', () => {
    expect(base.a?.urls).toEqual(A);
    expect(keepFor(base, 'a', ['/t/9'], '2026-06-11').a).toEqual({
      urls: ['/t/9'],
      endDate: '2026-06-11',
    });
    expect(Object.keys(keepFor(base, 'a', ['/t/9'], '2026-06-11'))).toEqual(['a', 'b']);
  });
});

describe('forgetting a trip', () => {
  it('lets go of the files only it needed, and keeps the ones another trip shares', () => {
    const got = forget(base, 'a');
    expect(Object.keys(got.kept)).toEqual(['b']);
    expect(got.drop.sort()).toEqual(['/t/1', '/t/2']);
  });
  it('does nothing for a trip it does not have', () => {
    expect(forget(base, 'zzz')).toEqual({ kept: base, drop: [] });
  });
});

describe('what is let go of by now', () => {
  const held = new Set(['a', 'b']);
  it('is the trips that have ended, by their last day, and not the shared files while another trip needs them', () => {
    const got = prune(base, '2026-06-11', held);
    expect(Object.keys(got.kept)).toEqual(['b']);
    expect(got.drop.sort()).toEqual(['/t/1', '/t/2']);
  });
  it('keeps a trip on its last day, and lets it go the day after', () => {
    expect(Object.keys(prune(base, '2026-06-10', held).kept)).toEqual(['a', 'b']);
    expect(Object.keys(prune(base, '2026-06-11', held).kept)).toEqual(['b']);
  });
  it('is the trips that are no longer on the device (deleted, or left), whatever their dates', () => {
    const got = prune(base, '2026-01-01', new Set(['b']));
    expect(Object.keys(got.kept)).toEqual(['b']);
    expect(got.drop.sort()).toEqual(['/t/1', '/t/2']);
  });
  it('lets go of everything when every trip has gone, and of nothing when none has', () => {
    expect(prune(base, '2027-01-01', held).drop.sort()).toEqual([
      '/t/1',
      '/t/2',
      '/t/3',
      '/t/shared',
    ]);
    expect(prune(base, '2026-01-01', held).drop).toEqual([]);
    expect(prune({}, '2026-01-01', held)).toEqual({ kept: {}, drop: [] });
  });
});

describe('the record on the device', () => {
  it('is one for each account', () => {
    expect(keptKey('a')).not.toBe(keptKey('b'));
  });
  it('is read defensively: only what was written, and nothing else', () => {
    expect(parseKept(JSON.stringify(base))).toEqual(base);
    for (const bad of [
      null,
      undefined,
      '',
      'nonsense',
      '[]',
      '3',
      '{"a":1}',
      '{"a":{"urls":[1],"endDate":"2026-01-01"}}',
      '{"a":{"urls":[],"endDate":"soon"}}',
    ])
      expect(parseKept(bad), String(bad)).toEqual({});
  });
});
