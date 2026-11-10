import { describe, expect, it } from 'vitest';
import { FAKE_PLACES } from './fake';
import {
  categoryWords,
  isAnswer,
  readReverse,
  readSearch,
  reverseUrl,
  searchUrl,
} from './providers';

const nominatim = (items: unknown) => JSON.stringify(items);
const photon = (features: unknown) => JSON.stringify({ type: 'FeatureCollection', features });

describe('Nominatim’s answer', () => {
  const body = nominatim([
    {
      osm_type: 'node',
      osm_id: 42,
      lat: '48.854',
      lon: '2.3326',
      type: 'cafe',
      name: 'Café de Flore',
      display_name: 'Café de Flore, Paris, France',
      address: {
        road: 'Boulevard Saint-Germain',
        house_number: '172',
        city: 'Paris',
        state: 'Île-de-France',
        country: 'France',
        country_code: 'fr',
        postcode: '75006',
      },
    },
  ]);

  it('is read as a candidate: name, point, address in parts, category and OpenStreetMap’s own id', () => {
    expect(readSearch('nominatim', body)).toEqual([
      {
        name: 'Café de Flore',
        lat: 48.854,
        lng: 2.3326,
        address: {
          street: 'Boulevard Saint-Germain 172',
          city: 'Paris',
          region: 'Île-de-France',
          country: 'France',
          countryCode: 'FR',
          postalCode: '75006',
        },
        category: 'Cafe',
        source: 'osm',
        sourceId: 'node/42',
      },
    ]);
  });

  it('names an address by what it is, a town by its parts, and takes nothing without a point or an id', () => {
    const [candidate] = readSearch(
      'nominatim',
      nominatim([
        {
          osm_type: 'way',
          osm_id: 7,
          lat: '38.71',
          lon: '-9.14',
          type: 'house',
          name: '',
          address: { road: 'Rua Augusta', house_number: '12', town: 'Lisboa', country_code: 'pt' },
        },
      ]),
    );
    expect(candidate).toMatchObject({
      name: 'Rua Augusta 12',
      address: { city: 'Lisboa', countryCode: 'PT' },
    });
    expect(
      readSearch(
        'nominatim',
        nominatim([
          { osm_type: 'node', osm_id: 1, lat: 'x', lon: '1', name: 'No point' },
          { osm_type: 'node', osm_id: 2, lat: '91', lon: '1', name: 'Off the globe' },
          { osm_type: 'thing', osm_id: 3, lat: '1', lon: '1', name: 'No kind' },
          { osm_type: 'node', osm_id: 0, lat: '1', lon: '1', name: 'No id' },
          'text',
          null,
          { osm_type: 'node', osm_id: 4, lat: '1', lon: '1' },
        ]),
      ),
    ).toEqual([]);
  });

  it('is never more than eight, and an answer that is not one is none', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({
      osm_type: 'node',
      osm_id: i + 1,
      lat: '1',
      lon: '1',
      name: `P${i}`,
    }));
    expect(readSearch('nominatim', nominatim(many))).toHaveLength(8);
    expect(readSearch('nominatim', '<html>')).toEqual([]);
    expect(readSearch('nominatim', '{"error":"x"}')).toEqual([]);
    expect(isAnswer('nominatim', '<html>')).toBe(false);
    expect(isAnswer('nominatim', '[]')).toBe(true);
  });

  it('reads a reverse lookup, and an error object as nothing there', () => {
    expect(readReverse('nominatim', JSON.stringify(JSON.parse(body)[0]))?.sourceId).toBe('node/42');
    expect(readReverse('nominatim', '{"error":"Unable to geocode"}')).toBeUndefined();
    expect(isAnswer('nominatim', '{"error":"Unable to geocode"}')).toBe(true);
  });
});

describe('Photon’s answer', () => {
  it('is the same candidate as Nominatim’s for the same place, so a place found by either is the same place', () => {
    const feature = {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [2.3326, 48.854] },
      properties: {
        osm_type: 'N',
        osm_id: 42,
        osm_key: 'amenity',
        osm_value: 'cafe',
        name: 'Café de Flore',
        street: 'Boulevard Saint-Germain',
        housenumber: '172',
        city: 'Paris',
        state: 'Île-de-France',
        country: 'France',
        countrycode: 'FR',
        postcode: '75006',
      },
    };
    const [fromPhoton] = readSearch('photon', photon([feature]));
    const [fromNominatim] = readSearch(
      'nominatim',
      nominatim([
        {
          osm_type: 'node',
          osm_id: 42,
          lat: '48.854',
          lon: '2.3326',
          type: 'cafe',
          name: 'Café de Flore',
          address: {
            road: 'Boulevard Saint-Germain',
            house_number: '172',
            city: 'Paris',
            state: 'Île-de-France',
            country: 'France',
            country_code: 'fr',
            postcode: '75006',
          },
        },
      ]),
    );
    expect(fromPhoton).toEqual(fromNominatim);
    expect(readReverse('photon', photon([feature]))?.name).toBe('Café de Flore');
    expect(readReverse('photon', photon([]))).toBeUndefined();
  });

  it('takes nothing that is not a feature with a point, and an answer that is not a collection is not an answer', () => {
    expect(
      readSearch(
        'photon',
        photon([
          { type: 'Feature' },
          {
            geometry: { coordinates: ['a', 1] },
            properties: { osm_type: 'N', osm_id: 1, name: 'x' },
          },
          3,
        ]),
      ),
    ).toEqual([]);
    expect(isAnswer('photon', '[]')).toBe(false);
    expect(isAnswer('photon', '{"features":[]}')).toBe(true);
  });
});

describe('what is asked', () => {
  it('encodes a search so that what a person typed is one value, whatever it holds', () => {
    const asked = new URL(searchUrl('nominatim', 'https://n.example/nominatim', 'café & bar=1#x'));
    expect(asked.pathname).toBe('/nominatim/search');
    expect(asked.searchParams.get('q')).toBe('café & bar=1#x');
    expect(asked.hash).toBe('');
    expect(new URL(searchUrl('photon', 'https://p.example', 'a b')).pathname).toBe('/api/');
  });

  it('puts a point in a reverse lookup, and a category in words', () => {
    const asked = new URL(reverseUrl('nominatim', 'https://n.example', 48.854, 2.3326));
    expect([asked.searchParams.get('lat'), asked.searchParams.get('lon')]).toEqual([
      '48.854',
      '2.3326',
    ]);
    expect(categoryWords('guest_house')).toBe('Guest house');
    expect(categoryWords('yes')).toBeUndefined();
  });
});

describe('the fake search', () => {
  it('has places the adapters can read, each with an id of its own', () => {
    expect(new Set(FAKE_PLACES.map((p) => p.id)).size).toBe(FAKE_PLACES.length);
  });
});
