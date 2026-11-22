import { describe, expect, it } from 'vitest';
import { gatheredRecords, timed } from './core-export';

/** A person's part of core's export (`signIn.export`): what Waymark's own export gathers, as records of the export format. */
type Gathered = Parameters<typeof gatheredRecords>[0];

const gathered = (over: Partial<Gathered> = {}): Gathered =>
  ({
    profile: { name: 'Ada', units: 'metric', weekStart: 1, shareDefault: 'private' },
    prefs: { trip_starts: { email: true } },
    places: [{ id: 'p1', name: 'Café', createdAt: Date.UTC(2026, 0, 1) }],
    checkins: [],
    trips: [],
    files: [],
    ...over,
  }) as unknown as Gathered;

describe('what Waymark gathers, as records', () => {
  it('is the profile, the email settings and every kind that has something, under the app’s own folder', () => {
    expect(gatheredRecords(gathered()).map(({ path, kind }) => [path, kind])).toEqual([
      ['apps/waymark/records/profile.jsonl', 'profile'],
      ['apps/waymark/records/settings.jsonl', 'settings'],
      ['apps/waymark/records/places.jsonl', 'places'],
    ]);
  });

  it('writes a time in milliseconds as ISO 8601 in UTC, nested or not', () => {
    const places = gatheredRecords(gathered()).find((each) => each.kind === 'places');
    expect(places?.records[0]).toEqual({
      id: 'p1',
      name: 'Café',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    expect(timed({ stops: [{ arrivedAt: 0 }] })).toEqual({
      stops: [{ arrivedAt: '1970-01-01T00:00:00.000Z' }],
    });
  });

  it('holds the email settings and the profile, and no address', () => {
    const text = JSON.stringify(gatheredRecords(gathered()));
    expect(text).toContain('"trip_starts":true');
    expect(text).not.toContain('@');
  });
});
