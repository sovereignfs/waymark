import { type Result, refuse, validateCheckinRow } from '../checkins/validate';
import { offsetMinutes } from '../places/tz';
import {
  ACCOUNT_STREAM,
  type Change,
  type CheckinRow,
  type CheckinSource,
  type Mutation,
  type Share,
} from '../sync/format';
import { placeRowOf } from './places';
import type { ActionResult, CheckinView, Context, NewPlaceInput, PlaceView } from './types';

/**
 * What a person does to a check-in (DESIGN.md §9.2, §9.4): check in at a place they have, at a new place, or at a point that is named later; change one; delete one. Pure (see `types.ts`).
 *
 * **The moment** is now unless a person gave another, which may be in the past and not in the future. **The zone** is the device's when the check-in is made live and the place's when it is made
 * for another time, or imported (§7.3), and the offset then is worked out from the two, so that a check-in at 23:59 is on the right day on any device. **The trip link** is the auto-link
 * hook's (`ctx.link`, empty until 9.7) unless the link was set or removed by hand, which nothing automatic changes again (§12).
 */
export interface CheckInOptions {
  /** A moment other than now, in the past. */
  readonly at?: number;
  readonly note?: string;
  readonly companions?: readonly string[];
  readonly share?: Share;
}

const mutation = (ctx: Context, changes: Change[]): Mutation => ({
  mutationId: ctx.ids.newId(),
  stream: ACCOUNT_STREAM,
  changes,
});

/** The name a place made from a point alone has until it is named (§9.2): "A place near 38.7223, -9.1393". */
export const nearName = (lat: number, lng: number): string =>
  `A place near ${lat.toFixed(4)}, ${lng.toFixed(4)}`;

function rowFor(
  placeId: string,
  place: { tz: string | null },
  options: CheckInOptions,
  ctx: Context,
): Result<CheckinRow> {
  const live = options.at === undefined;
  const at = options.at ?? ctx.now;
  // Live: where the person is. For another time: where the place is, and where the person is when the place cannot say.
  const tz = live ? ctx.deviceZone : (place.tz ?? ctx.deviceZone);
  let offsetMin: number;
  try {
    offsetMin = offsetMinutes(at, tz);
  } catch {
    return refuse('zone');
  }
  const link = ctx.link?.({ at, tz, placeId }) ?? null;
  const row = validateCheckinRow(
    {
      placeId,
      at,
      tz,
      offsetMin,
      note: options.note,
      companions: options.companions ?? [],
      tripId: link?.tripId ?? null,
      linkSource: link ? 'auto' : null,
      share: options.share ?? 'trip',
      source: live ? 'live' : 'manual',
    },
    ctx.now,
  );
  return row;
}

/** A check-in at a place the person has. */
export function checkInAtPlace(
  place: PlaceView | undefined,
  options: CheckInOptions,
  ctx: Context,
): ActionResult {
  if (!place) return refuse('place_missing');
  const made = rowFor(place.id, place, options, ctx);
  if (!made.ok) return made;
  const row = made.value;
  const id = ctx.ids.newId();
  return {
    ok: true,
    mutation: mutation(ctx, [{ table: 'checkin', op: 'put', id, row }]),
    created: { checkinId: id },
  };
}

/** A check-in at a place that is made with it, in one mutation: both arrive, or neither. */
export function checkInAtNewPlace(
  input: NewPlaceInput,
  options: CheckInOptions,
  ctx: Context,
): ActionResult {
  const place = placeRowOf(input);
  if (!place.ok) return place;
  const placeId = ctx.ids.newId();
  const made = rowFor(placeId, place.value, options, ctx);
  if (!made.ok) return made;
  const row = made.value;
  const checkinId = ctx.ids.newId();
  return {
    ok: true,
    mutation: mutation(ctx, [
      { table: 'place', op: 'put', id: placeId, row: place.value },
      { table: 'checkin', op: 'put', id: checkinId, row },
    ]),
    created: { placeId, checkinId },
  };
}

/**
 * A check-in at a point alone, with no name yet (a GPS check-in with no network to ask what is there, §9.2): the place is called "A place near …", and the server names it by reverse lookup
 * when it arrives, where the person can still rename it.
 */
export function checkInAtPoint(
  point: { readonly lat: number; readonly lng: number },
  options: CheckInOptions,
  ctx: Context,
): ActionResult {
  const place = placeRowOf({ name: nearName(point.lat, point.lng), ...point });
  if (!place.ok) return place;
  const placeId = ctx.ids.newId();
  const made = rowFor(placeId, place.value, options, ctx);
  if (!made.ok) return made;
  const row = made.value;
  const checkinId = ctx.ids.newId();
  return {
    ok: true,
    mutation: mutation(ctx, [
      { table: 'place', op: 'put', id: placeId, row: { ...place.value, unnamed: true } },
      { table: 'checkin', op: 'put', id: checkinId, row },
    ]),
    created: { placeId, checkinId },
  };
}

/** What a person may change in a check-in (§9.4): everything but who made it and how. */
export interface CheckinPatch {
  /** Another place, which the zone then follows if the moment is not live. */
  readonly place?: PlaceView;
  /** Another moment, in the past. */
  readonly at?: number;
  /** A zone chosen by hand. */
  readonly tz?: string;
  /** `null` takes the note away. */
  readonly note?: string | null;
  readonly companions?: readonly string[];
  readonly share?: Share;
  /** A trip chosen by hand, or `null` to take the link away by hand: either is `manual`, and nothing automatic changes it again. `'auto'` hands it back to the app. */
  readonly trip?: { readonly tripId: string } | null | 'auto';
}

/**
 * Changes a check-in. The row is sent whole, with the version it was made from, so the edit that reaches the server later stands (§15.4). Changing the moment, the place or the zone works out
 * the offset again and, unless the link was made by hand, asks the auto-link hook again. `current` is the check-in as the screen shows it.
 */
export function editCheckin(
  current: CheckinView | undefined,
  patch: CheckinPatch,
  ctx: Context,
): ActionResult {
  if (!current) return refuse('missing');
  const placeId = patch.place?.id ?? current.placeId;
  const at = patch.at ?? current.at;
  // The zone follows a new place when the moment is not live; a zone chosen by hand wins; otherwise it stays.
  const placeMoved = patch.place !== undefined && patch.place.id !== current.placeId;
  const tz = patch.tz ?? (placeMoved ? (patch.place?.tz ?? current.tz) : current.tz);
  const timeChanged = at !== current.at || tz !== current.tz;
  let offsetMin = current.offsetMin;
  if (timeChanged) {
    try {
      offsetMin = offsetMinutes(at, tz);
    } catch {
      return refuse('zone');
    }
  }
  let tripId = current.tripId;
  let linkSource = current.linkSource;
  if (patch.trip === null) {
    tripId = null;
    linkSource = 'manual';
  } else if (patch.trip !== undefined && patch.trip !== 'auto') {
    tripId = patch.trip.tripId;
    linkSource = 'manual';
  } else if (patch.trip === 'auto' || ((placeMoved || timeChanged) && linkSource !== 'manual')) {
    const link = ctx.link?.({ at, tz, placeId }) ?? null;
    tripId = link?.tripId ?? null;
    linkSource = link ? 'auto' : null;
  }
  const note = patch.note === undefined ? current.note : (patch.note ?? undefined);
  const next = validateCheckinRow(
    {
      placeId,
      at,
      tz,
      offsetMin,
      note,
      companions: patch.companions ?? current.companions,
      tripId,
      linkSource,
      share: patch.share ?? current.share,
      source: current.source,
      externalId: current.externalId,
    },
    ctx.now,
  );
  if (!next.ok) return next;
  const unchanged = JSON.stringify(next.value) === JSON.stringify(normalised(current));
  if (unchanged) return refuse('nothing');
  return {
    ok: true,
    mutation: mutation(ctx, [
      {
        table: 'checkin',
        op: 'put',
        id: current.id,
        baseVersion: current.version,
        row: next.value,
      },
    ]),
    created: {},
  };
}

/** The row of a check-in as validation shapes it, for comparing with what an edit would make. */
function normalised(view: CheckinView): CheckinRow | undefined {
  const { id: _id, version: _version, ...row } = view;
  const checked = validateCheckinRow(row, Number.MAX_SAFE_INTEGER);
  return checked.ok ? checked.value : undefined;
}

/** Deletes a check-in, for good, with its photos (§9.4): the confirmation is the screen's. */
export function deleteCheckin(current: CheckinView | undefined, ctx: Context): ActionResult {
  if (!current) return refuse('missing');
  return {
    ok: true,
    mutation: mutation(ctx, [{ table: 'checkin', op: 'delete', id: current.id }]),
    created: {},
  };
}

export type { CheckinSource };
