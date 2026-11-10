import { describe, expect, it } from 'vitest';
import { searchPlaces } from './search';

const places = [
  {
    id: 'a',
    name: 'Café Central',
    lat: 48.2104,
    lng: 16.3655,
    category: 'Cafe',
    address: { city: 'Vienna', country: 'Austria' },
  },
  {
    id: 'b',
    name: 'Central Park',
    lat: 40.7829,
    lng: -73.9654,
    category: 'Park',
    address: { city: 'New York' },
  },
  {
    id: 'c',
    name: 'Cafe Sperl',
    lat: 48.1989,
    lng: 16.3606,
    category: 'Cafe',
    address: { city: 'Vienna' },
  },
  { id: 'd', name: 'Tokyo Tower', lat: 35.6586, lng: 139.7454 },
];

describe('searching a person’s places in memory', () => {
  it('finds by every word of the query, in any order, ignoring case and accents', () => {
    expect(searchPlaces(places, 'CAFE central').map((f) => f.place.id)).toEqual(['a']);
    expect(searchPlaces(places, 'central').map((f) => f.place.id)).toEqual(['a', 'b']);
    expect(searchPlaces(places, 'tower tokyo').map((f) => f.place.id)).toEqual(['d']);
  });

  it('finds by category and by where it is, and nothing for a word that is nowhere', () => {
    expect(searchPlaces(places, 'vienna').map((f) => f.place.id)).toEqual(['a', 'c']);
    expect(searchPlaces(places, 'park').map((f) => f.place.id)).toEqual(['b']);
    expect(searchPlaces(places, 'zzz')).toEqual([]);
  });

  it('lists everything for an empty query, by name, and no more than the limit', () => {
    expect(searchPlaces(places, '').map((f) => f.place.id)).toEqual(['a', 'c', 'b', 'd']);
    expect(searchPlaces(places, '  ', { limit: 2 })).toHaveLength(2);
  });

  it('puts the nearest first when a point is known, and says how far', () => {
    const found = searchPlaces(places, 'central', { near: { lat: 40.7, lng: -74 } });
    expect(found.map((f) => f.place.id)).toEqual(['b', 'a']);
    expect(found[0]?.distance).toBeLessThan(15_000);
    expect(found[1]?.distance).toBeGreaterThan(1_000_000);
    expect(searchPlaces(places, 'central')[0]?.distance).toBeUndefined();
  });
});
