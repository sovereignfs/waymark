import tzLookup from 'tz-lookup';

/**
 * Time zones (DESIGN.md §7.3). **One implementation, shared by the device, the server and the tests** (`AGENTS.md`): the zone of a point, found from a bundled boundary table
 * with no network (`tz-lookup`, CC0, 150 KB; its data is Evan Siroky's timezone-boundary-builder, which is ODbL, credited in the README's notices), and the pure helpers that say
 * what a moment is in a zone: its local date, time and offset, and the moment a local date and time is. They take the moment and the zone as arguments and read no clock, so auto-link (9.7),
 * today (13.1) and the timeline give the same answer on a device in one zone and a server in another, across the date line and on the night a clock changes.
 */

/** The IANA zone of a point, or `undefined` for a point that is not on the globe. The sea has a zone too (an offset one, `Etc/GMT…`, in international waters). */
export function zoneOf(latitude: number, longitude: number): string | undefined {
  if (
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude) ||
    Math.abs(latitude) > 90 ||
    Math.abs(longitude) > 180
  )
    return undefined;
  try {
    return tzLookup(latitude, longitude);
  } catch {
    return undefined;
  }
}

/** Whether a name is a zone this runtime knows. */
export function isZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

const formats = new Map<string, Intl.DateTimeFormat>();
function formatFor(zone: string): Intl.DateTimeFormat {
  let format = formats.get(zone);
  if (!format) {
    // `hourCycle: 'h23'` so that midnight is 00 and never 24; the numeric parts are read, so no locale's digits or order are depended on.
    format = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formats.set(zone, format);
  }
  return format;
}

export interface LocalParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
}

/** What the wall clock in `zone` says at the moment `ms`. */
export function partsOf(ms: number, zone: string): LocalParts {
  const out: Record<string, number> = {};
  for (const part of formatFor(zone).formatToParts(new Date(ms)))
    if (part.type !== 'literal') out[part.type] = Number(part.value);
  return {
    year: out.year ?? 0,
    month: out.month ?? 0,
    day: out.day ?? 0,
    hour: out.hour ?? 0,
    minute: out.minute ?? 0,
    second: out.second ?? 0,
  };
}

const pad = (n: number, width = 2) => String(n).padStart(width, '0');

/** The local date at a moment, `YYYY-MM-DD` (DESIGN.md §24.2). */
export function localDate(ms: number, zone: string): string {
  const p = partsOf(ms, zone);
  return `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)}`;
}

/** The local time at a moment, `HH:mm`. */
export function localTime(ms: number, zone: string): string {
  const p = partsOf(ms, zone);
  return `${pad(p.hour)}:${pad(p.minute)}`;
}

/** The zone's offset from UTC at a moment, in minutes east (so Tokyo is 540 and Honolulu −600). It changes on the night a clock does. */
export function offsetMinutes(ms: number, zone: string): number {
  const p = partsOf(ms, zone);
  // The wall clock read as if it were UTC, less the moment itself (to the minute: the seconds are the same on both).
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUtc - Math.floor(ms / 1000) * 1000) / 60_000);
}

/**
 * The moment at which the wall clock in `zone` says `date` (`YYYY-MM-DD`) and `time` (`HH:mm`). Where a clock goes back and that time happens twice, the **first** is taken; where
 * it goes forward and the time never happens, the moment is the one the clock would have reached, as `Date` would, so a time is never refused. `undefined` for a date or time that
 * is not one.
 */
export function momentOf(date: string, time: string, zone: string): number | undefined {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const t = /^(\d{2}):(\d{2})$/.exec(time);
  if (!d || !t) return undefined;
  const [year, month, day, hour, minute] = [d[1], d[2], d[3], t[1], t[2]].map(Number) as [
    number,
    number,
    number,
    number,
    number,
  ];
  const asUtc = Date.UTC(year, month - 1, day, hour, minute);
  if (new Date(asUtc).getUTCMonth() !== month - 1 || hour > 23 || minute > 59) return undefined;
  // The offset is found at a guess and then at the moment that guess gives, until it stops moving; both offsets around a change are tried, and the earlier moment wins.
  const first = asUtc - offsetMinutes(asUtc, zone) * 60_000;
  const second = asUtc - offsetMinutes(first, zone) * 60_000;
  const candidates = [first, second].filter(
    (ms) => localDate(ms, zone) === date && localTime(ms, zone) === time,
  );
  if (candidates.length > 0) return Math.min(...candidates);
  // The time falls in a gap: the clock jumped over it. The moment after the jump keeps the offset from before it.
  return Math.max(first, second);
}

/** The local date, time and offset of a moment as one value, for a check-in or a stop: what is shown, and what is kept (`tz` and `offset_min`, DESIGN.md §24.3). */
export function inZone(
  ms: number,
  zone: string,
): { date: string; time: string; offsetMin: number; zone: string } {
  return {
    date: localDate(ms, zone),
    time: localTime(ms, zone),
    offsetMin: offsetMinutes(ms, zone),
    zone,
  };
}
