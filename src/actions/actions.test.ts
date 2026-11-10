import { describe, expect, it } from 'vitest';
import { parseMutation } from '../checkins/validate';
import { localDate, localTime } from '../places/tz';
import {
  checkInAtNewPlace,
  checkInAtPlace,
  checkInAtPoint,
  deleteCheckin,
  editCheckin,
  nearName,
} from './checkins';
import { createPlace, deletePlace, updatePlace } from './places';
import type { ActionResult, CheckinView, Context, PlaceView } from './types';

/**
 * The actions (DESIGN.md §15.2) with their output fixed: each is a pure function of what it is given, so the same input is the same mutation, and **every mutation an action makes is one the
 * server's parser accepts** (checked on each, below).
 */
const NOW = Date.UTC(2026, 6, 4, 12, 0); // 4 July 2026, 12:00 UTC
const ctx = (over: Partial<Context> = {}): Context => {
  let n = 0;
  return { ids: { newId: () => `id-${++n}` }, now: NOW, deviceZone: 'Asia/Tokyo', ...over };
};

const LISBON: PlaceView = {
  id: 'lisbon',
  name: 'Sé de Lisboa',
  lat: 38.7097,
  lng: -9.1329,
  source: 'osm',
  sourceId: 'relation/1',
  tz: 'Europe/Lisbon',
  countryCode: 'PT',
  version: 4,
};
const AUCKLAND: PlaceView = {
  id: 'auckland',
  name: 'Sky Tower',
  lat: -36.8485,
  lng: 174.7633,
  source: 'manual',
  tz: 'Pacific/Auckland',
  countryCode: 'NZ',
  version: 1,
};
const CHECKIN: CheckinView = {
  id: 'c1',
  placeId: 'lisbon',
  at: Date.UTC(2026, 5, 1, 10, 30),
  tz: 'Europe/Lisbon',
  offsetMin: 60,
  companions: ['Ada'],
  tripId: null,
  linkSource: null,
  share: 'trip',
  source: 'manual',
  version: 2,
};

/** The one thing every action's output must be: accepted by the parser the server runs on what a device sends. */
function accepted(result: ActionResult) {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.sentence);
  const parsed = parseMutation(JSON.parse(JSON.stringify(result.mutation)), NOW);
  expect(parsed.ok, JSON.stringify(parsed)).toBe(true);
  return result;
}
const failure = (result: ActionResult) => {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error('expected a refusal');
  return result;
};

describe('checking in at a place', () => {
  it('is now, in the zone the device is in, with the offset there, made live', () => {
    const result = accepted(
      checkInAtPlace(LISBON, { note: ' lovely ', companions: ['Ada'] }, ctx()),
    );
    expect(result).toEqual({
      ok: true,
      mutation: {
        mutationId: 'id-2',
        stream: 'account',
        changes: [
          {
            table: 'checkin',
            op: 'put',
            id: 'id-1',
            row: {
              placeId: 'lisbon',
              at: NOW,
              tz: 'Asia/Tokyo',
              offsetMin: 540,
              note: 'lovely',
              companions: ['Ada'],
              tripId: null,
              linkSource: null,
              share: 'trip',
              source: 'live',
            },
          },
        ],
      },
      created: { checkinId: 'id-1' },
    });
  });

  it('is in the place’s zone for another time, which is a forgotten check-in added later', () => {
    const at = Date.UTC(2026, 5, 1, 10, 30);
    const result = accepted(checkInAtPlace(LISBON, { at }, ctx()));
    const row =
      result.ok && result.mutation.changes[0]?.op === 'put'
        ? result.mutation.changes[0].row
        : undefined;
    expect(row).toMatchObject({ at, tz: 'Europe/Lisbon', offsetMin: 60, source: 'manual' });
  });

  it('is on the right day either side of midnight in the place’s own zone: 23:59 and 00:01 in Auckland', () => {
    for (const [at, date, time] of [
      [Date.UTC(2026, 5, 30, 11, 59), '2026-06-30', '23:59'],
      [Date.UTC(2026, 5, 30, 12, 1), '2026-07-01', '00:01'],
    ] as const) {
      const made = accepted(checkInAtPlace(AUCKLAND, { at }, ctx()));
      const row =
        made.ok && made.mutation.changes[0]?.op === 'put'
          ? made.mutation.changes[0].row
          : undefined;
      if (!row || !('at' in row)) throw new Error('no row');
      expect(row).toMatchObject({ tz: 'Pacific/Auckland', offsetMin: 720 });
      expect([localDate(row.at, row.tz), localTime(row.at, row.tz)]).toEqual([date, time]);
    }
  });

  it('uses the device’s zone for another time when the place has none', () => {
    const result = accepted(
      checkInAtPlace({ ...LISBON, tz: null }, { at: NOW - 3_600_000 }, ctx()),
    );
    const row =
      result.ok && result.mutation.changes[0]?.op === 'put'
        ? result.mutation.changes[0].row
        : undefined;
    expect(row).toMatchObject({ tz: 'Asia/Tokyo', offsetMin: 540 });
  });

  it('is never in the future, says so, and is not a place that is not there', () => {
    expect(failure(checkInAtPlace(LISBON, { at: NOW + 3_600_000 }, ctx())).sentence).toBe(
      "A check-in can't be in the future.",
    );
    expect(failure(checkInAtPlace(undefined, {}, ctx())).reason).toBe('place_missing');
    expect(failure(checkInAtPlace(LISBON, { note: 'x'.repeat(2001) }, ctx())).reason).toBe('note');
    expect(
      failure(
        checkInAtPlace(
          LISBON,
          { companions: Array.from({ length: 21 }, (_, i) => `P${i}`) },
          ctx(),
        ),
      ).reason,
    ).toBe('companions');
  });

  it('asks the auto-link hook, and takes its answer as the app’s link', () => {
    const asked: unknown[] = [];
    const link = (c: { at: number; tz: string; placeId: string }) => {
      asked.push(c);
      return { tripId: 'trip-9' };
    };
    const result = accepted(checkInAtPlace(LISBON, {}, ctx({ link })));
    const row =
      result.ok && result.mutation.changes[0]?.op === 'put'
        ? result.mutation.changes[0].row
        : undefined;
    expect(row).toMatchObject({ tripId: 'trip-9', linkSource: 'auto' });
    expect(asked).toEqual([{ at: NOW, tz: 'Asia/Tokyo', placeId: 'lisbon' }]);
  });
});

describe('photos on a check-in', () => {
  const [a, b, c] = [
    '11111111-1111-4111-8111-111111111111',
    '22222222-2222-4222-8222-222222222222',
    '33333333-3333-4333-8333-333333333333',
  ];
  const rowOf = (result: ActionResult) => {
    const made = accepted(result);
    return made.ok && made.mutation.changes[0]?.op === 'put'
      ? made.mutation.changes[0].row
      : undefined;
  };

  it('carries the ids the device made, in order, when checking in and when changing a check-in', () => {
    expect(rowOf(checkInAtPlace(LISBON, { photos: [b, a] }, ctx()))).toMatchObject({
      photos: [b, a],
    });
    expect(rowOf(editCheckin(CHECKIN, { photos: [a, b, c] }, ctx()))).toMatchObject({
      photos: [a, b, c],
    });
    const withPhotos = { ...CHECKIN, photos: [a, b] };
    expect(rowOf(editCheckin(withPhotos, { photos: [b, a] }, ctx()))).toMatchObject({
      photos: [b, a],
    });
    expect(rowOf(editCheckin(withPhotos, { note: 'x' }, ctx()))).toMatchObject({ photos: [a, b] });
    const taken = rowOf(editCheckin(withPhotos, { photos: [] }, ctx()));
    expect(taken && 'photos' in taken).toBe(false);
    expect(failure(editCheckin(withPhotos, { photos: [a, b] }, ctx())).reason).toBe('nothing');
  });

  it('refuses more than ten, and what is not an id the device made, with the sentence', () => {
    const eleven = Array.from(
      { length: 11 },
      (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    );
    expect(failure(checkInAtPlace(LISBON, { photos: eleven }, ctx())).sentence).toBe(
      'A check-in has at most 10 photos.',
    );
    expect(failure(checkInAtPlace(LISBON, { photos: ['x'] }, ctx())).reason).toBe('photos');
    expect(
      failure(checkInAtNewPlace({ name: 'x', lat: 1, lng: 1 }, { photos: [a, a] }, ctx())).reason,
    ).toBe('photos');
  });
});

describe('checking in at a new place, and at a point', () => {
  it('makes the place and the check-in in one mutation, the place first, the zone found from the point', () => {
    const result = accepted(
      checkInAtNewPlace(
        {
          name: ' Pastéis de Belém ',
          lat: 38.6975,
          lng: -9.2032,
          category: 'Cafe',
          address: { city: 'Lisbon', countryCode: 'pt' },
        },
        { at: NOW - 86_400_000 },
        ctx(),
      ),
    );
    expect(result.ok && result.mutation.changes).toEqual([
      {
        table: 'place',
        op: 'put',
        id: 'id-1',
        row: {
          name: 'Pastéis de Belém',
          lat: 38.6975,
          lng: -9.2032,
          address: { city: 'Lisbon', countryCode: 'PT' },
          category: 'Cafe',
          source: 'manual',
          tz: 'Europe/Lisbon',
          countryCode: 'PT',
        },
      },
      {
        table: 'checkin',
        op: 'put',
        id: 'id-2',
        row: {
          placeId: 'id-1',
          at: NOW - 86_400_000,
          tz: 'Europe/Lisbon',
          offsetMin: 60,
          companions: [],
          tripId: null,
          linkSource: null,
          share: 'trip',
          source: 'manual',
        },
      },
    ]);
    expect(result.ok && result.created).toEqual({ placeId: 'id-1', checkinId: 'id-2' });
  });

  it('makes a check-in at a point alone, the place called "A place near …" and marked to be named when it arrives', () => {
    const result = accepted(checkInAtPoint({ lat: 38.7223, lng: -9.1393 }, {}, ctx()));
    const place = result.ok ? result.mutation.changes[0] : undefined;
    expect(place).toMatchObject({
      table: 'place',
      row: { name: 'A place near 38.7223, -9.1393', unnamed: true, tz: 'Europe/Lisbon' },
    });
    expect(nearName(38.72234, -9.13934)).toBe('A place near 38.7223, -9.1393');
  });

  it('refuses a place that is not one, and makes nothing', () => {
    expect(failure(checkInAtNewPlace({ name: '', lat: 1, lng: 1 }, {}, ctx())).reason).toBe(
      'place_name',
    );
    expect(failure(checkInAtNewPlace({ name: 'x', lat: 95, lng: 1 }, {}, ctx())).reason).toBe(
      'place_point',
    );
    expect(failure(checkInAtPoint({ lat: 0, lng: 200 }, {}, ctx())).reason).toBe('place_point');
    expect(
      failure(checkInAtNewPlace({ name: 'x', lat: 1, lng: 1 }, { at: NOW + 1e9 }, ctx())).reason,
    ).toBe('future');
  });
});

describe('changing a check-in', () => {
  it('sends the row whole, with the version it was made from, and works the offset out again for a new moment', () => {
    const at = Date.UTC(2026, 0, 15, 10, 0); // winter: Lisbon is at UTC+0
    const result = accepted(editCheckin(CHECKIN, { at, note: 'in January' }, ctx()));
    expect(result.ok && result.mutation.changes).toEqual([
      {
        table: 'checkin',
        op: 'put',
        id: 'c1',
        baseVersion: 2,
        row: {
          placeId: 'lisbon',
          at,
          tz: 'Europe/Lisbon',
          offsetMin: 0,
          note: 'in January',
          companions: ['Ada'],
          tripId: null,
          linkSource: null,
          share: 'trip',
          source: 'manual',
        },
      },
    ]);
  });

  it('follows a new place’s zone, and keeps a zone chosen by hand over it', () => {
    const moved = accepted(editCheckin(CHECKIN, { place: AUCKLAND }, ctx()));
    const row =
      moved.ok && moved.mutation.changes[0]?.op === 'put'
        ? moved.mutation.changes[0].row
        : undefined;
    expect(row).toMatchObject({ placeId: 'auckland', tz: 'Pacific/Auckland', offsetMin: 720 }); // 1 June: NZ is on winter time, UTC+12
    const chosen = accepted(editCheckin(CHECKIN, { place: AUCKLAND, tz: 'Pacific/Fiji' }, ctx()));
    const chosenRow =
      chosen.ok && chosen.mutation.changes[0]?.op === 'put'
        ? chosen.mutation.changes[0].row
        : undefined;
    expect(chosenRow).toMatchObject({ tz: 'Pacific/Fiji', offsetMin: 720 });
  });

  it('takes the note away with null, and changes who it is shared with', () => {
    const noted = { ...CHECKIN, note: 'was here' };
    const result = accepted(editCheckin(noted, { note: null, share: 'off' }, ctx()));
    const row =
      result.ok && result.mutation.changes[0]?.op === 'put'
        ? result.mutation.changes[0].row
        : undefined;
    expect(row && 'note' in row).toBe(false);
    expect(row).toMatchObject({ share: 'off' });
  });

  it('knows a check-in from the device’s store, which carries the server’s number for it, is unchanged when nothing is', () => {
    const fromStore = { ...CHECKIN, seq: 42 } as typeof CHECKIN;
    expect(
      failure(editCheckin(fromStore, { note: undefined, companions: ['Ada'] }, ctx())).reason,
    ).toBe('nothing');
    expect(accepted(editCheckin(fromStore, { note: 'now it has one' }, ctx())).ok).toBe(true);
  });

  it('refuses a change that changes nothing, a check-in that is gone, and a moment in the future', () => {
    expect(failure(editCheckin(CHECKIN, {}, ctx())).reason).toBe('nothing');
    expect(
      failure(editCheckin(CHECKIN, { note: undefined, companions: ['Ada'] }, ctx())).reason,
    ).toBe('nothing');
    expect(failure(editCheckin(undefined, { note: 'x' }, ctx())).reason).toBe('missing');
    expect(failure(editCheckin(CHECKIN, { at: NOW + 3_600_000 }, ctx())).reason).toBe('future');
    expect(failure(editCheckin(CHECKIN, { tz: 'Not/AZone' }, ctx())).reason).toBe('zone');
  });

  describe('the trip link', () => {
    const hook = (tripId: string | null) => (): { tripId: string } | null =>
      tripId ? { tripId } : null;
    const row = (result: ActionResult) => {
      const made = accepted(result);
      return made.ok && made.mutation.changes[0]?.op === 'put'
        ? made.mutation.changes[0].row
        : undefined;
    };

    it('is asked of the app again when the moment or place changes, and a link the app made can go or change', () => {
      const linked = { ...CHECKIN, tripId: 'trip-1', linkSource: 'auto' as const };
      expect(
        row(editCheckin(linked, { place: AUCKLAND }, ctx({ link: hook('trip-2') }))),
      ).toMatchObject({ tripId: 'trip-2', linkSource: 'auto' });
      expect(
        row(editCheckin(linked, { place: AUCKLAND }, ctx({ link: hook(null) }))),
      ).toMatchObject({ tripId: null, linkSource: null });
      // A note changes neither, so the link is left alone.
      expect(row(editCheckin(linked, { note: 'x' }, ctx({ link: hook('trip-2') })))).toMatchObject({
        tripId: 'trip-1',
        linkSource: 'auto',
      });
    });

    it('is never changed by the app once a person set it, or took it away, by hand', () => {
      const byHand = { ...CHECKIN, tripId: 'trip-1', linkSource: 'manual' as const };
      expect(
        row(
          editCheckin(byHand, { place: AUCKLAND, at: NOW - 1000 }, ctx({ link: hook('trip-2') })),
        ),
      ).toMatchObject({ tripId: 'trip-1', linkSource: 'manual' });
      const unlinked = { ...CHECKIN, tripId: null, linkSource: 'manual' as const };
      expect(
        row(editCheckin(unlinked, { place: AUCKLAND }, ctx({ link: hook('trip-2') }))),
      ).toMatchObject({ tripId: null, linkSource: 'manual' });
    });

    it('is made, removed and handed back by a person: the first two are manual, the third asks the app', () => {
      expect(row(editCheckin(CHECKIN, { trip: { tripId: 'trip-5' } }, ctx()))).toMatchObject({
        tripId: 'trip-5',
        linkSource: 'manual',
      });
      const linked = { ...CHECKIN, tripId: 'trip-1', linkSource: 'auto' as const };
      expect(row(editCheckin(linked, { trip: null }, ctx()))).toMatchObject({
        tripId: null,
        linkSource: 'manual',
      });
      const manual = { ...CHECKIN, tripId: 'trip-1', linkSource: 'manual' as const };
      expect(
        row(editCheckin(manual, { trip: 'auto' }, ctx({ link: hook('trip-3') }))),
      ).toMatchObject({ tripId: 'trip-3', linkSource: 'auto' });
      expect(row(editCheckin(manual, { trip: 'auto' }, ctx()))).toMatchObject({
        tripId: null,
        linkSource: null,
      });
    });
  });
});

describe('deleting a check-in', () => {
  it('is one delete, with nothing else, and a check-in that is gone is not deleted twice', () => {
    expect(accepted(deleteCheckin(CHECKIN, ctx()))).toEqual({
      ok: true,
      mutation: {
        mutationId: 'id-1',
        stream: 'account',
        changes: [{ table: 'checkin', op: 'delete', id: 'c1' }],
      },
      created: {},
    });
    expect(failure(deleteCheckin(undefined, ctx())).reason).toBe('missing');
  });
});

describe('places', () => {
  it('makes a place with the zone found from its point, unless a person chose one', () => {
    const found = accepted(createPlace({ name: 'Home', lat: 35.6586, lng: 139.7454 }, ctx()));
    expect(found.ok && found.mutation.changes[0]).toMatchObject({
      table: 'place',
      op: 'put',
      id: 'id-1',
      row: { tz: 'Asia/Tokyo', source: 'manual' },
    });
    const chosen = accepted(
      createPlace(
        { name: 'Pago Pago', lat: -14.2756, lng: -170.702, tz: 'Pacific/Pago_Pago' },
        ctx(),
      ),
    );
    expect(chosen.ok && chosen.mutation.changes[0]).toMatchObject({
      row: { tz: 'Pacific/Pago_Pago' },
    });
    expect(failure(createPlace({ name: '', lat: 1, lng: 1 }, ctx())).reason).toBe('place_name');
  });

  it('renames, recategorizes and moves, the row whole and the version it was made from with it', () => {
    const renamed = accepted(
      updatePlace(LISBON, { name: 'Lisbon Cathedral', category: 'Church' }, ctx()),
    );
    expect(renamed.ok && renamed.mutation.changes).toEqual([
      {
        table: 'place',
        op: 'put',
        id: 'lisbon',
        baseVersion: 4,
        row: {
          name: 'Lisbon Cathedral',
          lat: 38.7097,
          lng: -9.1329,
          category: 'Church',
          sourceId: 'relation/1',
          source: 'osm',
          tz: 'Europe/Lisbon',
          countryCode: null,
        },
      },
    ]);
    const moved = accepted(updatePlace(LISBON, { point: { lat: 35.6586, lng: 139.7454 } }, ctx()));
    expect(moved.ok && moved.mutation.changes[0]).toMatchObject({
      row: { lat: 35.6586, tz: 'Asia/Tokyo' },
    });
    const taken = accepted(updatePlace({ ...LISBON, category: 'Church' }, { category: '' }, ctx()));
    expect(taken.ok && taken.mutation.changes[0]).not.toHaveProperty('row.category');
  });

  it('keeps a zone a person corrected through a rename, and finds it again from the point when asked', () => {
    const corrected = { ...LISBON, tz: 'Atlantic/Azores' };
    const renamed = accepted(updatePlace(corrected, { name: 'Sé' }, ctx()));
    expect(renamed.ok && renamed.mutation.changes[0]).toMatchObject({
      row: { tz: 'Atlantic/Azores' },
    });
    const found = accepted(updatePlace(corrected, { tz: null }, ctx()));
    expect(found.ok && found.mutation.changes[0]).toMatchObject({ row: { tz: 'Europe/Lisbon' } });
  });

  it('refuses a change that changes nothing, a value that is not one, and a place that is gone', () => {
    expect(failure(updatePlace(LISBON, {}, ctx())).reason).toBe('nothing');
    expect(failure(updatePlace(LISBON, { name: LISBON.name }, ctx())).reason).toBe('nothing');
    expect(failure(updatePlace(LISBON, { name: ' ' }, ctx())).reason).toBe('place_name');
    expect(failure(updatePlace(LISBON, { point: { lat: 100, lng: 0 } }, ctx())).reason).toBe(
      'place_point',
    );
    expect(failure(updatePlace(undefined, { name: 'x' }, ctx())).reason).toBe('missing');
  });

  it('deletes a place nothing is at, and says what to do about one that has check-ins', () => {
    expect(accepted(deletePlace(LISBON, [{ placeId: 'elsewhere' }], ctx())).ok).toBe(true);
    const refused = failure(deletePlace(LISBON, [{ placeId: 'lisbon' }], ctx()));
    expect(refused.reason).toBe('in_use');
    expect(refused.sentence).toContain('Merge it into another place');
    expect(failure(deletePlace(undefined, [], ctx())).reason).toBe('missing');
  });
});

describe('what an action reads', () => {
  it('is only what it is given: the same input is the same mutation, and nothing is read from a clock', () => {
    const a = checkInAtPlace(LISBON, { note: 'x' }, ctx());
    const b = checkInAtPlace(LISBON, { note: 'x' }, ctx());
    expect(a).toEqual(b);
    const later = checkInAtPlace(LISBON, { note: 'x' }, ctx({ now: NOW + 1000 }));
    expect(later).not.toEqual(a);
  });
});
