import { describe, expect, it } from 'vitest';
import { checkInHref, checkInMode, closedHref, isCheckInKey, isCheckInOpen } from './checkin';

const press = (over: Partial<Parameters<typeof isCheckInKey>[0]> = {}) =>
  isCheckInKey({
    key: 'c',
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    defaultPrevented: false,
    target: { tagName: 'BODY' },
    ...over,
  });

describe('the check-in sheet’s address', () => {
  it('is open for exactly checkin=new, and for nothing else a query can say', () => {
    expect(isCheckInOpen('checkin=new')).toBe(true);
    expect(isCheckInOpen('?checkin=new'.slice(1))).toBe(true);
    expect(isCheckInOpen('year=2026&checkin=new')).toBe(true);
    expect(isCheckInOpen(new URLSearchParams('checkin=new'))).toBe(true);
    for (const query of [
      '',
      'checkin',
      'checkin=',
      'checkin=old',
      'checkin=NEW',
      'checkin=new%20',
      'checkins=new',
      'x=checkin%3Dnew',
    ])
      expect(isCheckInOpen(query), query).toBe(false);
  });

  it('opens over the page it is on, keeping the rest of the query, and does not double itself', () => {
    expect(checkInHref('/map')).toBe('/map?checkin=new');
    expect(checkInHref('/checkins', 'year=2026&trip=a')).toBe(
      '/checkins?year=2026&trip=a&checkin=new',
    );
    expect(checkInHref('/places', 'checkin=new')).toBe('/places?checkin=new');
    expect(checkInHref('/places', 'checkin=old&x=1')).toBe('/places?checkin=new&x=1');
    expect(checkInHref('/', new URLSearchParams('a=b'))).toBe('/?a=b&checkin=new');
  });

  it('closes back to the same page with the rest of the query as it was', () => {
    expect(closedHref('/map', 'checkin=new')).toBe('/map');
    expect(closedHref('/checkins', 'year=2026&checkin=new&trip=a')).toBe(
      '/checkins?year=2026&trip=a',
    );
    expect(closedHref('/checkins', 'year=2026')).toBe('/checkins?year=2026');
    expect(closedHref('/', new URLSearchParams('checkin=new'))).toBe('/');
    for (const path of ['/', '/checkins', '/map', '/places', '/places/abc', '/settings'])
      expect(closedHref(path, new URL(checkInHref(path, 'a=1'), 'http://x').search)).toBe(
        `${path}?a=1`,
      );
  });

  it('keeps an address that is odd as it is: text is encoded and never read as a path', () => {
    expect(checkInHref('/checkins', 'q=a%26b&x=%2F..%2F')).toBe(
      '/checkins?q=a%26b&x=%2F..%2F&checkin=new',
    );
  });
});

describe('the sheet opened from Trip Mode', () => {
  const trip = '0a1b2c3d-1111-4222-8333-444455556666';
  const item = '1a2b3c4d-1111-4222-8333-444455556666';
  it('names the trip and the item the check-in is for, and puts them in the address and takes them out', () => {
    const href = checkInHref('/t/x/today', '', {
      mode: 'new',
      from: { tripId: trip, itemId: item },
    });
    expect(href).toBe(`/t/x/today?checkin=new&t=${trip}&item=${item}`);
    expect(checkInMode(href.split('?')[1] as string)).toEqual({
      mode: 'new',
      from: { tripId: trip, itemId: item },
    });
    expect(closedHref('/t/x/today', href.split('?')[1] as string)).toBe('/t/x/today');
    // The rest of the query is kept, and a plain opening has none of them.
    expect(checkInHref('/t/x/today', `view=1&t=${trip}&item=${item}`)).toBe(
      '/t/x/today?view=1&checkin=new',
    );
  });

  it('asks for nothing it is not given in full: a missing, odd or hostile id is a plain check-in', () => {
    for (const query of [
      `checkin=new&t=${trip}`,
      `checkin=new&item=${item}`,
      `checkin=new&t=${trip}&item=a/b`,
      `checkin=new&t=${trip}&item=${'x'.repeat(65)}`,
      `checkin=new&t=%3Cscript%3E&item=${item}`,
    ])
      expect(checkInMode(query), query).toEqual({ mode: 'new' });
  });

  it('does not take a trip’s or an item’s name from a page that has them for itself', () => {
    // `t` and `item` mean something only with the sheet open.
    expect(checkInMode(`t=${trip}&item=${item}`)).toBeUndefined();
    expect(closedHref('/somewhere', `t=${trip}`)).toBe(`/somewhere?t=${trip}`);
  });
});

describe('the sheet to change a check-in', () => {
  it('is checkin=edit with the id of the check-in, and nothing else asks for it', () => {
    expect(checkInMode('checkin=edit&of=abc-123')).toEqual({ mode: 'edit', id: 'abc-123' });
    expect(checkInMode('checkin=new')).toEqual({ mode: 'new' });
    expect(isCheckInOpen('checkin=edit&of=abc')).toBe(true);
    for (const query of [
      'checkin=edit',
      'checkin=edit&of=',
      'checkin=edit&of=../x',
      'checkin=edit&of=a%20b',
      'of=abc',
      'checkin=EDIT&of=abc',
      `checkin=edit&of=${'a'.repeat(65)}`,
    ])
      expect(checkInMode(query), query).toBeUndefined();
  });

  it('opens over the page and closes back, the rest of the query kept, and one mode does not leave the other’s id behind', () => {
    expect(checkInHref('/c/abc', 'year=2026', { mode: 'edit', id: 'abc' })).toBe(
      '/c/abc?year=2026&checkin=edit&of=abc',
    );
    expect(checkInHref('/c/abc', 'checkin=edit&of=old', { mode: 'new' })).toBe(
      '/c/abc?checkin=new',
    );
    expect(closedHref('/c/abc', 'year=2026&checkin=edit&of=abc')).toBe('/c/abc?year=2026');
  });
});

describe('the C key', () => {
  it('is a request to check in, upper or lower case, anywhere that is not a place to type', () => {
    expect(press()).toBe(true);
    expect(press({ key: 'C' })).toBe(true);
    expect(press({ target: null })).toBe(true);
    expect(press({ target: { tagName: 'A' } })).toBe(true);
    expect(press({ target: { tagName: 'BUTTON' } })).toBe(true);
  });

  it('is not one while the person is typing, whatever they are typing in', () => {
    for (const tagName of ['INPUT', 'TEXTAREA', 'SELECT', 'input'])
      expect(press({ target: { tagName } }), tagName).toBe(false);
    expect(press({ target: { tagName: 'DIV', isContentEditable: true } })).toBe(false);
    expect(
      press({
        target: {
          tagName: 'SPAN',
          closest: (s: string) => (s.includes('role="textbox"') ? {} : null),
        },
      }),
    ).toBe(false);
    expect(press({ target: { tagName: 'LI', closest: () => null } })).toBe(true);
  });

  it('is not one with a modifier, which is the browser’s (copy), or when it was already taken, or held down, or another key', () => {
    expect(press({ ctrlKey: true })).toBe(false);
    expect(press({ metaKey: true })).toBe(false);
    expect(press({ altKey: true })).toBe(false);
    expect(press({ defaultPrevented: true })).toBe(false);
    expect(press({ repeat: true })).toBe(false);
    for (const key of ['v', 'Enter', 'Escape', ' ', 'cc', ''])
      expect(press({ key }), key).toBe(false);
  });
});
