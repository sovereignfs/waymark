import { describe, expect, it } from 'vitest';
import {
  SAME_PLACE_METRES,
  distanceMetres,
  findSamePlace,
  isSamePlace,
  normalizeName,
} from './match';

/** A point `metres` due north of another: one degree of latitude is 111.195 km on the sphere the distance is measured on. */
const northOf = (lat: number, lng: number, metres: number) => ({
  lat: lat + metres / 111_194.93,
  lng,
});

const CAFE = { name: 'Café de Flore', lat: 48.854, lng: 2.3326, source: 'osm', sourceId: 'node/1' };

describe('distance', () => {
  it('is the great-circle distance in metres, at the equator, near the poles and across the date line', () => {
    expect(distanceMetres({ lat: 0, lng: 0 }, { lat: 0, lng: 0 })).toBe(0);
    expect(distanceMetres({ lat: 0, lng: 0 }, { lat: 1, lng: 0 })).toBeCloseTo(111_195, -1);
    // London to Paris, about 344 km.
    expect(
      distanceMetres({ lat: 51.5074, lng: -0.1278 }, { lat: 48.8566, lng: 2.3522 }) / 1000,
    ).toBeCloseTo(343.6, 0);
    // Either side of the date line is a few kilometres, not 40 000.
    expect(distanceMetres({ lat: -16.5, lng: 179.99 }, { lat: -16.5, lng: -179.99 })).toBeLessThan(
      3_000,
    );
    expect(distanceMetres({ lat: 89.9999, lng: 0 }, { lat: 89.9999, lng: 180 })).toBeLessThan(25);
  });
});

describe('a name, as it is compared', () => {
  it('ignores case, accents, punctuation and spacing, and nothing that makes two names differ', () => {
    expect(normalizeName("  Café de l'Ouest ")).toBe('cafe de l ouest');
    expect(normalizeName('CAFE DE L’OUEST')).toBe('cafe de l ouest');
    expect(normalizeName('Cafe  Nord')).not.toBe(normalizeName('Cafe Sud'));
    expect(normalizeName('東京タワー')).toBe('東京タワー');
    expect(normalizeName('—')).toBe('');
  });
});

describe('the same place', () => {
  it('is the same source and id, wherever the name and the point have drifted to', () => {
    expect(isSamePlace(CAFE, { ...CAFE, name: 'Flore', lat: 10, lng: 10 })).toBe(true);
  });

  it('is not the same id of another source: a Swarm id and an OpenStreetMap id are different things', () => {
    expect(
      isSamePlace(
        { ...CAFE, name: 'One', lat: 1, lng: 1 },
        { ...CAFE, name: 'Two', lat: 50, lng: 50, source: 'import' },
      ),
    ).toBe(false);
  });

  it('is the same name within 50 metres, spelled as the person or the provider spelled it', () => {
    const near = northOf(CAFE.lat, CAFE.lng, 30);
    expect(isSamePlace({ name: 'Cafe de Flore', ...near }, CAFE)).toBe(true);
    expect(SAME_PLACE_METRES).toBe(50);
  });

  it('is not two cafés of one name 60 metres apart', () => {
    const far = northOf(CAFE.lat, CAFE.lng, 60);
    expect(
      isSamePlace({ name: CAFE.name, ...far }, { name: CAFE.name, lat: CAFE.lat, lng: CAFE.lng }),
    ).toBe(false);
  });

  it('is not a different name at the same point, nor a place with no name at all', () => {
    expect(isSamePlace({ name: 'Les Deux Magots', lat: CAFE.lat, lng: CAFE.lng }, CAFE)).toBe(
      false,
    );
    expect(isSamePlace({ name: '', lat: 1, lng: 1 }, { name: '', lat: 1, lng: 1 })).toBe(false);
  });

  it('is found among a person’s places: the source id first, otherwise the nearest of the name', () => {
    const mine = [
      { id: 'far', name: CAFE.name, ...northOf(CAFE.lat, CAFE.lng, 45) },
      { id: 'near', name: CAFE.name, ...northOf(CAFE.lat, CAFE.lng, 10) },
      { id: 'other', name: 'Les Deux Magots', lat: CAFE.lat, lng: CAFE.lng },
      { id: 'sourced', name: 'Somewhere else', lat: 0, lng: 0, source: 'osm', sourceId: 'node/9' },
    ];
    expect(findSamePlace({ name: 'café de flore', lat: CAFE.lat, lng: CAFE.lng }, mine)?.id).toBe(
      'near',
    );
    expect(
      findSamePlace({ name: 'Anything', lat: 5, lng: 5, source: 'osm', sourceId: 'node/9' }, mine)
        ?.id,
    ).toBe('sourced');
    expect(
      findSamePlace({ name: CAFE.name, ...northOf(CAFE.lat, CAFE.lng, 200) }, mine),
    ).toBeUndefined();
    expect(findSamePlace({ name: CAFE.name, lat: CAFE.lat, lng: CAFE.lng }, [])).toBeUndefined();
  });
});
