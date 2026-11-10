import { describe, expect, it } from 'vitest';
import type { Mutation } from '../sync/format';
import { describeMutation } from './describe';

const AT = Date.UTC(2026, 6, 4, 11, 30);
const checkinRow = (placeId: string) => ({
  placeId,
  at: AT,
  tz: 'Europe/Lisbon',
  offsetMin: 60,
  companions: [],
  tripId: null,
  linkSource: null,
  share: 'trip' as const,
  source: 'live' as const,
});
const place = {
  name: 'Café de Flore',
  lat: 48.8,
  lng: 2.3,
  source: 'manual' as const,
  tz: 'Europe/Paris',
  countryCode: null,
};
const mutation = (changes: Mutation['changes']): Mutation => ({
  mutationId: 'm',
  stream: 'account',
  changes,
});

describe('what a refused change was, in words', () => {
  it('names the place and the moment of a check-in, in the zone it was made in', () => {
    expect(
      describeMutation(mutation([{ table: 'checkin', op: 'put', id: 'c', row: checkinRow('p') }]), [
        { id: 'p', name: 'Sé de Lisboa' },
      ]),
    ).toBe('Check-in at Sé de Lisboa, 4 July 2026 12:30');
  });

  it('names a place made with the check-in from the mutation itself, once, and "a place" for one it knows nothing of', () => {
    expect(
      describeMutation(
        mutation([
          { table: 'place', op: 'put', id: 'p', row: place },
          { table: 'checkin', op: 'put', id: 'c', row: checkinRow('p') },
        ]),
      ),
    ).toBe('Check-in at Café de Flore, 4 July 2026 12:30');
    expect(
      describeMutation(
        mutation([{ table: 'checkin', op: 'put', id: 'c', row: checkinRow('gone') }]),
      ),
    ).toBe('Check-in at a place, 4 July 2026 12:30');
  });

  it('says a place alone, and a delete, and a mutation of several things as each', () => {
    expect(describeMutation(mutation([{ table: 'place', op: 'put', id: 'p', row: place }]))).toBe(
      'Place Café de Flore',
    );
    expect(describeMutation(mutation([{ table: 'checkin', op: 'delete', id: 'c' }]))).toBe(
      'Delete of a check-in',
    );
    expect(describeMutation(mutation([{ table: 'place', op: 'delete', id: 'p' }]))).toBe(
      'Delete of a place',
    );
    expect(
      describeMutation(
        mutation([
          { table: 'checkin', op: 'delete', id: 'c' },
          { table: 'place', op: 'delete', id: 'p' },
        ]),
      ),
    ).toBe('Delete of a check-in; Delete of a place');
  });

  it('is never empty, and does not fall over a zone it does not know', () => {
    expect(describeMutation(mutation([]))).toBe('A change');
    expect(
      describeMutation(
        mutation([
          { table: 'checkin', op: 'put', id: 'c', row: { ...checkinRow('p'), tz: 'Not/AZone' } },
        ]),
      ),
    ).toBe('Check-in at a place, 2026-07-04 11:30');
  });
});
