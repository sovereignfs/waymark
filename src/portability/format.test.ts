import { describe, expect, it } from 'vitest';
import { FORMAT, SENTENCES, VERSION, extensionOf, isPhotoFile, parseExport } from './format';

/** The file's format (DESIGN.md §22): what it accepts whole, and every way it is refused, in a sentence that repeats nothing from the file. */
const NOW = 1_800_000_000_000;
const PHOTO = '11111111-1111-4111-8111-111111111111';
const place = {
  id: 'p1',
  name: 'Café de Flore',
  lat: 48.854,
  lng: 2.3326,
  source: 'osm',
  tz: 'Europe/Paris',
  countryCode: 'FR',
};
const checkin = {
  id: 'c1',
  placeId: 'p1',
  at: NOW - 86_400_000,
  tz: 'Europe/Paris',
  offsetMin: 60,
  note: 'A note',
  companions: ['Grace'],
  tripId: null,
  linkSource: null,
  share: 'trip',
  source: 'live',
  photos: [PHOTO],
};
const good = () => ({
  format: FORMAT,
  version: VERSION,
  exportedAt: new Date(NOW).toISOString(),
  profile: { name: 'Ada', units: 'km', weekStart: 1, shareDefault: 'ask' },
  settings: { email: { import_finished: true } },
  places: [place],
  checkins: [checkin],
  photos: [{ id: PHOTO, file: `photos/${PHOTO}.webp`, type: 'image/webp' }],
});
const sentence = (input: unknown) => {
  const parsed = parseExport(input, NOW);
  return parsed.ok ? 'ok' : parsed.sentence;
};
const mutate = (change: (doc: ReturnType<typeof good>) => void) => {
  const doc = good();
  change(doc);
  return doc;
};

describe('a file made by an export', () => {
  it('is accepted whole, with the rows cleaned', () => {
    const parsed = parseExport(good(), NOW);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.places).toHaveLength(1);
      expect(parsed.value.checkins[0]).toMatchObject({
        id: 'c1',
        companions: ['Grace'],
        photos: [PHOTO],
      });
    }
  });

  it('may name a photo that never reached the server, and may hold no rows at all', () => {
    expect(sentence(mutate((d) => (d.photos = [])))).toBe('ok');
    expect(sentence(mutate((d) => ((d.places = []), (d.checkins = []), (d.photos = []))))).toBe(
      'ok',
    );
  });

  it('is refused if it is not ours, or from a newer version, in a sentence that says what to do', () => {
    expect(sentence(null)).toBe(SENTENCES.notWaymark);
    expect(sentence('text')).toBe(SENTENCES.notWaymark);
    expect(sentence({ ...good(), format: 'something-else' })).toBe(SENTENCES.notWaymark);
    expect(sentence({ ...good(), version: VERSION + 1 })).toBe(SENTENCES.newer);
    expect(SENTENCES.newer).toContain('Update Waymark');
    for (const version of [0, -1, 1.5, '1', null])
      expect(sentence({ ...good(), version }), String(version)).toBe(SENTENCES.unreadable);
  });

  it('is refused for every way the parts can be wrong, with nothing of the file in the sentence', () => {
    const wrong: [string, unknown][] = [
      ['a place with no name', mutate((d) => (d.places = [{ ...place, name: '' }]))],
      ['a place off the globe', mutate((d) => (d.places = [{ ...place, lat: 999 }]))],
      ['a place with an id that is not one', mutate((d) => (d.places = [{ ...place, id: 'a b' }]))],
      ['a place twice', mutate((d) => (d.places = [place, place]))],
      [
        'a check-in at a place the file does not have',
        mutate((d) => (d.checkins = [{ ...checkin, placeId: 'nowhere' }])),
      ],
      [
        'a check-in in the future',
        mutate((d) => (d.checkins = [{ ...checkin, at: NOW + 10 * 86_400_000 }])),
      ],
      ['a check-in twice', mutate((d) => (d.checkins = [checkin, checkin]))],
      [
        'a check-in with a field the app does not know',
        mutate((d) => (d.checkins = [{ ...checkin, secret: 'x' } as never])),
      ],
      [
        'a photo on two check-ins',
        mutate((d) => (d.checkins = [checkin, { ...checkin, id: 'c2' }])),
      ],
      [
        'a photo that no check-in names',
        mutate((d) => (d.checkins = [{ ...checkin, photos: [] }])),
      ],
      [
        'a photo file outside the folder',
        mutate((d) => (d.photos = [{ id: PHOTO, file: '../evil.webp', type: 'image/webp' }])),
      ],
      [
        'a photo file in a folder',
        mutate(
          (d) => (d.photos = [{ id: PHOTO, file: `photos/x/${PHOTO}.webp`, type: 'image/webp' }]),
        ),
      ],
      [
        'a photo that is not an image',
        mutate(
          (d) => (d.photos = [{ id: PHOTO, file: `photos/${PHOTO}.webp`, type: 'text/html' }]),
        ),
      ],
      [
        'a photo id that is not a uuid',
        mutate(
          (d) =>
            (d.photos = [{ id: 'not-a-uuid', file: `photos/${PHOTO}.webp`, type: 'image/webp' }]),
        ),
      ],
      ['a photo twice', mutate((d) => (d.photos = [d.photos[0] as never, d.photos[0] as never]))],
    ];
    for (const [what, input] of wrong) {
      const said = sentence(input);
      expect(said, what).toBe(SENTENCES.broken);
      expect(said).not.toContain('Flore');
      expect(said).not.toContain(PHOTO);
    }
  });

  it('is refused for a profile or settings that are not, and for a file with more than it will hold', () => {
    for (const profile of [
      null,
      { name: '', units: 'km', weekStart: 1, shareDefault: 'ask' },
      { name: 'Ada', units: 'furlongs', weekStart: 1, shareDefault: 'ask' },
      { name: 'Ada', units: 'km', weekStart: 9, shareDefault: 'ask' },
      { name: 'Ada', units: 'km', weekStart: 1, shareDefault: 'maybe' },
      { name: 'a\nb', units: 'km', weekStart: 1, shareDefault: 'ask' },
    ])
      expect(sentence({ ...good(), profile })).toBe(SENTENCES.unreadable);
    for (const settings of [
      null,
      {},
      { email: [] },
      { email: { 'Bad Kind': true } },
      { email: { import_finished: 'yes' } },
    ])
      expect(sentence({ ...good(), settings })).toBe(SENTENCES.unreadable);
    expect(sentence({ ...good(), places: new Array(500_001).fill(place) })).toBe(SENTENCES.tooMany);
  });
});

describe('a photo’s name in the file', () => {
  it('is photos/<uuid>.<webp, jpg or png> and nothing else', () => {
    expect(isPhotoFile(`photos/${PHOTO}.webp`)).toBe(true);
    expect(isPhotoFile(`photos/${PHOTO}.jpg`)).toBe(true);
    for (const bad of [
      `${PHOTO}.webp`,
      `photos/${PHOTO}.exe`,
      `photos/../${PHOTO}.webp`,
      `/photos/${PHOTO}.webp`,
      'photos/x.webp',
      `photos/${PHOTO}.webp\u0000`,
    ])
      expect(isPhotoFile(bad), bad).toBe(false);
    expect(extensionOf('image/webp')).toBe('webp');
    expect(extensionOf('image/jpeg')).toBe('jpg');
    expect(extensionOf('application/pdf')).toBe('bin');
  });
});
