import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { validateCheckinRow } from '../checkins/validate';
import { placeRowOf } from '../actions/places';
import { DECADE, MOVED_ON, type SeedOptions, generateCheckins } from './checkins';

/** The seed's check-ins (task 16.1): the same every time, valid for the write path, and shaped like a life that every screen has something to show for. */
const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 12, 9, 0, 0);
const OPTIONS: SeedOptions = { ...DECADE, now: NOW, salt: 'ada' };
const decade = [...generateCheckins(OPTIONS)];

describe('a decade of check-ins', () => {
  it('is the same every time it is made', () => {
    const again = [...generateCheckins(OPTIONS)];
    expect(again.map((item) => [item.externalId, item.at])).toEqual(
      decade.map((item) => [item.externalId, item.at]),
    );
  });

  it('goes back ten years, never past now, in order, each with an id of its own', () => {
    expect(decade.length).toBeGreaterThan(3000);
    expect(new Set(decade.map((item) => item.externalId)).size).toBe(decade.length);
    expect(Math.max(...decade.map((item) => item.at))).toBeLessThanOrEqual(NOW);
    const first = decade[0]?.at ?? 0;
    expect((NOW - first) / DAY).toBeGreaterThan(365 * 9.5);
    for (let i = 1; i < decade.length; i += 1)
      expect(decade[i]?.at ?? 0, `at ${i}`).toBeGreaterThanOrEqual(decade[i - 1]?.at ?? 0);
  });

  it('is accepted by the rules the write path applies to a place and a check-in', () => {
    for (const item of decade) {
      expect(placeRowOf({ ...item.place }).ok, item.place.name).toBe(true);
      const row = validateCheckinRow(
        {
          placeId: 'p',
          at: item.at,
          tz: item.tz,
          offsetMin: item.offsetMin,
          note: item.note,
          companions: [...(item.companions ?? [])],
          tripId: null,
          linkSource: null,
          share: 'trip',
          source: 'manual',
          photos: (item.photos ?? []).map(() => randomUUID()),
        },
        NOW,
      );
      expect(row.ok, item.externalId).toBe(true);
    }
  });

  it('crosses many countries and time zones, and lives in two cities', () => {
    const countries = new Set(decade.map((item) => item.place.address?.countryCode));
    const zones = new Set(decade.map((item) => item.tz));
    expect(countries.size).toBeGreaterThanOrEqual(10);
    expect(zones.size).toBeGreaterThanOrEqual(10);
    const cities = new Set(decade.map((item) => item.place.address?.city));
    expect(cities.has('Berlin')).toBe(true);
    expect(cities.has('Lisbon')).toBe(true);
    const moved = Date.parse(`${MOVED_ON}T00:00:00Z`);
    expect(decade.some((item) => item.at < moved && item.place.address?.city === 'Berlin')).toBe(
      true,
    );
    expect(decade.some((item) => item.at > moved && item.place.address?.city === 'Berlin')).toBe(
      false,
    );
  });

  it('has places visited many times, and many visited once or twice', () => {
    const counts = new Map<string, number>();
    for (const item of decade) {
      const key = item.place.key ?? '';
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    expect(Math.max(...counts.values())).toBeGreaterThanOrEqual(100);
    expect([...counts.values()].filter((n) => n <= 2).length).toBeGreaterThanOrEqual(5);
    expect(counts.size).toBeGreaterThanOrEqual(50);
  });

  it('has photos, notes and companions, mostly while away', () => {
    const photos = decade.filter((item) => (item.photos?.length ?? 0) > 0);
    expect(photos.length).toBeGreaterThan(150);
    expect(decade.filter((item) => item.note).length).toBeGreaterThan(300);
    expect(decade.filter((item) => item.companions?.length).length).toBeGreaterThan(100);
    expect(photos.every((item) => (item.photos?.length ?? 0) <= 10)).toBe(true);
  });

  it('is the same on another day: what is there already is what is made again', () => {
    const later = [...generateCheckins({ ...OPTIONS, now: NOW + 3 * DAY })];
    const before = new Set(decade.map((item) => `${item.externalId}@${item.at}`));
    const overlap = later.filter((item) => item.at <= NOW);
    expect(overlap.length).toBeGreaterThan(3000);
    for (const item of overlap) expect(before.has(`${item.externalId}@${item.at}`)).toBe(true);
  });

  it('differs between people, and a quieter life has fewer', () => {
    const grace = [...generateCheckins({ ...OPTIONS, salt: 'grace', years: 1, density: 0.3 })];
    expect(grace.length).toBeGreaterThan(50);
    expect(grace.length).toBeLessThan(decade.length / 5);
    expect(grace[0]?.externalId).not.toBe(decade[0]?.externalId);
  });

  it('loads a photo only when the job asks, with the picture the caller makes', async () => {
    const withPhotos = [
      ...generateCheckins({
        ...OPTIONS,
        years: 1,
        photo: (key) => Promise.resolve(Buffer.from(key)),
      }),
    ].find((item) => (item.photos?.length ?? 0) > 0);
    const photo = withPhotos?.photos?.[0];
    expect((await photo?.load())?.toString()).toBe(photo?.key);
    const bare = [...generateCheckins({ ...OPTIONS, years: 1 })].find(
      (item) => (item.photos?.length ?? 0) > 0,
    );
    await expect(bare?.photos?.[0]?.load()).rejects.toThrow();
  });
});
