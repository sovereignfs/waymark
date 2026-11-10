import { refuse, validatePlaceRow } from '../checkins/validate';
import type { Address } from '../places/clean';
import { zoneOf } from '../places/tz';
import { ACCOUNT_STREAM, type Mutation, type PlaceRow } from '../sync/format';
import type { ActionResult, CheckinView, Context, NewPlaceInput, PlaceView } from './types';

/**
 * What a person does to a place (DESIGN.md §7.1, §20.8): make one, change it, delete it. Pure (see `types.ts`). A place is **its owner's**; a change replaces the row whole and names the version
 * it was made from, so the later of two edits stands (§15.4). What a place needs to be a place is checked here with the rules the server applies again (`checkins/validate.ts`).
 */
const mutation = (ctx: Context, changes: Mutation['changes']): Mutation => ({
  mutationId: ctx.ids.newId(),
  stream: ACCOUNT_STREAM,
  changes,
});

/** A place's row from what a person gave: the zone is found from the point unless one was given (§7.3). Returns the row, or why not. */
export function placeRowOf(input: NewPlaceInput): ReturnType<typeof validatePlaceRow> {
  const tz = input.tz ?? zoneOf(input.lat, input.lng) ?? null;
  return validatePlaceRow({
    name: input.name,
    lat: input.lat,
    lng: input.lng,
    address: input.address,
    category: input.category,
    sourceId: input.sourceId,
    source: input.source ?? 'manual',
    tz,
  });
}

/** A new place of the person's own. */
export function createPlace(input: NewPlaceInput, ctx: Context): ActionResult {
  const row = placeRowOf(input);
  if (!row.ok) return row;
  const id = ctx.ids.newId();
  return {
    ok: true,
    mutation: mutation(ctx, [{ table: 'place', op: 'put', id, row: row.value }]),
    created: { placeId: id },
  };
}

/** What may be changed in a place. A category of nothing takes it away; an address of `null` takes it away; a zone of `null` finds it again from the point. */
export interface PlacePatch {
  readonly name?: string;
  readonly category?: string;
  readonly address?: Address | null;
  readonly point?: { readonly lat: number; readonly lng: number };
  readonly tz?: string | null;
}

/**
 * Renames, recategorizes, moves or corrects a place. A move finds the zone again from the new point unless one is given, and a zone a person corrected stays through a rename. The row is
 * sent whole, so the place is what this says it is when it arrives, and the version it was made from goes with it.
 */
export function updatePlace(
  place: PlaceView | undefined,
  patch: PlacePatch,
  ctx: Context,
): ActionResult {
  if (!place) return refuse('missing');
  const point = patch.point ?? { lat: place.lat, lng: place.lng };
  const tz =
    patch.tz === null
      ? (zoneOf(point.lat, point.lng) ?? null)
      : patch.tz !== undefined
        ? patch.tz
        : patch.point
          ? (zoneOf(point.lat, point.lng) ?? null)
          : place.tz;
  const address = patch.address === undefined ? place.address : (patch.address ?? undefined);
  const category =
    patch.category === undefined
      ? place.category
      : patch.category.trim() === ''
        ? undefined
        : patch.category;
  const row = validatePlaceRow({
    name: patch.name ?? place.name,
    lat: point.lat,
    lng: point.lng,
    address,
    category,
    sourceId: place.sourceId,
    source: place.source,
    tz,
  });
  if (!row.ok) return row;
  const before: PlaceRow = { ...place };
  const unchanged =
    row.value.name === before.name &&
    row.value.lat === before.lat &&
    row.value.lng === before.lng &&
    row.value.category === before.category &&
    row.value.tz === before.tz &&
    JSON.stringify(row.value.address ?? null) === JSON.stringify(before.address ?? null);
  if (unchanged) return refuse('nothing');
  return {
    ok: true,
    mutation: mutation(ctx, [
      { table: 'place', op: 'put', id: place.id, baseVersion: place.version, row: row.value },
    ]),
    created: {},
  };
}

/** Deletes a place that no check-in is at. `checkins` is every check-in the device holds for the person: one that names the place stops it, with a sentence that says what to do. */
export function deletePlace(
  place: PlaceView | undefined,
  checkins: readonly Pick<CheckinView, 'placeId'>[],
  ctx: Context,
): ActionResult {
  if (!place) return refuse('missing');
  if (checkins.some((each) => each.placeId === place.id)) return refuse('in_use');
  return {
    ok: true,
    mutation: mutation(ctx, [{ table: 'place', op: 'delete', id: place.id }]),
    created: {},
  };
}
