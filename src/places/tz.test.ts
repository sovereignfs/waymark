import { describe, expect, it } from 'vitest';
import {
  inZone,
  isZone,
  localDate,
  localTime,
  momentOf,
  offsetMinutes,
  partsOf,
  zoneOf,
} from './tz';

describe('the zone of a point', () => {
  it.each([
    ['Tokyo Tower', 35.6586, 139.7454, 'Asia/Tokyo'],
    ['Lisbon', 38.7223, -9.1393, 'Europe/Lisbon'],
    ['Reykjavík', 64.1466, -21.9426, 'Atlantic/Reykjavik'],
    ['Sydney', -33.8688, 151.2093, 'Australia/Sydney'],
    ['Kathmandu, a quarter of an hour off', 27.7172, 85.324, 'Asia/Kathmandu'],
    ['Honolulu', 21.3069, -157.8583, 'Pacific/Honolulu'],
  ])('finds %s', (_name, lat, lng, zone) => expect(zoneOf(lat, lng)).toBe(zone));

  it('tells the two sides of a border apart: Elvas in Portugal and Badajoz in Spain, a few kilometres apart', () => {
    expect(zoneOf(38.8802, -7.1632)).toBe('Europe/Lisbon');
    expect(zoneOf(38.8794, -6.9707)).toBe('Europe/Madrid');
  });

  it('tells the two sides of the date line apart: Kiritimati is a day and two hours ahead of Honolulu, and Tonga and Samoa are on the far side', () => {
    expect(zoneOf(-13.8333, -171.7667)).toBe('Pacific/Apia');
    expect(zoneOf(-21.139, -175.2)).toBe('Pacific/Tongatapu');
    expect(zoneOf(1.8721, -157.4278)).toBe('Pacific/Kiritimati');
    expect(zoneOf(21.3069, -157.8583)).toBe('Pacific/Honolulu');
    // A line of longitude is not a zone: the one island of Fiji that the 180th meridian crosses is one zone on both sides of it.
    expect(zoneOf(-16.5, 179.9)).toBe(zoneOf(-16.5, -179.9));
    expect(offsetMinutes(Date.UTC(2026, 5, 1), 'Pacific/Kiritimati')).toBe(14 * 60);
  });

  it('answers for a point at sea, at the poles and on the line, and for none that is not on the globe', () => {
    expect(zoneOf(0, 0)).toMatch(/^[A-Za-z_]+\/?[A-Za-z_+\-0-9]*$/);
    expect(zoneOf(-90, 0)).toBeDefined();
    expect(zoneOf(90, 180)).toBeDefined();
    expect(zoneOf(35, -180)).toBeDefined();
    for (const [lat, lng] of [
      [91, 0],
      [0, 181],
      [Number.NaN, 0],
      [0, Infinity],
      [-90.1, 0],
    ])
      expect(zoneOf(lat as number, lng as number)).toBeUndefined();
  });

  it('gives a name this runtime knows, for every point of a sweep of the globe', () => {
    for (let lat = -80; lat <= 80; lat += 20)
      for (let lng = -170; lng <= 170; lng += 20) {
        const zone = zoneOf(lat, lng);
        expect(zone, `${lat},${lng}`).toBeDefined();
        expect(isZone(zone ?? ''), `${lat},${lng} ${zone}`).toBe(true);
      }
    expect(isZone('Not/AZone')).toBe(false);
  });
});

describe('what a moment is in a zone', () => {
  // 31 December 2026, 23:59 and then 00:01 on 1 January 2027, on Auckland's clock (UTC+13 in summer): one moment per side of midnight.
  const before = Date.UTC(2026, 11, 31, 10, 59);
  const after = Date.UTC(2026, 11, 31, 11, 1);

  it('puts 23:59 and 00:01 on the right dates, in the zone and not the machine’s', () => {
    expect(localDate(before, 'Pacific/Auckland')).toBe('2026-12-31');
    expect(localTime(before, 'Pacific/Auckland')).toBe('23:59');
    expect(localDate(after, 'Pacific/Auckland')).toBe('2027-01-01');
    expect(localTime(after, 'Pacific/Auckland')).toBe('00:01');
    // The same two moments, elsewhere: still the 31st in London, already the 1st in Tokyo and Kiritimati; and midnight is 00:00 and never 24:00.
    expect(localDate(after, 'Europe/London')).toBe('2026-12-31');
    expect(localDate(after, 'Asia/Tokyo')).toBe('2026-12-31');
    expect(localDate(after, 'Pacific/Kiritimati')).toBe('2027-01-01');
    expect(localTime(Date.UTC(2026, 11, 31, 11, 0), 'Pacific/Auckland')).toBe('00:00');
  });

  it('is the same wherever the machine is: the reading is of the zone given', () => {
    const p = partsOf(Date.UTC(2026, 6, 4, 12, 30, 45), 'America/New_York');
    expect(p).toEqual({ year: 2026, month: 7, day: 4, hour: 8, minute: 30, second: 45 });
  });

  it('knows the offset, in minutes east, including quarters of an hour and a change of clocks', () => {
    expect(offsetMinutes(Date.UTC(2026, 0, 15), 'Asia/Tokyo')).toBe(540);
    expect(offsetMinutes(Date.UTC(2026, 0, 15), 'Pacific/Honolulu')).toBe(-600);
    expect(offsetMinutes(Date.UTC(2026, 0, 15), 'Asia/Kathmandu')).toBe(345);
    expect(offsetMinutes(Date.UTC(2026, 0, 15), 'America/New_York')).toBe(-300);
    expect(offsetMinutes(Date.UTC(2026, 6, 15), 'America/New_York')).toBe(-240);
    expect(offsetMinutes(Date.UTC(2026, 5, 15), 'Europe/London')).toBe(60);
  });

  it('says the date, the time, the offset and the zone of a moment as one value', () => {
    expect(inZone(Date.UTC(2026, 11, 31, 11, 1), 'Pacific/Auckland')).toEqual({
      date: '2027-01-01',
      time: '00:01',
      offsetMin: 780,
      zone: 'Pacific/Auckland',
    });
  });
});

describe('the moment a local date and time is', () => {
  it('is the inverse of reading the wall clock, in every zone and at the edges of a day', () => {
    for (const zone of [
      'Asia/Tokyo',
      'Pacific/Honolulu',
      'Pacific/Kiritimati',
      'Asia/Kathmandu',
      'Europe/Lisbon',
      'America/New_York',
    ])
      for (const [date, time] of [
        ['2026-12-31', '23:59'],
        ['2027-01-01', '00:01'],
        ['2026-03-01', '00:00'],
        ['2026-07-04', '12:30'],
      ] as const) {
        const ms = momentOf(date, time, zone);
        expect(ms, `${zone} ${date} ${time}`).toBeDefined();
        expect(localDate(ms ?? 0, zone)).toBe(date);
        expect(localTime(ms ?? 0, zone)).toBe(time);
      }
    expect(momentOf('2027-01-01', '00:01', 'Pacific/Auckland')).toBe(Date.UTC(2026, 11, 31, 11, 1));
  });

  it('takes the first of a time that happens twice when the clocks go back (New York, 1 November 2026, 01:30)', () => {
    const ms = momentOf('2026-11-01', '01:30', 'America/New_York');
    expect(ms).toBe(Date.UTC(2026, 10, 1, 5, 30)); // 01:30 EDT, the first time round
    expect(offsetMinutes(ms ?? 0, 'America/New_York')).toBe(-240);
  });

  it('gives the moment the clock would have reached for a time that never happens when they go forward (New York, 8 March 2026, 02:30)', () => {
    const ms = momentOf('2026-03-08', '02:30', 'America/New_York');
    expect(ms).toBeDefined();
    // The clock jumps from 02:00 to 03:00, so 02:30 is 03:30 EDT, which is one hour and thirty minutes after 01:00 EST.
    expect(localTime(ms ?? 0, 'America/New_York')).toBe('03:30');
  });

  it('refuses a date or time that is not one', () => {
    for (const [date, time] of [
      ['2026-02-30', '12:00'],
      ['2026-13-01', '12:00'],
      ['2026-12-31', '24:00'],
      ['2026-12-31', '12:60'],
      ['2026-1-1', '12:00'],
      ['2026-12-31', '9:00'],
      ['', ''],
    ] as const)
      expect(momentOf(date, time, 'Asia/Tokyo'), `${date} ${time}`).toBeUndefined();
  });
});
