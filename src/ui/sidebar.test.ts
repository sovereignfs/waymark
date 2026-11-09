import { describe, expect, it } from 'vitest';
import {
  DEFAULTS,
  pageKind,
  parseStored,
  stateFor,
  toggleHidden,
  toggleRail,
  type Stored,
} from './sidebar';

describe('the kind of page', () => {
  it('is home for the front address alone, and a page for everything else', () => {
    expect(pageKind('/')).toBe('home');
    for (const path of [
      '/desk',
      '/desk/abc',
      '/b/abc',
      '/b/abc/c/def',
      '/w/abc',
      '/inbox',
      '/account',
      '/boards',
      '/bogus',
    ])
      expect(pageKind(path), path).toBe('page');
  });
});

describe('the default', () => {
  it('is full on home and a rail on every other page', () => {
    expect(DEFAULTS).toEqual({ home: 'full', page: 'rail' });
    expect(stateFor('home', {})).toBe('full');
    expect(stateFor('page', {})).toBe('rail');
  });
});

describe('what was stored', () => {
  it('is read back, and a kind that was not stored keeps its default', () => {
    const stored = parseStored(JSON.stringify({ page: { state: 'hidden', shown: 'full' } }));
    expect(stateFor('page', stored)).toBe('hidden');
    expect(stateFor('home', stored)).toBe('full');
  });

  it('is ignored when it is not what was written: nothing, nonsense, or a state that does not exist', () => {
    for (const raw of [
      null,
      undefined,
      '',
      'not json',
      '[]',
      '3',
      '{"page":"rail"}',
      '{"page":{"state":"wide"}}',
    ]) {
      expect(parseStored(raw), String(raw)).toEqual({});
    }
  });

  it('remembers how a hidden one was shown, or a rail when it does not say', () => {
    expect(parseStored('{"home":{"state":"hidden"}}').home).toEqual({
      state: 'hidden',
      shown: 'rail',
    });
    expect(parseStored('{"home":{"state":"full"}}').home).toEqual({
      state: 'full',
      shown: 'full',
    });
  });
});

describe('the buttons', () => {
  it('the header’s hides it and shows it again as it was, whichever it was', () => {
    for (const kind of ['home', 'page'] as const) {
      const was = stateFor(kind, {});
      const hidden = toggleHidden(kind, {});
      expect(stateFor(kind, hidden)).toBe('hidden');
      expect(stateFor(kind, toggleHidden(kind, hidden))).toBe(was);
    }
    // A rail that was widened, then hidden, comes back wide.
    const wide = toggleRail('page', {});
    expect(stateFor('page', toggleHidden('page', toggleHidden('page', wide)))).toBe('full');
  });

  it('the sidebar’s own makes a full one a rail and a rail full, and does nothing to a hidden one', () => {
    expect(stateFor('home', toggleRail('home', {}))).toBe('rail');
    expect(stateFor('page', toggleRail('page', {}))).toBe('full');
    const hidden = toggleHidden('home', {});
    expect(toggleRail('home', hidden)).toBe(hidden);
  });

  it('change one kind of page and leave the other as it was', () => {
    const stored: Stored = toggleHidden('page', {});
    expect(stateFor('home', stored)).toBe('full');
    expect(stateFor('page', toggleRail('home', stored))).toBe('hidden');
  });
});
