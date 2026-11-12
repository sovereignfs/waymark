import { describe, expect, it } from 'vitest';
import { directionsLink, nameFor, platformOf } from './directions';

/** Directions (DESIGN.md §14.3): the link for each kind of device, and a place's name never able to change what the link is. */
const POINT = { lat: 35.0394, lng: 135.7292, name: 'Kinkaku-ji' };

describe('which device', () => {
  it('is Android by its agent, Apple for an iPhone or iPad, and an iPad that says it is a Mac by its touch screen', () => {
    expect(platformOf({ userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/126' })).toBe(
      'android',
    );
    expect(
      platformOf({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X)' }),
    ).toBe('apple');
    expect(platformOf({ userAgent: 'Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X)' })).toBe(
      'apple',
    );
    expect(
      platformOf({
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
        platform: 'MacIntel',
        maxTouchPoints: 5,
      }),
    ).toBe('apple');
    // A Mac with no touch screen is a Mac.
    expect(
      platformOf({
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
        platform: 'MacIntel',
        maxTouchPoints: 0,
      }),
    ).toBe('other');
    expect(
      platformOf({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', platform: 'Win32' }),
    ).toBe('other');
    expect(platformOf({})).toBe('other');
  });
});

describe('the link', () => {
  it('is geo: on Android, with the point and the name', () => {
    expect(directionsLink('android', POINT)).toBe(
      'geo:35.0394,135.7292?q=35.0394,135.7292(Kinkaku-ji)',
    );
    expect(directionsLink('android', { lat: 1, lng: 2 })).toBe('geo:1,2?q=1,2');
  });
  it('is maps:// on iPhone and iPad', () => {
    expect(directionsLink('apple', POINT)).toBe('maps://?daddr=35.0394,135.7292&q=Kinkaku-ji');
    expect(directionsLink('apple', { lat: -33.8688, lng: 151.2093 })).toBe(
      'maps://?daddr=-33.8688,151.2093',
    );
  });
  it('is an OpenStreetMap directions link anywhere else, which opens in a browser', () => {
    const link = directionsLink('other', POINT) as string;
    expect(link).toBe('https://www.openstreetmap.org/directions?route=%3B35.0394%2C135.7292');
    expect(new URL(link).searchParams.get('route')).toBe(';35.0394,135.7292');
  });
  it('keeps the point to a metre or so and refuses a point that is not one', () => {
    expect(directionsLink('android', { lat: 1.123456789, lng: 2.987654321 })).toBe(
      'geo:1.12346,2.98765?q=1.12346,2.98765',
    );
    for (const bad of [
      { lat: 91, lng: 0 },
      { lat: 0, lng: 181 },
      { lat: Number.NaN, lng: 0 },
      { lat: 0, lng: Number.POSITIVE_INFINITY },
      { lat: '1' as unknown as number, lng: 2 },
    ])
      for (const platform of ['android', 'apple', 'other'] as const)
        expect(directionsLink(platform, bad), JSON.stringify(bad)).toBeUndefined();
  });
});

describe('a name', () => {
  it('cannot add a parameter, a scheme or a line to the link', () => {
    const hostile = 'Cafe) &daddr=0,0&x=1 \n javascript:alert(1) #?/\\';
    for (const platform of ['android', 'apple', 'other'] as const) {
      const link = directionsLink(platform, { lat: 1, lng: 2, name: hostile }) as string;
      expect(link).not.toMatch(/[\r\n ]/);
    }
    const apple = directionsLink('apple', { lat: 1, lng: 2, name: hostile }) as string;
    expect([...new URL(apple).searchParams.keys()]).toEqual(['daddr', 'q']);
    const android = directionsLink('android', { lat: 1, lng: 2, name: hostile }) as string;
    expect(android.match(/\(/g)).toHaveLength(1);
    expect(android.endsWith(')')).toBe(true);
  });
  it('is one line of at most a hundred characters, with no control characters, and kept as written otherwise', () => {
    expect(nameFor('  Café de Flore  ')).toBe('Café de Flore');
    expect(nameFor('a\u0000b\u007fc\u009fd')).toBe('abcd');
    expect(nameFor('x'.repeat(300))).toHaveLength(100);
    expect(nameFor(undefined)).toBe('');
    expect(directionsLink('apple', { lat: 1, lng: 2, name: '京都 (Kyoto) & friends' })).toBe(
      'maps://?daddr=1,2&q=%E4%BA%AC%E9%83%BD%20Kyoto%20%26%20friends',
    );
  });
});
