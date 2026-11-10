import { describe, expect, it } from 'vitest';
import type { Context, PlaceView } from '../actions/types';
import { parseMutation } from '../checkins/validate';
import { localDate, localTime } from '../places/tz';
import type { Candidate } from '../places/providers';
import {
  buildOptions,
  momentFromInput,
  planCheckIn,
  planEdit,
  selectionOf,
  zoneOfSelection,
} from './checkin-flow';

/**
 * The check-in sheet's decisions (DESIGN.md §9.2, §20.5), without a browser: which places are offered and in what order, what a choice is, which moment was meant and which action results. Every mutation
 * a plan makes is one the server's parser takes.
 */
const NOW = Date.UTC(2026, 6, 4, 12, 0);
const ctx = (over: Partial<Context> = {}): Context => {
  let n = 0;
  return { ids: { newId: () => `id-${++n}` }, now: NOW, deviceZone: 'Asia/Tokyo', ...over };
};
const place = (
  id: string,
  name: string,
  lat: number,
  lng: number,
  over: Partial<PlaceView> = {},
): PlaceView => ({
  id,
  name,
  lat,
  lng,
  source: 'manual',
  tz: null,
  countryCode: null,
  version: 1,
  ...over,
});
const FLORE = place('flore', 'Café de Flore', 48.854, 2.3326, { tz: 'Europe/Paris' });
const EIFFEL = place('eiffel', 'Tour Eiffel', 48.8584, 2.2945);
const LISBON = place('lisbon', 'Sé de Lisboa', 38.7097, -9.1329, { tz: 'Europe/Lisbon' });
const PLACES = [LISBON, EIFFEL, FLORE];
const candidate = (name: string, lat: number, lng: number, sourceId: string): Candidate => ({
  name,
  lat,
  lng,
  address: { city: 'Paris', countryCode: 'FR' },
  category: 'Cafe',
  source: 'osm',
  sourceId,
});
const HERE = { lat: 48.8545, lng: 2.3328 }; // 60 m from the Flore, 3 km from the tower
const none = { found: [], reverse: undefined };

describe('which places are offered', () => {
  it('own places first, nearest first, when there is a position and nothing typed; and none of those far away', () => {
    const options = buildOptions({ places: PLACES, query: '', position: HERE, ...none });
    expect(options.map((o) => o.key)).toEqual(['mine:flore', 'new', 'point']);
    expect(options[0]).toMatchObject({ kind: 'mine' });
    expect((options[0] as { distance: number }).distance).toBeLessThan(80);
    const wide = buildOptions({
      places: PLACES,
      query: '',
      position: { lat: 48.856, lng: 2.313 },
      ...none,
    });
    expect(wide.filter((o) => o.kind === 'mine').map((o) => o.key)).toEqual([
      'mine:eiffel',
      'mine:flore',
    ]);
  });

  it('what was typed finds the person’s places by name, nearest first with a position and by name without', () => {
    expect(
      buildOptions({ places: PLACES, query: 'flore', position: undefined, ...none }).map(
        (o) => o.key,
      ),
    ).toEqual(['mine:flore']);
    expect(
      buildOptions({ places: PLACES, query: 'sé', position: undefined, ...none }).map((o) => o.key),
    ).toEqual(['mine:lisbon']);
    const two = [place('a', 'Cafe North', 48.9, 2.3), place('b', 'Cafe South', 48.8, 2.3)];
    expect(
      buildOptions({ places: two, query: 'cafe', position: { lat: 48.81, lng: 2.3 }, ...none }).map(
        (o) => o.key,
      ),
    ).toEqual(['mine:b', 'mine:a', 'new', 'point']);
    expect(
      buildOptions({ places: two, query: 'cafe', position: undefined, ...none }).map((o) => o.key),
    ).toEqual(['mine:a', 'mine:b']);
  });

  it('with nothing typed and no position, a few of the person’s places by name, and no way to make one', () => {
    const options = buildOptions({ places: PLACES, query: '  ', position: undefined, ...none });
    expect(options.map((o) => o.key)).toEqual(
      ['mine:flore', 'mine:lisbon', 'mine:eiffel'].sort((a, b) => a.localeCompare(b)).length
        ? ['mine:flore', 'mine:lisbon', 'mine:eiffel']
        : [],
    );
    expect(options.some((o) => o.kind === 'new' || o.kind === 'point')).toBe(false);
  });

  it('the place search’s come after the person’s, without any the person already has, and a place found twice once', () => {
    const found = [
      candidate('Café de Flore', 48.854, 2.3326, 'node/1'), // the person's own, by name and place
      candidate('Café Verlet', 48.8645, 2.3355, 'node/2'),
      candidate('Café Verlet', 48.8645, 2.3355, 'node/2'),
    ];
    const options = buildOptions({
      places: PLACES,
      query: 'cafe',
      position: HERE,
      found,
      reverse: undefined,
    });
    expect(options.map((o) => o.key)).toEqual(['mine:flore', 'found:node/2', 'new', 'point']);
    const withSource = [
      place('mine-osm', 'Renamed by me', 1, 1, { source: 'osm', sourceId: 'node/9' }),
    ];
    expect(
      buildOptions({
        places: withSource,
        query: 'x',
        position: undefined,
        found: [{ ...candidate('Other name', 50, 50, 'node/9') }],
        reverse: undefined,
      }).some((o) => o.kind === 'found'),
    ).toBe(false);
  });

  it('what is at the position is offered only while nothing is typed, and makes a new place with its name', () => {
    const reverse = candidate('Brasserie Lipp', 48.8537, 2.3331, 'node/3');
    expect(
      buildOptions({ places: PLACES, query: '', position: HERE, found: [], reverse }).map(
        (o) => o.key,
      ),
    ).toEqual(['mine:flore', 'found:node/3', 'new', 'point']);
    expect(
      buildOptions({ places: PLACES, query: 'flore', position: HERE, found: [], reverse }).some(
        (o) => o.key === 'found:node/3',
      ),
    ).toBe(false);
  });

  it('is at most six of each, and a new place and a point only where there is a position', () => {
    const many = Array.from({ length: 10 }, (_, i) => place(`p${i}`, `Cafe ${i}`, 48.85, 2.33));
    const found = Array.from({ length: 10 }, (_, i) =>
      candidate(`Other ${i}`, 48.9 + i / 100, 2.4, `node/${100 + i}`),
    );
    const options = buildOptions({
      places: many,
      query: 'cafe',
      position: undefined,
      found,
      reverse: undefined,
    });
    expect(options.filter((o) => o.kind === 'mine')).toHaveLength(6);
    expect(options.filter((o) => o.kind === 'found')).toHaveLength(6);
    expect(options.some((o) => o.kind === 'new' || o.kind === 'point')).toBe(false);
  });
});

describe('what a choice is', () => {
  it('is the place, the candidate, the point, or a new place only once it has a name', () => {
    const options = buildOptions({
      places: PLACES,
      query: '',
      position: HERE,
      found: [candidate('Café Verlet', 48.8645, 2.3355, 'node/2')],
      reverse: undefined,
    });
    const by = (kind: string) => options.find((o) => o.kind === kind);
    expect(selectionOf(by('mine'), '')).toMatchObject({ kind: 'place', place: { id: 'flore' } });
    expect(selectionOf(by('found'), '')).toMatchObject({ kind: 'candidate' });
    expect(selectionOf(by('point'), '')).toEqual({ kind: 'point', point: HERE });
    expect(selectionOf(by('new'), '')).toBeUndefined();
    expect(selectionOf(by('new'), '   ')).toBeUndefined();
    expect(selectionOf(by('new'), ' Chez Moi ')).toEqual({
      kind: 'new',
      name: 'Chez Moi',
      point: HERE,
    });
    expect(selectionOf(undefined, 'x')).toBeUndefined();
  });

  it('is in the zone of its place for another time: the place’s own, or the one its point is in', () => {
    expect(zoneOfSelection({ kind: 'place', place: FLORE })).toBe('Europe/Paris');
    expect(zoneOfSelection({ kind: 'place', place: EIFFEL })).toBe('Europe/Paris'); // none stored: found from its point
    expect(zoneOfSelection({ kind: 'point', point: { lat: 35.6586, lng: 139.7454 } })).toBe(
      'Asia/Tokyo',
    );
    expect(
      zoneOfSelection({
        kind: 'candidate',
        candidate: candidate('x', -33.8688, 151.2093, 'node/5'),
      }),
    ).toBe('Australia/Sydney');
    expect(zoneOfSelection({ kind: 'new', name: 'x', point: { lat: 91, lng: 0 } })).toBeUndefined();
  });
});

describe('the moment', () => {
  it('is read on the place’s clock, and 23:59 and 00:01 are on the right days', () => {
    const late = momentFromInput({ date: '2026-12-31', time: '23:59' }, 'Pacific/Auckland');
    const early = momentFromInput({ date: '2027-01-01', time: '00:01' }, 'Pacific/Auckland');
    expect(late).toBe(Date.UTC(2026, 11, 31, 10, 59));
    expect(early).toBe(Date.UTC(2026, 11, 31, 11, 1));
    expect([
      localDate(late ?? 0, 'Pacific/Auckland'),
      localTime(late ?? 0, 'Pacific/Auckland'),
    ]).toEqual(['2026-12-31', '23:59']);
  });

  it('is nothing for a date or a time that is not one', () => {
    for (const [date, time] of [
      ['2026-02-30', '12:00'],
      ['', '12:00'],
      ['2026-07-04', '25:00'],
      ['2026-07-04', ''],
      ['soon', 'now'],
    ] as const)
      expect(momentFromInput({ date, time }, 'Europe/Paris'), `${date} ${time}`).toBeUndefined();
  });
});

describe('the action a choice makes', () => {
  const accepted = (result: ReturnType<typeof planCheckIn>) => {
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.sentence);
    expect(parseMutation(JSON.parse(JSON.stringify(result.mutation)), NOW).ok).toBe(true);
    return result;
  };
  const rows = (result: ReturnType<typeof planCheckIn>) =>
    result.ok ? result.mutation.changes.flatMap((c) => (c.op === 'put' ? [c] : [])) : [];

  it('checks in at a place the person has, now, in the device’s zone', () => {
    const made = accepted(
      planCheckIn({ kind: 'place', place: FLORE }, PLACES, { note: ' lovely ' }, ctx()),
    );
    expect(rows(made)).toHaveLength(1);
    expect(rows(made)[0]).toMatchObject({
      table: 'checkin',
      row: { placeId: 'flore', tz: 'Asia/Tokyo', note: 'lovely', source: 'live' },
    });
  });

  it('makes a place from a candidate, with what the search knew, and reuses the person’s own when it is the same one', () => {
    const verlet = candidate('Café Verlet', 48.8645, 2.3355, 'node/2');
    const made = accepted(planCheckIn({ kind: 'candidate', candidate: verlet }, PLACES, {}, ctx()));
    expect(rows(made).map((c) => c.table)).toEqual(['place', 'checkin']);
    expect(rows(made)[0]).toMatchObject({
      row: {
        name: 'Café Verlet',
        source: 'osm',
        sourceId: 'node/2',
        category: 'Cafe',
        address: { city: 'Paris', countryCode: 'FR' },
        tz: 'Europe/Paris',
      },
    });
    // The same one, by name within 50 metres of the Flore, is the Flore: one place.
    const again = accepted(
      planCheckIn(
        { kind: 'candidate', candidate: candidate('Cafe de Flore', 48.8541, 2.3327, 'node/77') },
        PLACES,
        {},
        ctx(),
      ),
    );
    expect(rows(again).map((c) => c.table)).toEqual(['checkin']);
    expect(rows(again)[0]).toMatchObject({ row: { placeId: 'flore' } });
  });

  it('makes a new place by name at the position, and reuses a place of the same name that is there already', () => {
    const made = accepted(
      planCheckIn({ kind: 'new', name: ' Chez Moi ', point: HERE }, PLACES, {}, ctx()),
    );
    expect(rows(made)[0]).toMatchObject({
      table: 'place',
      row: { name: 'Chez Moi', lat: HERE.lat },
    });
    const same = accepted(
      planCheckIn(
        { kind: 'new', name: 'café de flore', point: { lat: 48.8541, lng: 2.3327 } },
        PLACES,
        {},
        ctx(),
      ),
    );
    expect(rows(same).map((c) => c.table)).toEqual(['checkin']);
    expect(rows(same)[0]).toMatchObject({ row: { placeId: 'flore' } });
  });

  it('makes a check-in at a point alone, with the place called "A place near …" and marked to be named', () => {
    const made = accepted(
      planCheckIn({ kind: 'point', point: { lat: 38.7223, lng: -9.1393 } }, [], {}, ctx()),
    );
    expect(rows(made)[0]).toMatchObject({
      table: 'place',
      row: { name: 'A place near 38.7223, -9.1393', unnamed: true },
    });
  });

  it('is at another time on the place’s clock, and the zone is the place’s and not the device’s', () => {
    const made = accepted(
      planCheckIn(
        { kind: 'place', place: FLORE },
        PLACES,
        { local: { date: '2026-06-01', time: '10:30' } },
        ctx(),
      ),
    );
    expect(rows(made)[0]).toMatchObject({
      row: {
        at: Date.UTC(2026, 5, 1, 8, 30),
        tz: 'Europe/Paris',
        offsetMin: 120,
        source: 'manual',
      },
    });
  });

  it('carries the companions and the photos it was given, in order', () => {
    const photos = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'];
    const made = accepted(
      planCheckIn(
        { kind: 'place', place: FLORE },
        PLACES,
        { companions: ['Ada', 'Grace'], photos },
        ctx(),
      ),
    );
    expect(rows(made)[0]).toMatchObject({ row: { companions: ['Ada', 'Grace'], photos } });
  });

  it('refuses, with the sentence, no choice, a new place with no name, a moment that is not one, and a moment in the future', () => {
    const fail = (result: ReturnType<typeof planCheckIn>) => {
      expect(result.ok).toBe(false);
      return result.ok ? undefined : result;
    };
    expect(fail(planCheckIn(undefined, PLACES, {}, ctx()))?.reason).toBe('place_missing');
    expect(
      fail(planCheckIn({ kind: 'new', name: '  ', point: HERE }, PLACES, {}, ctx()))?.reason,
    ).toBe('place_name');
    expect(
      fail(
        planCheckIn(
          { kind: 'place', place: FLORE },
          PLACES,
          { local: { date: '2026-02-30', time: '10:00' } },
          ctx(),
        ),
      )?.reason,
    ).toBe('moment');
    const future = fail(
      planCheckIn(
        { kind: 'place', place: FLORE },
        PLACES,
        { local: { date: '2026-07-05', time: '10:00' } },
        ctx(),
      ),
    );
    expect(future).toMatchObject({
      reason: 'future',
      sentence: "A check-in can't be in the future.",
    });
    expect(
      fail(planCheckIn({ kind: 'place', place: FLORE }, PLACES, { note: 'x'.repeat(2001) }, ctx()))
        ?.reason,
    ).toBe('note');
  });
});

describe('changing a check-in', () => {
  const CURRENT = {
    id: 'c1',
    placeId: 'flore',
    at: Date.UTC(2026, 5, 1, 8, 30),
    tz: 'Europe/Paris',
    offsetMin: 120,
    note: 'first',
    companions: ['Ada'],
    tripId: null,
    linkSource: null,
    share: 'trip' as const,
    source: 'live' as const,
    version: 3,
  };
  const SAME = {
    local: { date: '2026-06-01', time: '10:30' },
    note: 'first',
    companions: ['Ada'],
    photos: [] as string[],
  };
  const row = (result: ReturnType<typeof planEdit>) => {
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) throw new Error(result.sentence);
    expect(parseMutation(JSON.parse(JSON.stringify(result.mutation)), NOW).ok).toBe(true);
    const change = result.mutation.changes[0];
    return change?.table === 'checkin' && change.op === 'put'
      ? { ...change.row, baseVersion: change.baseVersion }
      : undefined;
  };

  it('changes only what differs: the note, with the version it was made from, and the moment is not worked out again', () => {
    expect(row(planEdit(CURRENT, undefined, { ...SAME, note: 'second' }, ctx()))).toMatchObject({
      note: 'second',
      at: CURRENT.at,
      source: 'live',
      baseVersion: 3,
    });
  });

  it('takes a note away when it is cleared, changes companions, and reorders and takes away photos', () => {
    expect(
      row(
        planEdit(
          { ...CURRENT, photos: ['11111111-1111-4111-8111-111111111111'] },
          undefined,
          { ...SAME, note: '  ', companions: [] },
          ctx(),
        ),
      ),
    ).not.toHaveProperty('note');
    const a = '11111111-1111-4111-8111-111111111111';
    const b = '22222222-2222-4222-8222-222222222222';
    expect(
      row(planEdit({ ...CURRENT, photos: [a, b] }, undefined, { ...SAME, photos: [b] }, ctx())),
    ).toMatchObject({ photos: [b] });
    expect(
      row(planEdit({ ...CURRENT, photos: [a, b] }, undefined, { ...SAME, photos: [b, a] }, ctx())),
    ).toMatchObject({ photos: [b, a] });
    expect(
      row(
        planEdit(
          { ...CURRENT, photos: [a] },
          undefined,
          { ...SAME, note: 'x', photos: [a, b] },
          ctx(),
        ),
      ),
    ).toMatchObject({ photos: [a, b] });
  });

  it('reads a changed moment on the clock where the check-in is, and on the new place’s clock when the place changes', () => {
    expect(
      row(
        planEdit(
          CURRENT,
          undefined,
          { ...SAME, local: { date: '2026-06-02', time: '23:59' } },
          ctx(),
        ),
      ),
    ).toMatchObject({
      at: Date.UTC(2026, 5, 2, 21, 59),
      tz: 'Europe/Paris',
      offsetMin: 120,
      source: 'live',
    });
    const moved = row(
      planEdit(
        CURRENT,
        { kind: 'place', place: LISBON },
        { ...SAME, local: { date: '2026-06-01', time: '09:00' } },
        ctx(),
      ),
    );
    expect(moved).toMatchObject({
      placeId: 'lisbon',
      tz: 'Europe/Lisbon',
      at: Date.UTC(2026, 5, 1, 8, 0),
      offsetMin: 60,
    });
  });

  it('is refused, with the sentence, when nothing changed, when the moment is not one, or is in the future', () => {
    const fail = (r: ReturnType<typeof planEdit>) => (r.ok ? undefined : r);
    expect(fail(planEdit(CURRENT, undefined, SAME, ctx()))).toMatchObject({
      reason: 'nothing',
      sentence: 'Nothing was changed.',
    });
    expect(
      fail(planEdit(CURRENT, { kind: 'place', place: { ...FLORE, id: 'flore' } }, SAME, ctx()))
        ?.reason,
    ).toBe('nothing');
    expect(
      fail(
        planEdit(
          CURRENT,
          undefined,
          { ...SAME, local: { date: '2026-02-30', time: '10:00' } },
          ctx(),
        ),
      )?.reason,
    ).toBe('moment');
    expect(
      fail(
        planEdit(
          CURRENT,
          undefined,
          { ...SAME, local: { date: '2026-07-05', time: '10:00' } },
          ctx(),
        ),
      ),
    ).toMatchObject({ reason: 'future' });
    expect(
      fail(planEdit(CURRENT, undefined, { ...SAME, note: 'x'.repeat(2001) }, ctx()))?.reason,
    ).toBe('note');
  });
});
