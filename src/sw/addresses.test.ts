import { describe, expect, it } from 'vitest';
import { OFFLINE_ADDRESSES, offlineAddressSources, offlineScreenOf } from './addresses';

/** The addresses the worker answers with the shell, and the screen the shell draws for each: one list (DESIGN.md §20.12; 6.4). */
describe('the addresses the offline shell answers', () => {
  it('is Home, Check-ins, a check-in, Map, Places, a place and Trips, each its screen', () => {
    expect(offlineScreenOf('/')).toBe('home');
    expect(offlineScreenOf('/home')).toBe('home');
    expect(offlineScreenOf('/checkins')).toBe('checkins');
    expect(offlineScreenOf('/c/0a1b2c3d-1111-2222-3333-444455556666')).toBe('checkins');
    expect(offlineScreenOf('/map')).toBe('map');
    expect(offlineScreenOf('/places')).toBe('places');
    expect(offlineScreenOf('/places/p_1-A')).toBe('places');
    expect(offlineScreenOf('/trips')).toBe('trips');
    expect(offlineScreenOf('/t/0a1b2c3d-1111-4222-8333-444455556666/today')).toBe('tripmode');
    expect(offlineScreenOf('/t/0a1b2c3d-1111-4222-8333-444455556666')).toBe('trip');
  });

  it('is nothing else: not Settings, notices, sign-in, the API, or a longer path', () => {
    for (const path of [
      '/settings',
      '/notifications',
      '/sign-in',
      '/api/health',
      '/shell',
      '/places/',
      '/trips/',
      '/trips/x',
      '/t',
      '/t/',
      '/t/a/b',
      '/t/a/today/x',
      '/checkins/',
      '/checkins/x',
      '/c',
      '/c/',
      '/c/a/b',
      '/c/has space',
      `/c/${'x'.repeat(65)}`,
      '/homes',
      '//',
      '',
    ])
      expect(offlineScreenOf(path), path).toBeUndefined();
  });

  it('gives the worker the very patterns the shell uses', () => {
    expect(offlineAddressSources()).toEqual(OFFLINE_ADDRESSES.map((each) => each.pattern.source));
    for (const source of offlineAddressSources()) expect(() => new RegExp(source)).not.toThrow();
  });
});
