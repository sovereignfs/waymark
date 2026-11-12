import { isId, validatePlaceRow } from '../checkins/validate';
import { isPosition } from '../position';
import { TRIP_COLORS, type TripColor, TRIP_DESCRIPTION_MAX, TRIP_NAME_MAX } from '../trips/format';
import { checkStops, datesOf, isDate } from '../trips/dates';
import { type ItemKind, checkItem } from '../trips/item-format';
import { type LinkKind, checkLink } from '../trips/link-format';
import { ATTACHMENT_KINDS, ATTACHMENT_TITLE_MAX } from '../trips/attachments';
import type { PlaceRow } from '../sync/format';

/**
 * **The trips in a file** (DESIGN.md §22), pure: every trip where the person is an Organizer or a Traveler, whole, as the part of `waymark.json` that version 2 adds. A trip holds its own places, its stops with their dates and note, its
 * days (all of them, so that an item can name its day), its items, its links and its attachments (as files under `attachments/`); **its members by name and part only, never an address**; the ids of the person's own check-ins linked to
 * it; and the check-ins other members shared with it, as text, as the journal shows them (no photo, no address, no id of theirs).
 *
 * Checked whole, like the rest of the file, before anything is written: every row by the rules the server applies (`validatePlaceRow`, `checkItem`, `checkLink`, the stops by `checkStops`), that it hangs together (a stop at a place of the
 * trip, a day at a stop of the trip and a date that stop covers, an item on a day of the trip and at a place of it, an attachment's file named once), and with bounds on every list so that a file cannot ask a reader to hold more than a trip may.
 */
export const ATTACHMENT_DIR = 'attachments/';
export const MAX_TRIPS = 1_000;
const MAX_PER_TRIP = 20_000;
const MAX_MEMBERS = 200;
const MAX_SHARED = 50_000;
const MAX_DAYS = 400;

export type ExportedTripPlace = PlaceRow & { readonly id: string };
export interface ExportedStop {
  readonly id: string;
  readonly placeId: string;
  readonly arrive: string | null;
  readonly depart: string | null;
  readonly position: string;
  readonly note?: string;
}
export interface ExportedDay {
  readonly id: string;
  readonly stopId: string;
  readonly date: string;
  readonly title?: string;
  readonly notes?: string;
}
export interface ExportedItem {
  readonly id: string;
  readonly dayId: string;
  readonly placeId: string | null;
  readonly title?: string;
  readonly notes?: string;
  readonly kind: ItemKind;
  readonly start: string | null;
  readonly end: string | null;
  readonly fixed: boolean;
  readonly position: string;
}
export interface ExportedLink {
  readonly id: string;
  readonly kind: LinkKind;
  readonly title: string;
  readonly url: string;
  readonly position: string;
}
export interface ExportedAttachment {
  readonly id: string;
  readonly dayId: string | null;
  readonly kind: (typeof ATTACHMENT_KINDS)[number];
  readonly title: string;
  /** `attachments/<id>.<extension>` in the ZIP. */
  readonly file: string;
  readonly type: string;
}
export interface ExportedMember {
  readonly name: string;
  readonly role: 'organizer' | 'traveler' | 'follower';
}
/** A check-in another member shared with the trip, as the journal shows it: text only, and the author by name. */
export interface ExportedShared {
  readonly author: string;
  readonly place: {
    readonly name: string;
    readonly lat: number;
    readonly lng: number;
    readonly address?: unknown;
    readonly category?: string;
  };
  readonly at: number;
  readonly tz: string;
  readonly offsetMin: number;
  readonly note?: string;
  readonly companions: readonly string[];
}
export interface ExportedTrip {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly color: TripColor;
  readonly ready: boolean;
  readonly members: readonly ExportedMember[];
  readonly places: readonly ExportedTripPlace[];
  readonly stops: readonly ExportedStop[];
  readonly days: readonly ExportedDay[];
  readonly items: readonly ExportedItem[];
  readonly links: readonly ExportedLink[];
  readonly attachments: readonly ExportedAttachment[];
  /** The ids (in the file's `checkins`) of the person's own check-ins linked to the trip. */
  readonly checkins: readonly string[];
  readonly shared: readonly ExportedShared[];
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const oneLine = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.trim() !== '' && value.length <= max && !/[\r\n]/.test(value);
const optionalText = (value: unknown, max: number): string | undefined | null =>
  value === undefined
    ? undefined
    : typeof value === 'string' && value.length >= 1 && value.length <= max
      ? value
      : null;

/** `attachments/<uuid>.<pdf|webp|jpg|png|zip>` and nothing else. */
export const isAttachmentFile = (name: string): boolean =>
  /^attachments\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(pdf|webp|jpg|png|zip)$/.test(
    name,
  );

export const attachmentExtension = (type: string): string =>
  type === 'application/pdf'
    ? 'pdf'
    : type === 'image/webp'
      ? 'webp'
      : type === 'image/jpeg'
        ? 'jpg'
        : type === 'image/png'
          ? 'png'
          : type === 'application/zip'
            ? 'zip'
            : 'bin';

/** The trips of a file, or undefined if anything in them is not valid (the caller's sentence says no more: it never repeats the file). `checkinIds` are the ids of the file's own check-ins. */
export function parseTrips(
  input: unknown,
  checkinIds: ReadonlySet<string>,
): ExportedTrip[] | undefined {
  if (input === undefined) return [];
  if (!Array.isArray(input) || input.length > MAX_TRIPS) return undefined;
  const trips: ExportedTrip[] = [];
  const tripIds = new Set<string>();
  const files = new Set<string>();
  for (const each of input as unknown[]) {
    const trip = parseTrip(each, checkinIds, files);
    if (!trip || tripIds.has(trip.id)) return undefined;
    tripIds.add(trip.id);
    trips.push(trip);
  }
  return trips;
}

function parseTrip(
  input: unknown,
  checkinIds: ReadonlySet<string>,
  files: Set<string>,
): ExportedTrip | undefined {
  if (!isObject(input) || !isId(input.id)) return undefined;
  if (!oneLine(input.name, TRIP_NAME_MAX)) return undefined;
  const description = optionalText(input.description, TRIP_DESCRIPTION_MAX);
  if (description === null) return undefined;
  if (!(TRIP_COLORS as readonly unknown[]).includes(input.color)) return undefined;
  if (typeof input.ready !== 'boolean') return undefined;
  for (const key of [
    'members',
    'places',
    'stops',
    'days',
    'items',
    'links',
    'attachments',
    'checkins',
    'shared',
  ])
    if (!Array.isArray(input[key])) return undefined;
  const lists = input as Record<string, unknown[]>;
  if (
    (lists.members as unknown[]).length > MAX_MEMBERS ||
    (lists.shared as unknown[]).length > MAX_SHARED ||
    (lists.days as unknown[]).length > MAX_DAYS ||
    ['places', 'stops', 'items', 'links', 'attachments', 'checkins'].some(
      (key) => (lists[key] as unknown[]).length > MAX_PER_TRIP,
    )
  )
    return undefined;

  const members: ExportedMember[] = [];
  for (const m of lists.members as unknown[]) {
    if (
      !isObject(m) ||
      !oneLine(m.name, 100) ||
      (m.role !== 'organizer' && m.role !== 'traveler' && m.role !== 'follower') ||
      Object.keys(m).some((key) => key !== 'name' && key !== 'role')
    )
      return undefined;
    members.push({ name: m.name.trim(), role: m.role });
  }

  const placeIds = new Set<string>();
  const places: ExportedTripPlace[] = [];
  for (const p of lists.places as unknown[]) {
    if (!isObject(p) || !isId(p.id) || placeIds.has(p.id)) return undefined;
    const { id, ...row } = p;
    const checked = validatePlaceRow(row);
    if (!checked.ok) return undefined;
    placeIds.add(id);
    places.push({ id, ...checked.value });
  }

  const stops: ExportedStop[] = [];
  const stopIds = new Set<string>();
  const stopDates = new Map<string, Set<string>>();
  for (const s of lists.stops as unknown[]) {
    if (
      !isObject(s) ||
      !isId(s.id) ||
      stopIds.has(s.id) ||
      !isId(s.placeId) ||
      !placeIds.has(s.placeId)
    )
      return undefined;
    const arrive = s.arrive === null || s.arrive === undefined ? null : s.arrive;
    const depart = s.depart === null || s.depart === undefined ? null : s.depart;
    if ((arrive === null) !== (depart === null)) return undefined;
    if (arrive !== null && (!isDate(arrive) || !isDate(depart) || (depart as string) < arrive))
      return undefined;
    // A stop's position is the plan's own order key (digits), not a fractional-index key as an item's and a link's.
    if (typeof s.position !== 'string' || !/^[0-9A-Za-z]{1,32}$/.test(s.position)) return undefined;
    const note = optionalText(s.note, 2000);
    if (note === null) return undefined;
    stopIds.add(s.id);
    stopDates.set(
      s.id,
      new Set(arrive === null ? [] : datesOf(arrive as string, depart as string)),
    );
    stops.push({
      id: s.id,
      placeId: s.placeId,
      arrive: arrive as string | null,
      depart: depart as string | null,
      position: s.position,
      ...(note ? { note } : {}),
    });
  }
  if (checkStops(stops) !== undefined) return undefined;

  const days: ExportedDay[] = [];
  const dayIds = new Set<string>();
  const dayKeys = new Set<string>();
  for (const d of lists.days as unknown[]) {
    if (
      !isObject(d) ||
      !isId(d.id) ||
      dayIds.has(d.id) ||
      !isId(d.stopId) ||
      !stopIds.has(d.stopId)
    )
      return undefined;
    if (!isDate(d.date) || !stopDates.get(d.stopId)?.has(d.date)) return undefined;
    const key = `${d.stopId}/${d.date}`;
    if (dayKeys.has(key)) return undefined;
    const title = optionalText(d.title, 200);
    const notes = optionalText(d.notes, 2000);
    if (title === null || notes === null || (title && /[\r\n]/.test(title))) return undefined;
    dayIds.add(d.id);
    dayKeys.add(key);
    days.push({
      id: d.id,
      stopId: d.stopId,
      date: d.date,
      ...(title ? { title } : {}),
      ...(notes ? { notes } : {}),
    });
  }

  const items: ExportedItem[] = [];
  const itemIds = new Set<string>();
  for (const i of lists.items as unknown[]) {
    if (!isObject(i) || !isId(i.id) || itemIds.has(i.id) || !isId(i.dayId) || !dayIds.has(i.dayId))
      return undefined;
    const placeId = i.placeId === null || i.placeId === undefined ? null : i.placeId;
    if (placeId !== null && (!isId(placeId) || !placeIds.has(placeId))) return undefined;
    if (typeof i.position !== 'string' || !isPosition(i.position)) return undefined;
    const checked = checkItem(i, placeId !== null);
    if (!checked.ok) return undefined;
    itemIds.add(i.id);
    const { title, notes, kind, start, end, fixed } = checked.value;
    items.push({
      id: i.id,
      dayId: i.dayId,
      placeId,
      ...(title ? { title } : {}),
      ...(notes ? { notes } : {}),
      kind,
      start,
      end,
      fixed,
      position: i.position,
    });
  }

  const links: ExportedLink[] = [];
  const linkIds = new Set<string>();
  for (const l of lists.links as unknown[]) {
    if (!isObject(l) || !isId(l.id) || linkIds.has(l.id)) return undefined;
    const checked = checkLink(l);
    if (!checked.ok || typeof l.position !== 'string' || !isPosition(l.position)) return undefined;
    linkIds.add(l.id);
    links.push({ id: l.id, ...checked.value, position: l.position });
  }

  const attachments: ExportedAttachment[] = [];
  const attachmentIds = new Set<string>();
  for (const a of lists.attachments as unknown[]) {
    if (!isObject(a) || !isId(a.id) || attachmentIds.has(a.id)) return undefined;
    const dayId = a.dayId === null || a.dayId === undefined ? null : a.dayId;
    if (dayId !== null && (!isId(dayId) || !dayIds.has(dayId))) return undefined;
    if (!(ATTACHMENT_KINDS as readonly unknown[]).includes(a.kind)) return undefined;
    if (!oneLine(a.title, ATTACHMENT_TITLE_MAX)) return undefined;
    if (
      typeof a.file !== 'string' ||
      !isAttachmentFile(a.file) ||
      files.has(a.file) ||
      typeof a.type !== 'string' ||
      !/^(application\/(pdf|zip)|image\/(webp|jpeg|png))$/.test(a.type)
    )
      return undefined;
    attachmentIds.add(a.id);
    files.add(a.file);
    attachments.push({
      id: a.id,
      dayId,
      kind: a.kind as ExportedAttachment['kind'],
      title: a.title.trim(),
      file: a.file,
      type: a.type,
    });
  }

  const checkins: string[] = [];
  for (const c of lists.checkins as unknown[]) {
    if (typeof c !== 'string' || !checkinIds.has(c)) return undefined;
    checkins.push(c);
  }

  const shared: ExportedShared[] = [];
  for (const s of lists.shared as unknown[]) {
    if (!isObject(s) || !oneLine(s.author, 100) || !isObject(s.place)) return undefined;
    const place = validatePlaceRow({ ...s.place, source: 'manual', tz: null, countryCode: null });
    if (
      !place.ok ||
      typeof s.at !== 'number' ||
      !Number.isFinite(s.at) ||
      typeof s.tz !== 'string' ||
      typeof s.offsetMin !== 'number' ||
      !Array.isArray(s.companions) ||
      !s.companions.every((c) => typeof c === 'string' && c.length <= 60)
    )
      return undefined;
    const note = optionalText(s.note, 2000);
    if (note === null) return undefined;
    shared.push({
      author: s.author.trim(),
      place: {
        name: place.value.name,
        lat: place.value.lat,
        lng: place.value.lng,
        ...(place.value.address ? { address: place.value.address } : {}),
        ...(place.value.category ? { category: place.value.category } : {}),
      },
      at: s.at,
      tz: s.tz,
      offsetMin: s.offsetMin,
      ...(note ? { note } : {}),
      companions: s.companions as string[],
    });
  }

  return {
    id: input.id,
    name: input.name.trim(),
    ...(description ? { description } : {}),
    color: input.color as TripColor,
    ready: input.ready,
    members,
    places,
    stops,
    days,
    items,
    links,
    attachments,
    checkins,
    shared,
  };
}
