import { describe, expect, it } from 'vitest';
import { LIMITS } from '../sync/format';
import {
  SENTENCES,
  type Reason,
  parseMutation,
  validateCheckinRow,
  validateCompanions,
  validatePhotos,
  validatePlaceRow,
} from './validate';

const NOW = 1_800_000_000_000;
const CHECKIN = {
  placeId: 'place-1',
  at: NOW - 60_000,
  tz: 'Europe/Lisbon',
  offsetMin: 0,
  companions: [],
  tripId: null,
  linkSource: null,
  share: 'trip',
  source: 'live',
};
const PLACE = {
  name: 'Café de Flore',
  lat: 48.854,
  lng: 2.3326,
  source: 'osm',
  tz: 'Europe/Paris',
  countryCode: null,
};

/** What a refusal reads as: the reason, and a sentence that is not the reason's own name and never what was wrong. */
const refusal = (result: { ok: boolean; reason?: Reason; sentence?: string }) => {
  expect(result.ok).toBe(false);
  expect(result.sentence).toBe(SENTENCES[result.reason as Reason]);
  expect(result.sentence).toMatch(/[.]$/);
  return result.reason;
};

describe('a check-in as it travels', () => {
  it('is kept as it is, with what is optional left out and a note trimmed', () => {
    const row = validateCheckinRow(
      { ...CHECKIN, note: '  a good one \n', companions: [' Ada ', 'Grace', 'ada', ''] },
      NOW,
    );
    expect(row).toEqual({
      ok: true,
      value: { ...CHECKIN, note: 'a good one', companions: ['Ada', 'Grace'] },
    });
    expect(validateCheckinRow({ ...CHECKIN, note: '   ' }, NOW)).toEqual({
      ok: true,
      value: CHECKIN,
    });
  });

  it.each([
    ['a moment in the future', { at: NOW + 6 * 60_000 }, 'future'],
    ['a moment that is not a whole number', { at: 1.5 }, 'moment'],
    ['a moment of nothing', { at: 0 }, 'moment'],
    ['a moment that is text', { at: 'now' }, 'moment'],
    ['a moment that is not a time', { at: Number.NaN }, 'moment'],
    ['a zone that does not exist', { tz: 'Not/AZone' }, 'zone'],
    ['a zone that is not text', { tz: 5 }, 'zone'],
    ['an offset that is not minutes', { offsetMin: 90.5 }, 'offset'],
    ['an offset of more than fourteen hours', { offsetMin: 15 * 60 }, 'offset'],
    ['a note of 2,001 characters', { note: 'x'.repeat(2001) }, 'note'],
    ['a note that is not text', { note: 3 }, 'note'],
    ['21 companions', { companions: Array.from({ length: 21 }, (_, i) => `P${i}`) }, 'companions'],
    ['a companion of 61 characters', { companions: ['x'.repeat(61)] }, 'companions'],
    ['a companion with a line break', { companions: ['a\nb'] }, 'companions'],
    ['companions that are not a list', { companions: 'Ada' }, 'companions'],
    ['no place', { placeId: undefined }, 'place_missing'],
    ['a place that is not an id', { placeId: 'has space' }, 'place_missing'],
    ['a trip with no one who linked it', { tripId: 'trip-1', linkSource: null }, 'link'],
    ['an automatic link to no trip', { tripId: null, linkSource: 'auto' }, 'link'],
    ['a link by no one known', { tripId: 'trip-1', linkSource: 'robot' }, 'link'],
    ['sharing that is not a choice', { share: 'maybe' }, 'share'],
    ['a source that is not one', { source: 'robot' }, 'source'],
    ['an import with no id of its own', { source: 'import:swarm' }, 'source'],
    ['an id of its own on a live check-in', { externalId: 'x' }, 'source'],
    ['a field the app does not have', { mood: 'happy' }, 'bad_mutation'],
  ] as const)('refuses %s, with a sentence', (_what, patch, reason) => {
    const result = validateCheckinRow({ ...CHECKIN, ...patch }, NOW);
    expect(refusal(result)).toBe(reason);
  });

  it('allows a moment a few minutes ahead, for the difference between two clocks, and no more', () => {
    expect(validateCheckinRow({ ...CHECKIN, at: NOW + LIMITS.clockSkewMs }, NOW).ok).toBe(true);
    expect(validateCheckinRow({ ...CHECKIN, at: NOW + LIMITS.clockSkewMs + 1 }, NOW).ok).toBe(
      false,
    );
  });

  it('takes a link made by hand, with a trip or with none, and an import with the id it came with', () => {
    expect(validateCheckinRow({ ...CHECKIN, tripId: 'trip-1', linkSource: 'manual' }, NOW).ok).toBe(
      true,
    );
    expect(validateCheckinRow({ ...CHECKIN, tripId: null, linkSource: 'manual' }, NOW).ok).toBe(
      true,
    );
    expect(validateCheckinRow({ ...CHECKIN, tripId: 'trip-1', linkSource: 'auto' }, NOW).ok).toBe(
      true,
    );
    expect(
      validateCheckinRow({ ...CHECKIN, source: 'import:swarm', externalId: '5f3a' }, NOW).ok,
    ).toBe(true);
    expect(validateCheckinRow({ ...CHECKIN, note: 'x'.repeat(2000) }, NOW).ok).toBe(true);
  });

  it('is not the sentence of a value: no refusal repeats what was given', () => {
    const result = validateCheckinRow(
      { ...CHECKIN, note: 'x'.repeat(3000), tz: 'secret/zone' },
      NOW,
    );
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(JSON.stringify(result)).not.toContain('xxxx');
  });
});

describe('a place as it travels', () => {
  it('is cleaned: trimmed, the country code upper case, the optional parts left out', () => {
    expect(
      validatePlaceRow({
        ...PLACE,
        name: '  Café de Flore ',
        address: { city: ' Paris ', countryCode: 'fr' },
        category: ' Cafe ',
      }),
    ).toEqual({
      ok: true,
      value: {
        ...PLACE,
        name: 'Café de Flore',
        address: { city: 'Paris', countryCode: 'FR' },
        category: 'Cafe',
        countryCode: 'FR',
      },
    });
    expect(validatePlaceRow({ ...PLACE, unnamed: true })).toMatchObject({
      ok: true,
      value: { unnamed: true },
    });
  });

  it.each([
    ['no name', { name: ' ' }, 'place_name'],
    ['a name on two lines', { name: 'a\nb' }, 'place_name'],
    ['a name of 201 characters', { name: 'x'.repeat(201) }, 'place_name'],
    ['a latitude off the globe', { lat: 91 }, 'place_point'],
    ['a longitude that is not a number', { lng: 'far' }, 'place_point'],
    ['an address that is not parts', { address: 'Paris' }, 'place_address'],
    ['an address part the app does not have', { address: { planet: 'Earth' } }, 'place_address'],
    ['a country code of three letters', { address: { countryCode: 'FRA' } }, 'place_address'],
    ['a category of 61 characters', { category: 'x'.repeat(61) }, 'place_category'],
    ['a source that is not one', { source: 'google' }, 'place_source'],
    ['a zone that does not exist', { tz: 'Not/AZone' }, 'place_zone'],
    ['a field the app does not have', { rating: 5 }, 'bad_mutation'],
    ['a hint that is not a flag', { unnamed: 'yes' }, 'bad_mutation'],
  ] as const)('refuses %s, with a sentence', (_what, patch, reason) => {
    expect(refusal(validatePlaceRow({ ...PLACE, ...patch }))).toBe(reason);
  });
});

describe('companions and photos', () => {
  it('keeps names once each, in the first spelling, and refuses what is not a list of names', () => {
    expect(validateCompanions(['Ada', 'ADA', ' Grace  '])).toEqual({
      ok: true,
      value: ['Ada', 'Grace'],
    });
    expect(validateCompanions([])).toEqual({ ok: true, value: [] });
    expect(refusal(validateCompanions([1]))).toBe('companions');
  });

  it('are at most ten, each an id the device made, none twice', () => {
    const ids = Array.from({ length: 10 }, (_, i) => `photo-${i}`);
    expect(validatePhotos(ids)).toEqual({ ok: true, value: ids });
    expect(refusal(validatePhotos([...ids, 'photo-10']))).toBe('photos');
    expect(refusal(validatePhotos(['a', 'a']))).toBe('photos');
    expect(refusal(validatePhotos(['has space']))).toBe('photos');
    expect(refusal(validatePhotos('photo'))).toBe('photos');
  });
});

describe('a mutation from a device', () => {
  const put = (over = {}) => ({ table: 'checkin', op: 'put', id: 'c1', row: CHECKIN, ...over });
  const mutation = (over = {}) => ({
    mutationId: 'm1',
    stream: 'account',
    changes: [put()],
    ...over,
  });

  it('is read, with each row cleaned, and kept in its order', () => {
    const result = parseMutation(
      mutation({
        changes: [
          { table: 'place', op: 'put', id: 'p1', row: PLACE },
          put({ baseVersion: 3 }),
          { table: 'checkin', op: 'delete', id: 'c2' },
        ],
      }),
      NOW,
    );
    expect(result.ok && result.value.changes.map((c) => `${c.table} ${c.op} ${c.id}`)).toEqual([
      'place put p1',
      'checkin put c1',
      'checkin delete c2',
    ]);
    expect(result.ok && result.value.changes[1]).toMatchObject({ baseVersion: 3 });
  });

  it.each([
    ['no mutation at all', null, 'bad_mutation'],
    ['an id that is not one', mutation({ mutationId: 'has space' }), 'bad_id'],
    ['a stream that is not the person’s own', mutation({ stream: 'trip:abc' }), 'bad_mutation'],
    ['no changes', mutation({ changes: [] }), 'bad_mutation'],
    ['changes that are not a list', mutation({ changes: {} }), 'bad_mutation'],
    [
      'more than 50 changes',
      mutation({ changes: Array.from({ length: 51 }, (_, i) => put({ id: `c${i}` })) }),
      'too_many_changes',
    ],
    [
      'a table that does not sync',
      mutation({ changes: [put({ table: 'media' })] }),
      'bad_mutation',
    ],
    ['a row with an id that is not one', mutation({ changes: [put({ id: '../x' })] }), 'bad_id'],
    ['the same row twice', mutation({ changes: [put(), put()] }), 'duplicate_change'],
    ['an operation that is not one', mutation({ changes: [put({ op: 'patch' })] }), 'bad_mutation'],
    [
      'a base version that is not one',
      mutation({ changes: [put({ baseVersion: 0 })] }),
      'bad_mutation',
    ],
    [
      'a base version that is text',
      mutation({ changes: [put({ baseVersion: '2' })] }),
      'bad_mutation',
    ],
    ['a key the format does not have', mutation({ extra: 1 }), 'bad_mutation'],
    [
      'a change with a key the format does not have',
      mutation({ changes: [put({ extra: 1 })] }),
      'bad_mutation',
    ],
    [
      'a delete that carries a row',
      mutation({ changes: [{ table: 'checkin', op: 'delete', id: 'c1', row: CHECKIN }] }),
      'bad_mutation',
    ],
    [
      'a check-in in the future',
      mutation({ changes: [put({ row: { ...CHECKIN, at: NOW + 3_600_000 } })] }),
      'future',
    ],
    [
      'a place with no name',
      mutation({ changes: [{ table: 'place', op: 'put', id: 'p1', row: { ...PLACE, name: '' } }] }),
      'place_name',
    ],
  ] as const)('refuses %s', (_what, input, reason) => {
    expect(refusal(parseMutation(input, NOW))).toBe(reason);
  });

  it('refuses a mutation of text, a list or a number', () => {
    for (const input of ['x', [], 3, undefined]) expect(parseMutation(input, NOW).ok).toBe(false);
  });
});
