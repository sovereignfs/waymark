import { afterEach, describe, expect, it, vi } from 'vitest';
import { goTo } from './checkin-location';

/** `goTo` changes the address in the page, and only to a path of this app. */
function fakeWindow() {
  const calls: string[][] = [];
  vi.stubGlobal('window', {
    location: { pathname: '/checkins', search: '' },
    history: {
      pushState: (_s: unknown, _t: string, url: string) => calls.push(['push', url]),
      replaceState: (_s: unknown, _t: string, url: string) => calls.push(['replace', url]),
    },
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  });
  return calls;
}
afterEach(() => vi.unstubAllGlobals());

describe('going to an address in the page', () => {
  it('pushes or replaces a path of the app, and says it did', () => {
    const calls = fakeWindow();
    expect(goTo('/c/abc?year=2026')).toBe(true);
    expect(goTo('/checkins', 'replace')).toBe(true);
    expect(calls).toEqual([
      ['push', '/c/abc?year=2026'],
      ['replace', '/checkins'],
    ]);
  });

  it('refuses another site, a whole address, a protocol-relative one and anything that is not a path, and does nothing', () => {
    const calls = fakeWindow();
    for (const url of [
      'https://evil.example/',
      '//evil.example/x',
      'javascript:alert(1)',
      'c/abc',
      '',
      ' /x',
      '\\\\evil',
    ])
      expect(goTo(url), url).toBe(false);
    expect(calls).toEqual([]);
  });
});
