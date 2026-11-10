import {
  checkInAtNewPlace,
  checkInAtPlace,
  checkInAtPoint,
  editCheckin,
  type CheckInOptions,
} from '../actions/checkins';
import type { ActionResult, CheckinView, Context, PlaceView } from '../actions/types';
import { SENTENCES, refuse } from '../checkins/validate';
import { distanceMetres, findSamePlace } from '../places/match';
import type { Candidate } from '../places/providers';
import { searchPlaces } from '../places/search';
import { momentOf, zoneOf } from '../places/tz';
import { localDateOf, localTimeOf } from './timeline';

/**
 * What the check-in sheet decides (DESIGN.md §9.2, §20.5), apart from how it looks: **which places are offered** and in what order, **which moment** a person meant, and **which action** their choice is. Pure, so
 * that every way of checking in, and every odd turn of it, is tested without a browser; the sheet only draws these and passes on what the person did.
 *
 *  - **The person's own places come first**, nearest first when the position is known, then the place search's, with any the person already has taken out (the "same place" rule, §7.1, so a place is never made twice).
 *  - **A new place** needs a name and a point; **a point alone** needs only the point and is called "A place near …" until it is named (§9.2), which is what makes a check-in possible with no network and no name.
 *  - **The moment** is now unless a person gave another, in the **zone of the place** (§7.3), and never in the future.
 */
export interface Position {
  readonly lat: number;
  readonly lng: number;
}

export type Selection =
  | { readonly kind: 'place'; readonly place: PlaceView }
  | { readonly kind: 'candidate'; readonly candidate: Candidate }
  | { readonly kind: 'new'; readonly name: string; readonly point: Position }
  | { readonly kind: 'point'; readonly point: Position };

/** What the list offers: each has a stable key, which is what is selected. */
export type Option =
  | {
      readonly key: string;
      readonly kind: 'mine';
      readonly place: PlaceView;
      readonly distance: number | undefined;
    }
  | {
      readonly key: string;
      readonly kind: 'found';
      readonly candidate: Candidate;
      readonly distance: number | undefined;
    }
  | { readonly key: string; readonly kind: 'new'; readonly point: Position }
  | { readonly key: string; readonly kind: 'point'; readonly point: Position };

/** How near is "here" when no one has typed anything: places within this many metres are offered. */
export const NEARBY_METRES = 1500;
const MINE_LIMIT = 6;
const FOUND_LIMIT = 6;

const near = (a: Position | undefined, b: Position): number | undefined =>
  a ? distanceMetres(a, b) : undefined;

export function buildOptions(input: {
  places: readonly PlaceView[];
  query: string;
  position: Position | undefined;
  /** What the place search found for the query (§7.2), after the pause. */
  found: readonly Candidate[];
  /** What is at the position, by reverse lookup, if it is known. */
  reverse: Candidate | undefined;
}): Option[] {
  const { places, position } = input;
  const query = input.query.trim();
  const out: Option[] = [];

  let mine: { place: PlaceView; distance: number | undefined }[];
  if (query !== '') {
    mine = searchPlaces(places, query, { near: position, limit: MINE_LIMIT }).map((f) => ({
      place: f.place,
      distance: f.distance,
    }));
  } else if (position) {
    mine = places
      .map((place) => ({ place, distance: distanceMetres(position, place) }))
      .filter((each) => each.distance <= NEARBY_METRES)
      .sort((a, b) => a.distance - b.distance || a.place.name.localeCompare(b.place.name))
      .slice(0, MINE_LIMIT);
  } else {
    mine = [...places]
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, MINE_LIMIT)
      .map((place) => ({ place, distance: undefined }));
  }
  for (const each of mine)
    out.push({
      key: `mine:${each.place.id}`,
      kind: 'mine',
      place: each.place,
      distance: each.distance,
    });

  // The place search's, with what the person has already taken out: a place found that is one of theirs is theirs, listed above.
  const candidates = [...input.found, ...(input.reverse && query === '' ? [input.reverse] : [])];
  const seen = new Set<string>();
  let foundCount = 0;
  for (const candidate of candidates) {
    if (foundCount >= FOUND_LIMIT) break;
    if (seen.has(candidate.sourceId) || findSamePlace(candidate, places)) continue;
    seen.add(candidate.sourceId);
    foundCount++;
    out.push({
      key: `found:${candidate.sourceId}`,
      kind: 'found',
      candidate,
      distance: near(position, candidate),
    });
  }
  if (position) {
    out.push({ key: 'new', kind: 'new', point: position });
    out.push({ key: 'point', kind: 'point', point: position });
  }
  return out;
}

/** What an option is, once chosen, given the name typed for a new place. `undefined` for a new place with no name yet. */
export function selectionOf(option: Option | undefined, newName: string): Selection | undefined {
  if (!option) return undefined;
  switch (option.kind) {
    case 'mine':
      return { kind: 'place', place: option.place };
    case 'found':
      return { kind: 'candidate', candidate: option.candidate };
    case 'point':
      return { kind: 'point', point: option.point };
    case 'new':
      return newName.trim() === ''
        ? undefined
        : { kind: 'new', name: newName.trim(), point: option.point };
  }
}

/** The zone a check-in at this choice is in when it is made for another time: the place's own, or the one its point is in (§7.3); `undefined` if there is none to find. */
export function zoneOfSelection(selection: Selection): string | undefined {
  switch (selection.kind) {
    case 'place':
      return selection.place.tz ?? zoneOf(selection.place.lat, selection.place.lng);
    case 'candidate':
      return zoneOf(selection.candidate.lat, selection.candidate.lng);
    case 'new':
    case 'point':
      return zoneOf(selection.point.lat, selection.point.lng);
  }
}

export interface Extras {
  /** A moment other than now, as the person reads it on the place's clock: `2026-07-04` and `12:30`. Absent for now. */
  readonly local?: { readonly date: string; readonly time: string } | undefined;
  readonly note?: string | undefined;
  readonly companions?: readonly string[] | undefined;
  readonly photos?: readonly string[] | undefined;
}

/** The moment, in milliseconds, for a date and time on a zone's clock: `undefined` for a date or time that is not one. */
export function momentFromInput(
  local: { date: string; time: string },
  zone: string,
): number | undefined {
  return momentOf(local.date, local.time, zone);
}

/**
 * The action a choice is, with what was typed (§9.2). **A place the person already has is reused** whatever way it was reached (the same source and id, or the same name within 50 metres, §7.1): checking in
 * at the Café de Flore twice by search and once by "new place here" is one place, and "I finally went there, twice" is a count. A moment that is not a moment, or a new place with no name, is refused with the
 * sentence the rules give.
 */
export function planCheckIn(
  selection: Selection | undefined,
  places: readonly PlaceView[],
  extras: Extras,
  ctx: Context,
): ActionResult {
  if (!selection) return refuse('place_missing');
  let at: number | undefined;
  if (extras.local) {
    const zone = zoneOfSelection(selection) ?? ctx.deviceZone;
    at = momentFromInput(extras.local, zone);
    if (at === undefined) return refuse('moment');
  }
  const options: CheckInOptions = {
    ...(at !== undefined ? { at } : {}),
    ...(extras.note?.trim() ? { note: extras.note } : {}),
    ...(extras.companions && extras.companions.length > 0 ? { companions: extras.companions } : {}),
    ...(extras.photos && extras.photos.length > 0 ? { photos: extras.photos } : {}),
  };
  switch (selection.kind) {
    case 'place':
      return checkInAtPlace(selection.place, options, ctx);
    case 'candidate': {
      const c = selection.candidate;
      const have = findSamePlace(c, places);
      if (have) return checkInAtPlace(have, options, ctx);
      return checkInAtNewPlace(
        {
          name: c.name,
          lat: c.lat,
          lng: c.lng,
          address: c.address,
          category: c.category,
          source: c.source,
          sourceId: c.sourceId,
        },
        options,
        ctx,
      );
    }
    case 'new': {
      const name = selection.name.trim();
      if (name === '') return refuse('place_name');
      const have = findSamePlace({ name, ...selection.point }, places);
      return have
        ? checkInAtPlace(have, options, ctx)
        : checkInAtNewPlace({ name, ...selection.point }, options, ctx);
    }
    case 'point':
      return checkInAtPoint(selection.point, options, ctx);
  }
}

/** The sentences the sheet says of position, so that they are one place's and tested. */
export const POSITION_SENTENCES = {
  denied:
    'Waymark cannot use your position here, so Here is not offered. You can still search for a place.',
  unavailable:
    'This device cannot tell where it is right now, so Here is not offered. You can still search for a place.',
  offline: 'Place search needs a connection. Your own places are still here.',
  off: 'There is no place search on this server. Your own places are still here, and you can name a new one.',
  unreachable: 'The place search is not reachable right now. Your own places are still here.',
} as const;

export { SENTENCES };

export interface EditExtras {
  /** The date and time as the form shows them, on the clock where the check-in is: the same as it was means the moment is not changed. */
  readonly local: { readonly date: string; readonly time: string };
  readonly note: string;
  readonly companions: readonly string[];
  /** The photos the check-in has now, in order: the ones it had that were kept, and the new ones. */
  readonly photos: readonly string[];
}

/**
 * The action that changes a check-in from what the form says (DESIGN.md §9.4): **only what differs is a change**, and the rest is sent as it was (the row goes whole, so the later edit stands, §15.4). A different
 * place brings its zone for the moment; a moment that is the same on the form is not worked out again, which would turn a check-in made live into one made by hand for no reason; a note that is cleared is taken away.
 * Nothing changed is refused with the sentence that says so.
 */
export function planEdit(
  current: CheckinView,
  selection: Selection | undefined,
  extras: EditExtras,
  ctx: Context,
): ActionResult {
  const place =
    selection?.kind === 'place' && selection.place.id !== current.placeId
      ? selection.place
      : undefined;
  const sameMoment =
    extras.local.date === localDateOf(current) && extras.local.time === localTimeOf(current);
  let at: number | undefined;
  if (!sameMoment) {
    const zone = place ? (place.tz ?? zoneOf(place.lat, place.lng) ?? current.tz) : current.tz;
    at = momentFromInput(extras.local, zone);
    if (at === undefined) return refuse('moment');
  }
  const note = extras.note.trim();
  const photos = [...extras.photos];
  const samePhotos =
    photos.length === (current.photos?.length ?? 0) &&
    photos.every((id, i) => id === current.photos?.[i]);
  return editCheckin(
    current,
    {
      ...(place ? { place } : {}),
      ...(at !== undefined ? { at } : {}),
      note: note === '' ? null : note,
      companions: extras.companions,
      ...(samePhotos ? {} : { photos }),
    },
    ctx,
  );
}
