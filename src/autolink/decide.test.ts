import { describe, expect, it } from 'vitest';
import { type Candidate, type Facts, NEAR_METRES, daysOf, decide, reconcile } from './decide';

/** Auto-link (DESIGN.md §12): the fixtures of the design, and that the order trips are given in never changes the answer. */
const LISBON = { lat: 38.7223, lng: -9.1393 };
const PORTO = { lat: 41.1579, lng: -8.6291 };
const BERLIN = { lat: 52.52, lng: 13.405 };
const PRAGUE = { lat: 50.0755, lng: 14.4378 };
const AUCKLAND = { lat: -36.8485, lng: 174.7633 };

let created = 0;
const trip = (
  id: string,
  stops: [string, string, { lat: number; lng: number }?][],
  over: Partial<Candidate> = {},
): Candidate => {
  const dated = stops.map(([arrive, depart, point]) => ({ arrive, depart, point }));
  return {
    id,
    createdAt: (created += 1),
    goes: true,
    startDate: dated.map((s) => s.arrive).sort()[0] ?? null,
    endDate:
      dated
        .map((s) => s.depart)
        .sort()
        .at(-1) ?? null,
    stops: dated,
    ...over,
  };
};
const moment = (iso: string) => Date.parse(iso);
const at = (iso: string, tz: string, point?: { lat: number; lng: number }): Facts => ({
  at: moment(iso),
  tz,
  point,
});

describe('candidates', () => {
  it('are the trips the person goes on whose dates contain the check-in’s local date', () => {
    const lisbon = trip('lisbon', [['2026-05-10', '2026-05-14', LISBON]]);
    expect(decide(at('2026-05-10T09:00:00+01:00', 'Europe/Lisbon', LISBON), [lisbon])).toBe(
      'lisbon',
    );
    expect(decide(at('2026-05-14T23:59:00+01:00', 'Europe/Lisbon', LISBON), [lisbon])).toBe(
      'lisbon',
    );
    expect(
      decide(at('2026-05-09T23:59:00+01:00', 'Europe/Lisbon', LISBON), [lisbon]),
    ).toBeUndefined();
    expect(
      decide(at('2026-05-15T00:00:00+01:00', 'Europe/Lisbon', LISBON), [lisbon]),
    ).toBeUndefined();
  });

  it('are not trips the person does not go on, or that have no dates', () => {
    const follower = trip('follower', [['2026-05-10', '2026-05-14', LISBON]], { goes: false });
    const undated = trip('undated', [], { startDate: null, endDate: null });
    expect(
      decide(at('2026-05-12T12:00:00Z', 'Europe/Lisbon', LISBON), [follower, undated]),
    ).toBeUndefined();
    expect(decide(at('2026-05-12T12:00:00Z', 'Europe/Lisbon', LISBON), [])).toBeUndefined();
  });

  it('use the local date in the check-in’s own zone, across the date line and at 23:59', () => {
    const auckland = trip('auckland', [['2026-05-11', '2026-05-11', AUCKLAND]]);
    // 13:00 UTC on the 10th is 01:00 on the 11th in Auckland: the 11th, whatever the UTC date says.
    expect(decide(at('2026-05-10T13:00:00Z', 'Pacific/Auckland', AUCKLAND), [auckland])).toBe(
      'auckland',
    );
    // And the same instant, made in Honolulu, is 03:00 on the 10th: not that trip.
    expect(
      decide(at('2026-05-10T13:00:00Z', 'Pacific/Honolulu', AUCKLAND), [auckland]),
    ).toBeUndefined();
    // 23:59 in Lisbon on the 14th is the 14th though it is 22:59 UTC; 00:00 on the 15th is not.
    const lisbon = trip('lisbon', [['2026-05-10', '2026-05-14', LISBON]]);
    expect(decide(at('2026-05-14T22:59:00Z', 'Europe/Lisbon', LISBON), [lisbon])).toBe('lisbon');
    expect(decide(at('2026-05-14T23:00:00Z', 'Europe/Lisbon', LISBON), [lisbon])).toBeUndefined();
    // The same instant on the other side of the date line is a different day.
    const tonga = trip('tonga', [['2026-05-11', '2026-05-11', AUCKLAND]]);
    expect(decide(at('2026-05-10T12:30:00Z', 'Pacific/Tongatapu', AUCKLAND), [tonga])).toBe(
      'tonga',
    );
    expect(
      decide(at('2026-05-10T12:30:00Z', 'Pacific/Pago_Pago', AUCKLAND), [tonga]),
    ).toBeUndefined();
  });

  it('is nothing for a zone nobody knows', () => {
    expect(
      decide(at('2026-05-12T12:00:00Z', 'Not/AZone', LISBON), [
        trip('t', [['2026-05-10', '2026-05-14', LISBON]]),
      ]),
    ).toBeUndefined();
  });
});

describe('a work trip and a weekend that share dates', () => {
  // A week in Lisbon for work, and a weekend in Porto that falls inside it (Saturday and Sunday).
  const work = trip('work', [['2026-05-11', '2026-05-17', LISBON]]);
  const weekend = trip('weekend', [['2026-05-16', '2026-05-17', PORTO]]);

  it('go to the stop that is nearest: a check-in in Porto on the Saturday is the weekend’s, and one in Lisbon the work trip’s', () => {
    expect(decide(at('2026-05-16T12:00:00+01:00', 'Europe/Lisbon', PORTO), [work, weekend])).toBe(
      'weekend',
    );
    expect(decide(at('2026-05-16T12:00:00+01:00', 'Europe/Lisbon', LISBON), [work, weekend])).toBe(
      'work',
    );
  });

  it('go to the work trip on the days the weekend is not, and the answer does not depend on the order the trips are given in', () => {
    for (const order of [
      [work, weekend],
      [weekend, work],
    ]) {
      expect(decide(at('2026-05-13T12:00:00+01:00', 'Europe/Lisbon', LISBON), order)).toBe('work');
      expect(decide(at('2026-05-16T12:00:00+01:00', 'Europe/Lisbon', PORTO), order)).toBe(
        'weekend',
      );
    }
  });
});

describe('a travel day', () => {
  it('belongs to both stops, and the nearer one’s trip wins', () => {
    const berlinThenPrague = trip('one-trip', [
      ['2026-06-01', '2026-06-03', BERLIN],
      ['2026-06-03', '2026-06-05', PRAGUE],
    ]);
    // On the 3rd the single trip contains both stops: it is the candidate either way.
    expect(
      decide(at('2026-06-03T09:00:00+02:00', 'Europe/Berlin', BERLIN), [berlinThenPrague]),
    ).toBe('one-trip');
    expect(
      decide(at('2026-06-03T20:00:00+02:00', 'Europe/Prague', PRAGUE), [berlinThenPrague]),
    ).toBe('one-trip');
    // Two trips that meet on the 3rd: each is nearest to its own stop on that day.
    const first = trip('first', [['2026-06-01', '2026-06-03', BERLIN]]);
    const second = trip('second', [['2026-06-03', '2026-06-05', PRAGUE]]);
    expect(decide(at('2026-06-03T09:00:00+02:00', 'Europe/Berlin', BERLIN), [first, second])).toBe(
      'first',
    );
    expect(decide(at('2026-06-03T20:00:00+02:00', 'Europe/Prague', PRAGUE), [second, first])).toBe(
      'second',
    );
  });

  it('measures only the stops that are on the date, so a trip that has left a place is not near it', () => {
    const far = trip('far', [
      ['2026-06-01', '2026-06-02', LISBON],
      ['2026-06-03', '2026-06-04', PRAGUE],
    ]);
    const near = trip('near', [['2026-06-01', '2026-06-04', BERLIN]]);
    // On the 3rd `far` is in Prague, `near` in Berlin: a check-in in Berlin is `near`'s, though `far` was in Lisbon the day before.
    expect(decide(at('2026-06-03T10:00:00+02:00', 'Europe/Berlin', BERLIN), [far, near])).toBe(
      'near',
    );
  });
});

describe('where distance does not decide', () => {
  it('goes to the shorter trip, then the one made first, then the lesser id, however the trips are ordered', () => {
    const longer = trip('b-long', [['2026-07-01', '2026-07-10', LISBON]]);
    const shorter = trip('c-short', [['2026-07-03', '2026-07-05', LISBON]]);
    for (const order of [
      [longer, shorter],
      [shorter, longer],
    ])
      expect(decide(at('2026-07-04T12:00:00+01:00', 'Europe/Lisbon', LISBON), order)).toBe(
        'c-short',
      );
    const early = trip('z-early', [['2026-07-03', '2026-07-05', LISBON]], { createdAt: 1 });
    const late = trip('a-late', [['2026-07-03', '2026-07-05', LISBON]], { createdAt: 2 });
    expect(decide(at('2026-07-04T12:00:00+01:00', 'Europe/Lisbon', LISBON), [late, early])).toBe(
      'z-early',
    );
    const twinA = trip('a-twin', [['2026-07-03', '2026-07-05', LISBON]], { createdAt: 5 });
    const twinB = trip('b-twin', [['2026-07-03', '2026-07-05', LISBON]], { createdAt: 5 });
    for (const order of [
      [twinA, twinB],
      [twinB, twinA],
    ])
      expect(decide(at('2026-07-04T12:00:00+01:00', 'Europe/Lisbon', LISBON), order)).toBe(
        'a-twin',
      );
  });

  it('is by distance only beyond a kilometre: stops within it are alike, and a far one is not', () => {
    const here = { lat: 38.7223, lng: -9.1393 };
    const eightHundred = { lat: 38.7223 + 0.0072, lng: -9.1393 }; // about 800 m north
    const twoKm = { lat: 38.7223 + 0.018, lng: -9.1393 }; // about 2 km north
    const longerButExact = trip('exact', [['2026-07-01', '2026-07-10', here]]);
    const shorterNearby = trip('nearby', [['2026-07-03', '2026-07-05', eightHundred]]);
    const shorterFar = trip('far', [['2026-07-03', '2026-07-05', twoKm]]);
    // 800 m is inside the kilometre, so the shorter trip wins; 2 km is outside it, so the nearer stop wins.
    expect(
      decide(at('2026-07-04T12:00:00+01:00', 'Europe/Lisbon', here), [
        longerButExact,
        shorterNearby,
      ]),
    ).toBe('nearby');
    expect(
      decide(at('2026-07-04T12:00:00+01:00', 'Europe/Lisbon', here), [longerButExact, shorterFar]),
    ).toBe('exact');
    expect(NEAR_METRES).toBe(1000);
  });

  it('is by length, then age, when there is no point to measure from or to', () => {
    const noPoint = trip('no-point', [['2026-07-01', '2026-07-10', undefined]]);
    const shorter = trip('shorter', [['2026-07-03', '2026-07-05', LISBON]]);
    expect(
      decide(at('2026-07-04T12:00:00+01:00', 'Europe/Lisbon', undefined), [noPoint, shorter]),
    ).toBe('shorter');
    expect(
      decide(at('2026-07-04T12:00:00+01:00', 'Europe/Lisbon', LISBON), [noPoint, shorter]),
    ).toBe('shorter');
  });

  it('keeps a trip whose dates contain the day but whose stops do not: it is a candidate with nothing to measure', () => {
    const gap = trip('gap', [
      ['2026-08-01', '2026-08-02', LISBON],
      ['2026-08-05', '2026-08-06', LISBON],
    ]);
    expect(decide(at('2026-08-03T12:00:00+01:00', 'Europe/Lisbon', LISBON), [gap])).toBe('gap');
  });
});

describe('a trip’s days', () => {
  it('are counted on the calendar', () => {
    expect(daysOf({ startDate: '2026-05-10', endDate: '2026-05-10' })).toBe(1);
    expect(daysOf({ startDate: '2026-02-27', endDate: '2026-03-02' })).toBe(4);
    expect(daysOf({ startDate: null, endDate: null })).toBe(Number.MAX_SAFE_INTEGER);
  });
});

describe('what the decision does to a link', () => {
  it('links an unlinked check-in, moves an automatic link, takes one away, and changes nothing that is already so', () => {
    expect(reconcile({ tripId: null, linkSource: null }, 'a')).toEqual({
      tripId: 'a',
      linkSource: 'auto',
    });
    expect(reconcile({ tripId: 'a', linkSource: 'auto' }, 'b')).toEqual({
      tripId: 'b',
      linkSource: 'auto',
    });
    expect(reconcile({ tripId: 'a', linkSource: 'auto' }, undefined)).toEqual({
      tripId: null,
      linkSource: null,
    });
    expect(reconcile({ tripId: 'a', linkSource: 'auto' }, 'a')).toBeUndefined();
    expect(reconcile({ tripId: null, linkSource: null }, undefined)).toBeUndefined();
  });

  it('never changes a link set by hand: not to a trip, and not to none, whatever is decided', () => {
    for (const decided of ['other', undefined, 'mine'])
      for (const manual of [
        { tripId: 'mine', linkSource: 'manual' as const },
        { tripId: null, linkSource: 'manual' as const },
      ])
        expect(reconcile(manual, decided), `${manual.tripId} ${decided}`).toBeUndefined();
  });
});
