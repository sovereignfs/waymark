import { isId, validateCheckinRow, validatePlaceRow } from '../checkins/validate';
import { FILE_ID, type CheckinRow, type PlaceRow } from '../sync/format';
import { type ExportedTrip, parseTrips } from './trips-format';

/**
 * **The file a person takes with them** (DESIGN.md §22): one ZIP, `waymark.json` at the top and the photos beside it under `photos/`. This is the app's own format, apart from the Swarm import (epic 8). The JSON
 * has a `format` and a `version` first, so that a file from a newer Waymark is refused with a sentence rather than half understood. **One definition, used to write and to read**, so a file the export made is a file
 * the import accepts (15.2); nothing here touches a database or a file.
 *
 * ```json
 * {
 *   "format": "waymark-export", "version": 2, "exportedAt": "2026-11-12T08:00:00.000Z",
 *   "profile": { "name": "Ada", "units": "km", "weekStart": 1, "shareDefault": "ask" },
 *   "settings": { "email": { "import_finished": true } },
 *   "places":   [ { "id": "…", "name": "Café de Flore", "lat": 48.854, "lng": 2.3326, "source": "osm", "tz": "Europe/Paris", "countryCode": "FR" } ],
 *   "checkins": [ { "id": "…", "placeId": "…", "at": 1793000000000, "tz": "Europe/Paris", "offsetMin": 60, "companions": [], "photos": ["…"], "source": "live", … } ],
 *   "photos":   [ { "id": "…", "file": "photos/….webp", "type": "image/webp" } ]
 * }
 * ```
 *
 * **What is not in it:** anyone's email address (the person's own is the account's, and the one who imports has theirs), another person's anything but their name and part in a trip and the check-ins they shared with it as text
 * (`trips-format.ts`), and thumbnails (made again on import). Version 2 adds `trips`; a version 1 file is still read.
 */
export const FORMAT = 'waymark-export';
/** Bumped when a reader of the older would misread the newer. A file with a higher version is refused. */
export const VERSION = 2;
/** The JSON's name in the ZIP, and the folder the photos are in. */
export const JSON_NAME = 'waymark.json';
export const PHOTO_DIR = 'photos/';
/** The most places, check-ins or photos a file holds: far past a decade of use, and a bound on what one file can ask a reader to hold. */
export const MAX_ROWS = 500_000;
export const MAX_NAME = 100;

export interface ExportedProfile {
  readonly name: string;
  readonly units: 'km' | 'mi';
  readonly weekStart: number;
  readonly shareDefault: 'ask' | 'on' | 'off';
}
export interface ExportedPhoto {
  readonly id: string;
  /** The file's name in the ZIP: `photos/<id>.<extension>`. */
  readonly file: string;
  readonly type: string;
}
export type ExportedPlace = PlaceRow & { readonly id: string };
export type ExportedCheckin = CheckinRow & { readonly id: string };

export interface Export {
  readonly format: typeof FORMAT;
  readonly version: number;
  readonly exportedAt: string;
  readonly profile: ExportedProfile;
  /** The choices of what is emailed, by kind: only the kinds the person has chosen for. */
  readonly settings: { readonly email: Readonly<Record<string, boolean>> };
  readonly places: readonly ExportedPlace[];
  readonly checkins: readonly ExportedCheckin[];
  readonly photos: readonly ExportedPhoto[];
  /** Every trip where the person is an Organizer or a Traveler, whole (version 2; a version 1 file has none). */
  readonly trips: readonly ExportedTrip[];
}

export type Parsed = { ok: true; value: Export } | { ok: false; sentence: string };

export const SENTENCES = {
  notWaymark: 'That is not a Waymark export.',
  newer:
    'That export is from a newer version of Waymark than this one. Update Waymark, or export again from this version.',
  unreadable: 'That export could not be read. Export again and try the new file.',
  tooMany: 'That export holds more than this version of Waymark will import at once.',
  broken: 'That export is damaged: a place, a check-in or a photo in it is not valid.',
} as const;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const fail = (sentence: string): Parsed => ({ ok: false, sentence });

/** The extension a stored photo's type is written with. */
export const extensionOf = (type: string): string =>
  type === 'image/webp'
    ? 'webp'
    : type === 'image/jpeg'
      ? 'jpg'
      : type === 'image/png'
        ? 'png'
        : 'bin';

/**
 * A file's JSON, checked whole before anything is written anywhere: the format and the version first (a different format is not ours, a higher version is refused with a sentence that says what to do),
 * then **every place and check-in by the same rules a device's change meets** (`checkins/validate.ts`), then that the file hangs together: ids that are ids and are not repeated, every check-in at a place
 * the file holds, every photo it names either in the file's list or not yet uploaded, and every photo in the list a file of `photos/` and named once. Returns the cleaned file, or the first thing wrong in a
 * sentence that never repeats what was in the file.
 *
 * `now` is given, so that nothing here reads a clock: a check-in in the future is refused as the write path refuses it.
 */
export function parseExport(input: unknown, now: number): Parsed {
  if (!isObject(input) || input.format !== FORMAT) return fail(SENTENCES.notWaymark);
  if (typeof input.version !== 'number' || !Number.isInteger(input.version) || input.version < 1)
    return fail(SENTENCES.unreadable);
  if (input.version > VERSION) return fail(SENTENCES.newer);
  if (
    typeof input.exportedAt !== 'string' ||
    Number.isNaN(Date.parse(input.exportedAt)) ||
    !Array.isArray(input.places) ||
    !Array.isArray(input.checkins) ||
    !Array.isArray(input.photos)
  )
    return fail(SENTENCES.unreadable);
  if (
    input.places.length > MAX_ROWS ||
    input.checkins.length > MAX_ROWS ||
    input.photos.length > MAX_ROWS
  )
    return fail(SENTENCES.tooMany);

  const profile = parseProfile(input.profile);
  if (!profile) return fail(SENTENCES.unreadable);
  const settings = parseSettings(input.settings);
  if (!settings) return fail(SENTENCES.unreadable);

  const places: ExportedPlace[] = [];
  const placeIds = new Set<string>();
  for (const each of input.places as unknown[]) {
    if (!isObject(each) || !isId(each.id) || placeIds.has(each.id)) return fail(SENTENCES.broken);
    const { id, ...row } = each;
    const checked = validatePlaceRow(row);
    if (!checked.ok) return fail(SENTENCES.broken);
    placeIds.add(id);
    places.push({ id, ...checked.value });
  }

  const photos: ExportedPhoto[] = [];
  const photoIds = new Set<string>();
  const files = new Set<string>();
  for (const each of input.photos as unknown[]) {
    if (
      !isObject(each) ||
      typeof each.id !== 'string' ||
      !FILE_ID.test(each.id) ||
      photoIds.has(each.id) ||
      typeof each.file !== 'string' ||
      !isPhotoFile(each.file) ||
      files.has(each.file) ||
      typeof each.type !== 'string' ||
      !/^image\/(webp|jpeg|png)$/.test(each.type)
    )
      return fail(SENTENCES.broken);
    photoIds.add(each.id);
    files.add(each.file);
    photos.push({ id: each.id, file: each.file, type: each.type });
  }

  const checkins: ExportedCheckin[] = [];
  const checkinIds = new Set<string>();
  const externalIds = new Set<string>();
  const used = new Set<string>();
  for (const each of input.checkins as unknown[]) {
    if (!isObject(each) || !isId(each.id) || checkinIds.has(each.id)) return fail(SENTENCES.broken);
    const { id, ...row } = each;
    const checked = validateCheckinRow(row, now);
    if (!checked.ok) return fail(SENTENCES.broken);
    if (!placeIds.has(checked.value.placeId)) return fail(SENTENCES.broken);
    if (checked.value.externalId !== undefined) {
      if (externalIds.has(checked.value.externalId)) return fail(SENTENCES.broken);
      externalIds.add(checked.value.externalId);
    }
    for (const photo of checked.value.photos ?? []) {
      // A photo on a check-in is in the list, or it never reached the server and is simply not in the file; one photo is on one check-in.
      if (used.has(photo)) return fail(SENTENCES.broken);
      used.add(photo);
    }
    checkinIds.add(id);
    checkins.push({ id, ...checked.value });
  }
  // A photo in the list that no check-in names is a file with no home.
  for (const photo of photos) if (!used.has(photo.id)) return fail(SENTENCES.broken);

  // The trips (version 2): each checked by the rules the server applies, and hanging together; the check-ins they name are the file's.
  const trips = parseTrips(input.trips, checkinIds);
  if (!trips) return fail(SENTENCES.broken);
  if (trips.reduce((n, trip) => n + trip.places.length + trip.items.length, 0) > MAX_ROWS)
    return fail(SENTENCES.tooMany);

  return {
    ok: true,
    value: {
      format: FORMAT,
      version: input.version,
      exportedAt: input.exportedAt,
      profile,
      settings,
      places,
      checkins,
      photos,
      trips,
    },
  };
}

/** `photos/<uuid>.<webp|jpg|png>` and nothing else: no folder, no `..`, no other name. */
export function isPhotoFile(name: string): boolean {
  return /^photos\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(webp|jpg|png)$/.test(
    name,
  );
}

function parseProfile(input: unknown): ExportedProfile | undefined {
  if (!isObject(input)) return undefined;
  const { name, units, weekStart, shareDefault } = input;
  if (
    typeof name !== 'string' ||
    name.trim() === '' ||
    name.length > MAX_NAME ||
    /[\r\n]/.test(name) ||
    (units !== 'km' && units !== 'mi') ||
    typeof weekStart !== 'number' ||
    !Number.isInteger(weekStart) ||
    weekStart < 0 ||
    weekStart > 6 ||
    (shareDefault !== 'ask' && shareDefault !== 'on' && shareDefault !== 'off')
  )
    return undefined;
  return { name: name.trim(), units, weekStart, shareDefault };
}

function parseSettings(input: unknown): Export['settings'] | undefined {
  if (!isObject(input) || !isObject(input.email)) return undefined;
  const email: Record<string, boolean> = {};
  for (const [kind, on] of Object.entries(input.email)) {
    if (!/^[a-z_]{1,40}$/.test(kind) || typeof on !== 'boolean') return undefined;
    email[kind] = on;
  }
  return { email };
}
