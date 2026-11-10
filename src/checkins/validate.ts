import {
  PlaceError,
  cleanAddress,
  cleanCategory,
  cleanPlaceName,
  cleanPoint,
  cleanSource,
  cleanSourceId,
  cleanZone,
} from '../places/clean';
import {
  type Change,
  type CheckinRow,
  type Mutation,
  type PlaceRow,
  CHECKIN_SOURCES,
  LIMITS,
  SHARES,
  TABLES,
} from '../sync/format';

/**
 * The rules a place, a check-in and a mutation must meet (DESIGN.md §9, §15.2): **one module, run by the browser before it queues a change and by the server before it applies one.** Nothing
 * here reads a clock (`now` is given), a database or a browser, so both import it, and a refusal is a reason and **a sentence a person can act on**, never a code alone and never the value
 * that was wrong. What comes from a device is untrusted: `parseMutation` takes `unknown`, refuses what is not the shape, what has a field the app does not know, and what breaks a rule, and
 * returns the mutation cleaned (trimmed, deduplicated, the zone checked).
 */
export type Reason =
  | 'bad_mutation'
  | 'bad_id'
  | 'too_many_changes'
  | 'duplicate_change'
  | 'place_name'
  | 'place_point'
  | 'place_address'
  | 'place_category'
  | 'place_source'
  | 'place_zone'
  | 'place_missing'
  | 'future'
  | 'moment'
  | 'zone'
  | 'offset'
  | 'note'
  | 'companions'
  | 'photos'
  | 'link'
  | 'share'
  | 'source'
  | 'in_use'
  | 'missing'
  | 'nothing'
  | 'duplicate';

export const SENTENCES: Readonly<Record<Reason, string>> = {
  bad_mutation:
    'That change is not one this version of Waymark understands. Update the app and try again.',
  bad_id: 'That is not a valid id.',
  too_many_changes: 'That is too many changes at once.',
  duplicate_change: 'That change names the same thing twice.',
  place_name: "A place's name is 1 to 200 characters on one line.",
  place_point: 'A point is a latitude from -90 to 90 and a longitude from -180 to 180.',
  place_address:
    'That address is not one: it is a street, city, region, country, country code and postal code, each at most 200 characters.',
  place_category: 'A category is at most 60 characters on one line.',
  place_source: 'A place came from manual, osm or import.',
  place_zone: 'That is not a time zone. A time zone is a name such as Europe/Lisbon.',
  place_missing: 'A check-in needs a place.',
  future: "A check-in can't be in the future.",
  moment: 'That is not a moment in time.',
  zone: 'That is not a time zone. A time zone is a name such as Europe/Lisbon.',
  offset: 'That time zone offset is not one.',
  note: 'A note is at most 2,000 characters.',
  companions: 'Companions are at most 20 names, each 1 to 60 characters on one line.',
  photos: 'A check-in has at most 10 photos.',
  link: 'A check-in is linked to a trip, and says whether the app or a person linked it.',
  share: 'A check-in is shared with its trip, or on, or off.',
  source: 'A check-in is live, manual or imported from Swarm.',
  in_use: 'This place has check-ins. Merge it into another place, or delete them first.',
  missing: 'That is not there any more.',
  nothing: 'Nothing was changed.',
  duplicate: 'That check-in is already here.',
};

export interface Refusal {
  readonly ok: false;
  readonly reason: Reason;
  readonly sentence: string;
}
export type Result<T> = { readonly ok: true; readonly value: T } | Refusal;

export const refuse = (reason: Reason): Refusal => ({
  ok: false,
  reason,
  sentence: SENTENCES[reason],
});
const ok = <T>(value: T): Result<T> => ({ ok: true, value });

const ID = /^[A-Za-z0-9_-]{1,64}$/;
export const isId = (value: unknown): value is string =>
  typeof value === 'string' && ID.test(value);
const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** An object's keys must be among `allowed`: a field the app does not know is refused, so a device cannot store what the app never reads. */
const onlyKeys = (value: Record<string, unknown>, allowed: readonly string[]): boolean =>
  Object.keys(value).every((key) => allowed.includes(key));

/** A place, as it travels: its parts each checked by the one function that checks it everywhere (`places/clean.ts`). */
export function validatePlaceRow(input: unknown): Result<PlaceRow> {
  if (!isObject(input)) return refuse('bad_mutation');
  if (
    !onlyKeys(input, [
      'name',
      'lat',
      'lng',
      'address',
      'category',
      'sourceId',
      'source',
      'tz',
      'countryCode',
      'unnamed',
    ])
  )
    return refuse('bad_mutation');
  try {
    const name = cleanPlaceName(input.name);
    const point = cleanPoint(input.lat, input.lng);
    const address = cleanAddress(input.address);
    const category = cleanCategory(input.category);
    const sourceId = cleanSourceId(input.sourceId);
    const source = cleanSource(input.source ?? 'manual');
    const tz = input.tz === null || input.tz === undefined ? null : (cleanZone(input.tz) ?? null);
    const countryCode = address?.countryCode ?? null;
    if (input.unnamed !== undefined && typeof input.unnamed !== 'boolean')
      return refuse('bad_mutation');
    return ok({
      name,
      ...point,
      ...(address ? { address } : {}),
      ...(category ? { category } : {}),
      ...(sourceId ? { sourceId } : {}),
      source,
      tz,
      countryCode,
      ...(input.unnamed === true ? { unnamed: true } : {}),
    });
  } catch (error) {
    if (!(error instanceof PlaceError)) throw error;
    // Which part is told by what was wrong, from the cleaners' own words: the first word of a message names it.
    const message = error.message;
    const reason: Reason = message.includes('time zone')
      ? 'place_zone'
      : message.includes('name')
        ? 'place_name'
        : message.includes('point')
          ? 'place_point'
          : message.includes('address') || message.includes('country code')
            ? 'place_address'
            : message.includes('category')
              ? 'place_category'
              : 'place_source';
    return refuse(reason);
  }
}

/** The names of companions: trimmed, one line each, no blanks and no repeats (the first spelling stands), at most 20 of 60 characters. */
export function validateCompanions(input: unknown): Result<string[]> {
  if (!Array.isArray(input)) return refuse('companions');
  const seen = new Set<string>();
  const out: string[] = [];
  for (const each of input) {
    if (typeof each !== 'string') return refuse('companions');
    const name = each.trim();
    if (name === '') continue;
    if (name.length > LIMITS.companionChars || /[\r\n]/.test(name)) return refuse('companions');
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out.length > LIMITS.companions ? refuse('companions') : ok(out);
}

/** The ids of a check-in's photos: ids the device made, at most 10, none twice (5.3 attaches them). */
export function validatePhotos(input: unknown): Result<string[]> {
  if (!Array.isArray(input) || input.length > LIMITS.photos) return refuse('photos');
  if (!input.every(isId) || new Set(input).size !== input.length) return refuse('photos');
  return ok([...input] as string[]);
}

/**
 * A check-in as it travels. `now` is the clock of whoever asks: the device's before it queues, the server's before it applies. **The moment is not in the future** (a few minutes of difference
 * between two clocks are allowed), its zone is a zone, and the offset is a whole number of minutes between -14 and +14 hours: the device's reading is kept as it made it, since an older
 * zone's offset may be one this server's tables would not give.
 */
export function validateCheckinRow(input: unknown, now: number): Result<CheckinRow> {
  if (!isObject(input)) return refuse('bad_mutation');
  if (
    !onlyKeys(input, [
      'placeId',
      'at',
      'tz',
      'offsetMin',
      'note',
      'companions',
      'tripId',
      'linkSource',
      'share',
      'source',
      'externalId',
    ])
  )
    return refuse('bad_mutation');
  if (!isId(input.placeId)) return refuse('place_missing');
  const at = input.at;
  if (typeof at !== 'number' || !Number.isInteger(at) || at <= 0 || at > 8_640_000_000_000_000)
    return refuse('moment');
  if (at > now + LIMITS.clockSkewMs) return refuse('future');
  let tz: string;
  try {
    const zone = cleanZone(input.tz);
    if (zone === undefined) return refuse('zone');
    tz = zone;
  } catch {
    return refuse('zone');
  }
  const offset = input.offsetMin;
  if (
    typeof offset !== 'number' ||
    !Number.isInteger(offset) ||
    offset < -14 * 60 ||
    offset > 14 * 60
  )
    return refuse('offset');
  let note: string | undefined;
  if (input.note !== undefined && input.note !== null) {
    if (typeof input.note !== 'string') return refuse('note');
    // Plain text, as written: a person's own line breaks stay. Only the ends are trimmed, and a note of nothing is no note.
    const trimmed = input.note.trim();
    if (trimmed.length > LIMITS.noteChars) return refuse('note');
    note = trimmed === '' ? undefined : trimmed;
  }
  const companions = validateCompanions(input.companions ?? []);
  if (!companions.ok) return companions;
  const tripId = input.tripId ?? null;
  const linkSource = input.linkSource ?? null;
  if (tripId !== null && !isId(tripId)) return refuse('link');
  if (linkSource !== null && linkSource !== 'auto' && linkSource !== 'manual')
    return refuse('link');
  // A link made or removed by hand is `manual`, with a trip or with none (an unlink); one the app made is `auto` and has a trip.
  if ((tripId !== null && linkSource === null) || (linkSource === 'auto' && tripId === null))
    return refuse('link');
  const share = input.share ?? 'trip';
  if (!SHARES.includes(share as never)) return refuse('share');
  const source = input.source;
  if (!CHECKIN_SOURCES.includes(source as never)) return refuse('source');
  let externalId: string | undefined;
  if (input.externalId !== undefined && input.externalId !== null) {
    if (
      source !== 'import:swarm' ||
      typeof input.externalId !== 'string' ||
      input.externalId === '' ||
      input.externalId.length > LIMITS.externalIdChars
    )
      return refuse('source');
    externalId = input.externalId;
  } else if (source === 'import:swarm') return refuse('source');
  return ok({
    placeId: input.placeId,
    at,
    tz,
    offsetMin: offset,
    ...(note ? { note } : {}),
    companions: companions.value,
    tripId: tripId as string | null,
    linkSource: linkSource as CheckinRow['linkSource'],
    share: share as CheckinRow['share'],
    source: source as CheckinRow['source'],
    ...(externalId ? { externalId } : {}),
  });
}

/** What a device sent, as a mutation, cleaned: or the first thing wrong with it, in a sentence. */
export function parseMutation(input: unknown, now: number): Result<Mutation> {
  if (!isObject(input) || !onlyKeys(input, ['mutationId', 'stream', 'changes']))
    return refuse('bad_mutation');
  if (!isId(input.mutationId)) return refuse('bad_id');
  if (input.stream !== 'account') return refuse('bad_mutation');
  if (!Array.isArray(input.changes) || input.changes.length === 0) return refuse('bad_mutation');
  if (input.changes.length > LIMITS.changesPerMutation) return refuse('too_many_changes');
  const changes: Change[] = [];
  const seen = new Set<string>();
  for (const each of input.changes as unknown[]) {
    if (!isObject(each) || !(TABLES as readonly unknown[]).includes(each.table))
      return refuse('bad_mutation');
    if (!isId(each.id)) return refuse('bad_id');
    const key = `${String(each.table)}/${each.id}`;
    if (seen.has(key)) return refuse('duplicate_change');
    seen.add(key);
    if (each.op === 'delete') {
      if (!onlyKeys(each, ['table', 'op', 'id'])) return refuse('bad_mutation');
      changes.push({ table: each.table as 'place' | 'checkin', op: 'delete', id: each.id });
      continue;
    }
    if (each.op !== 'put' || !onlyKeys(each, ['table', 'op', 'id', 'baseVersion', 'row']))
      return refuse('bad_mutation');
    const baseVersion = each.baseVersion;
    if (
      baseVersion !== undefined &&
      (typeof baseVersion !== 'number' || !Number.isInteger(baseVersion) || baseVersion < 1)
    )
      return refuse('bad_mutation');
    const base = baseVersion === undefined ? {} : { baseVersion };
    if (each.table === 'place') {
      const row = validatePlaceRow(each.row);
      if (!row.ok) return row;
      changes.push({ table: 'place', op: 'put', id: each.id, ...base, row: row.value });
    } else {
      const row = validateCheckinRow(each.row, now);
      if (!row.ok) return row;
      changes.push({ table: 'checkin', op: 'put', id: each.id, ...base, row: row.value });
    }
  }
  return ok({ mutationId: input.mutationId, stream: 'account', changes });
}
