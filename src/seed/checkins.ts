import { createHash } from 'node:crypto';
import type { ImportItem } from '../import/job';
import { offsetMinutes } from '../places/tz';
import { BERLIN, DESTINATIONS, LISBON, type SeedCity, type SeedPlace } from './places';

/**
 * The check-ins of the development seed (task 16.1): years of a life, made from nothing but a date. **Pure and repeatable**: a day's check-ins come from a generator started from that day's date, and
 * each has an id made from the date and its place in the day, so running the seed again, or on another day, makes only what is new and nothing twice. Nothing is fetched and nothing is random.
 *
 * What it makes: a week at home (the first place of a base is visited most, so a few places are visited hundreds of times), trips away of three to nine days a few times a year (several check-ins a day, in
 * another zone and another country), a move from one base to another part way, notes and companions here and there, and a photo on one check-in in five while away.
 */
export interface SeedOptions {
  /** The moment the seed runs, which is the last moment a check-in may be at. */
  readonly now: number;
  /** How many years back it starts. */
  readonly years: number;
  /** What makes one account's days differ from another's. */
  readonly salt: string;
  /** How often a day at home has check-ins, 0 to 1. */
  readonly density: number;
  /** How many trips away there are in a year. */
  readonly tripsPerYear: number;
  /** Makes the picture of a photo from its key (`images.ts`); without it a photo cannot be loaded, which a test of the dates and places does not need. */
  readonly photo?: ((key: string) => Promise<Buffer>) | undefined;
}

export const DECADE: Pick<SeedOptions, 'years' | 'density' | 'tripsPerYear'> = {
  years: 10,
  density: 0.45,
  tripsPerYear: 3,
};

/** The day the person moved from Berlin to Lisbon: a fixed date, so that a second run on another day makes the same days. */
export const MOVED_ON = '2022-09-01';

const DAY_MS = 86_400_000;

function hash(text: string): number {
  return createHash('sha256').update(text).digest().readUInt32LE(0);
}

/** A small deterministic generator (mulberry32): the same seed gives the same numbers, on every machine. */
export function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const isoDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
const dayStart = (iso: string): number => Date.parse(`${iso}T00:00:00Z`);

/** One of `items`, the first ones much more often than the last (each is two thirds as likely as the one before it). */
function weighted<T>(items: readonly T[], random: () => number): T {
  let total = 0;
  const weights = items.map((_, i) => {
    const weight = Math.pow(2 / 3, i);
    total += weight;
    return weight;
  });
  let pick = random() * total;
  for (let i = 0; i < items.length; i += 1) {
    pick -= weights[i] ?? 0;
    if (pick <= 0) return items[i] as T;
  }
  return items[items.length - 1] as T;
}

const pick = <T>(items: readonly T[], random: () => number): T =>
  items[Math.floor(random() * items.length)] as T;

const NOTES_HOME = [
  'The usual.',
  'Rain all morning, so a long one.',
  'Finished the chapter I had been putting off.',
  'Met by chance, stayed an hour.',
  'Quiet today.',
  'New seasonal menu. Not sure about it.',
  'Good light.',
  'Left early, forgot my umbrella.',
];
const NOTES_AWAY = [
  'Worth the queue.',
  'Got lost on the way and found this instead.',
  'Better than the guidebook said.',
  'Too hot to walk any further.',
  'We were the only ones there.',
  'Ordered by pointing. No regrets.',
  'Sunset from here is something.',
  'Will come back.',
  'The long way round, on purpose.',
  'Rainy, and lovely anyway.',
];
const COMPANIONS = ['Sam', 'Noor', 'Mateus', 'Ines', 'Jonas', 'Priya', 'Tomás', 'Leila'];

/** A trip away: when it starts, how long, and where. Decided from the year alone, so every day inside it agrees without remembering the others. */
interface Away {
  readonly start: number;
  readonly days: number;
  readonly city: SeedCity;
  readonly companion: string | undefined;
}

function tripsOf(year: number, options: SeedOptions): readonly Away[] {
  const random = rng(hash(`waymark-seed:trips:${options.salt}:${year}`));
  const trips: Away[] = [];
  for (let i = 0; i < options.tripsPerYear; i += 1) {
    // Spread over the year, so that they do not pile up: the i-th gets its own part.
    const part = 365 / options.tripsPerYear;
    const first = Date.UTC(year, 0, 1) + (i * part + random() * (part - 12)) * DAY_MS;
    trips.push({
      start: dayStart(isoDay(first)),
      days: 3 + Math.floor(random() * 7),
      city: pick(DESTINATIONS, random),
      companion: random() < 0.5 ? pick(COMPANIONS, random) : undefined,
    });
  }
  return trips;
}

function awayOn(day: number, options: SeedOptions): Away | undefined {
  const year = new Date(day).getUTCFullYear();
  for (const y of [year - 1, year]) {
    for (const trip of tripsOf(y, options))
      if (day >= trip.start && day < trip.start + trip.days * DAY_MS) return trip;
  }
  return undefined;
}

/** The local time `hour:minute` on a day in a zone, as the moment it is: found twice, so that the offset is the one in force at that moment. */
function momentOf(day: number, hour: number, minute: number, tz: string): number {
  const local = day + (hour * 60 + minute) * 60_000;
  const guess = local - offsetMinutes(local, tz) * 60_000;
  return local - offsetMinutes(guess, tz) * 60_000;
}

/** The base the person lived in on a day. */
export const baseOn = (day: number): SeedCity => (day < dayStart(MOVED_ON) ? BERLIN : LISBON);

function itemOf(
  day: number,
  slot: number,
  city: SeedCity,
  where: SeedPlace,
  random: () => number,
  away: Away | undefined,
  hour: number,
  options: SeedOptions,
): ImportItem {
  const minute = Math.floor(random() * 60);
  const at = momentOf(day, hour, minute, city.tz);
  const externalId = `seed:${options.salt}:${isoDay(day)}:${slot}`;
  const noted = random() < (away ? 0.35 : 0.12);
  const accompanied = away?.companion !== undefined ? random() < 0.6 : random() < 0.08;
  const photoCount = away
    ? random() < 0.2
      ? 1 + Math.floor(random() * 2)
      : 0
    : random() < 0.02
      ? 1
      : 0;
  return {
    externalId,
    at,
    tz: city.tz,
    offsetMin: offsetMinutes(at, city.tz),
    ...(noted ? { note: pick(away ? NOTES_AWAY : NOTES_HOME, random) } : {}),
    ...(accompanied ? { companions: [away?.companion ?? pick(COMPANIONS, random)] } : {}),
    source: 'manual',
    ...(photoCount > 0
      ? {
          photos: Array.from({ length: photoCount }, (_, n) => ({
            key: `${externalId}:${n}`,
            // The picture is made when the job asks for it, one at a time, and nothing is kept in memory meanwhile.
            load: () =>
              options.photo
                ? options.photo(`${externalId}:${n}`)
                : Promise.reject(new Error('this seed has no pictures')),
          })),
        }
      : {}),
    place: {
      key: where.key,
      name: where.name,
      lat: where.lat,
      lng: where.lng,
      address: where.address,
      category: where.category,
      source: where.source,
      tz: city.tz,
    },
  };
}

/** What a day holds: the check-ins of the person on `day` (a UTC midnight), oldest first. */
export function checkinsOnDay(day: number, options: SeedOptions): ImportItem[] {
  const random = rng(hash(`waymark-seed:day:${options.salt}:${isoDay(day)}`));
  const away = awayOn(day, options);
  const items: ImportItem[] = [];
  if (away) {
    const count = 3 + Math.floor(random() * 3);
    const hours = [9, 11, 13, 16, 19, 21].slice(0, count);
    hours.forEach((hour, slot) =>
      items.push(
        itemOf(
          day,
          slot,
          away.city,
          weighted(away.city.places, random),
          random,
          away,
          hour,
          options,
        ),
      ),
    );
    return items;
  }
  if (random() >= options.density) return items;
  const base = baseOn(day);
  // Weekdays are for the first places (the café, the workplace), weekends for the others.
  const weekend = [0, 6].includes(new Date(day).getUTCDay());
  const count = 1 + Math.floor(random() * 3);
  const pool = weekend ? base.places.slice(3) : base.places;
  const hours = [8, 12, 18, 21];
  for (let slot = 0; slot < count; slot += 1)
    items.push(
      itemOf(
        day,
        slot,
        base,
        weighted(pool, random),
        random,
        undefined,
        hours[slot] ?? 20,
        options,
      ),
    );
  return items;
}

/** Every check-in from `options.years` ago to now, oldest first, never at a moment after `now`. */
export function* generateCheckins(options: SeedOptions): Generator<ImportItem> {
  const today = dayStart(isoDay(options.now));
  const first = dayStart(
    isoDay(
      Date.UTC(
        new Date(today).getUTCFullYear() - options.years,
        new Date(today).getUTCMonth(),
        new Date(today).getUTCDate(),
      ),
    ),
  );
  for (let day = first; day <= today; day += DAY_MS)
    for (const item of checkinsOnDay(day, options)) if (item.at <= options.now) yield item;
}
