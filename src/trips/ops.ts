import { TRIP_ID, TripError } from './format';
import {
  type Plan,
  PlanRefused,
  addStop,
  moveStop,
  readPlan,
  removeStop,
  updateStop,
} from './plan';
import {
  LimitReached,
  type MemberView,
  type TripDeletion,
  type TripDeps,
  type TripView,
  createTrip,
  deleteTrip,
  getTrip,
  listTrips,
  previewDeletion,
  updateTrip,
} from './trips';
import type { NewStop } from './plan';

/**
 * The operations on trips (DESIGN.md §15.7: **trips, stops, ready, members, roles, invitations, attachments and links are online operations**, decided by the server at once and not queued on a device). One request is one
 * operation, `{ "op": "trip.create", … }`; `parseOp` says whether it is one, and `applyOp` does it **for the account the session names, never for one the request names**. The answer to an operation is a body with `ok`:
 * a refusal says `not_found` for everything that is not the caller's or that their role does not allow (the same words for both, so that a trip is never confirmed to someone who is not in it), `invalid` with a sentence for a
 * value that is not a trip's, and `limit` with a sentence for a server limit.
 */
export type Op =
  | { op: 'trip.list' }
  | { op: 'trip.get'; tripId: string }
  | { op: 'trip.create'; name: unknown; description?: unknown; color?: unknown }
  | {
      op: 'trip.update';
      tripId: string;
      name?: unknown;
      description?: unknown;
      color?: unknown;
      coverPlaceId?: unknown;
    }
  | { op: 'trip.plan'; tripId: string }
  | {
      op: 'stop.add';
      tripId: string;
      place: NewStop['place'];
      arrive?: unknown;
      depart?: unknown;
      note?: unknown;
    }
  | {
      op: 'stop.update';
      tripId: string;
      stopId: string;
      arrive?: unknown;
      depart?: unknown;
      note?: unknown;
    }
  | { op: 'stop.move'; tripId: string; stopId: string; before: string | null }
  | { op: 'stop.remove'; tripId: string; stopId: string }
  | { op: 'trip.delete.preview'; tripId: string }
  | { op: 'trip.delete'; tripId: string; confirm: true };

export type OpName = Op['op'];

/** Who may do each, for the access table (`src/access/routes.ts`) and the test that calls each as every role. */
export const OPERATIONS: Readonly<Record<OpName, 'account' | 'member' | 'editor' | 'organizer'>> = {
  // For the account itself: it lists the account's own trips and makes a trip of its own.
  'trip.list': 'account',
  'trip.create': 'account',
  'trip.get': 'member',
  // The plan is read by every member, Followers too (DESIGN.md §11.1).
  'trip.plan': 'member',
  'trip.update': 'organizer',
  // Organizers and Travelers edit the plan (DESIGN.md §10.3, §11.1).
  'stop.add': 'editor',
  'stop.update': 'editor',
  'stop.move': 'editor',
  'stop.remove': 'editor',
  'trip.delete.preview': 'organizer',
  'trip.delete': 'organizer',
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const KEYS: Readonly<Record<OpName, readonly string[]>> = {
  'trip.list': ['op'],
  'trip.get': ['op', 'tripId'],
  'trip.create': ['op', 'name', 'description', 'color'],
  'trip.update': ['op', 'tripId', 'name', 'description', 'color', 'coverPlaceId'],
  'trip.plan': ['op', 'tripId'],
  'stop.add': ['op', 'tripId', 'place', 'arrive', 'depart', 'note'],
  'stop.update': ['op', 'tripId', 'stopId', 'arrive', 'depart', 'note'],
  'stop.move': ['op', 'tripId', 'stopId', 'before'],
  'stop.remove': ['op', 'tripId', 'stopId'],
  'trip.delete.preview': ['op', 'tripId'],
  'trip.delete': ['op', 'tripId', 'confirm'],
};

/** Whether a request is an operation: a known name, the keys that name takes and no others, and a trip id where one is needed. What is inside a value is checked when the operation is done. */
export function parseOp(request: unknown): { ok: true; value: Op } | { ok: false } {
  if (
    !isObject(request) ||
    typeof request.op !== 'string' ||
    !Object.hasOwn(OPERATIONS, request.op)
  )
    return { ok: false };
  const name = request.op as OpName;
  if (!Object.keys(request).every((key) => KEYS[name].includes(key))) return { ok: false };
  if (KEYS[name].includes('tripId')) {
    if (typeof request.tripId !== 'string' || !TRIP_ID.test(request.tripId)) return { ok: false };
  }
  if (KEYS[name].includes('stopId')) {
    if (typeof request.stopId !== 'string' || !TRIP_ID.test(request.stopId)) return { ok: false };
  }
  if (
    name === 'stop.move' &&
    request.before !== null &&
    !(typeof request.before === 'string' && TRIP_ID.test(request.before))
  )
    return { ok: false };
  if (name === 'stop.add' && !isObject(request.place)) return { ok: false };
  if (name === 'stop.update' && !['arrive', 'depart', 'note'].some((key) => key in request))
    return { ok: false };
  if (name === 'trip.delete' && request.confirm !== true) return { ok: false };
  if (name === 'trip.create' && request.name === undefined) return { ok: false };
  if (
    name === 'trip.update' &&
    !['name', 'description', 'color', 'coverPlaceId'].some((key) => key in request)
  )
    return { ok: false };
  return { ok: true, value: request as unknown as Op };
}

export type OpResult =
  | { ok: true; trips: TripView[] }
  | { ok: true; trip: TripView; members?: MemberView[] }
  | { ok: true; deletion: TripDeletion }
  | { ok: true; deleted: true }
  | { ok: true; plan: Plan }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'invalid' | 'limit' | 'overlap'; sentence: string }
  | { ok: false; reason: 'items'; sentence: string; days: string[] };

const NOT_FOUND = { ok: false, reason: 'not_found' } as const;
const planResult = (plan: Plan | undefined): OpResult => (plan ? { ok: true, plan } : NOT_FOUND);

/** Does one operation for the account. Never throws for what a person did: a value that is not a trip's, a limit and a trip that is not theirs are answers. */
export async function applyOp(deps: TripDeps, accountId: string, op: Op): Promise<OpResult> {
  try {
    switch (op.op) {
      case 'trip.list':
        return { ok: true, trips: await listTrips(deps, accountId) };
      case 'trip.create':
        return { ok: true, trip: await createTrip(deps, accountId, op) };
      case 'trip.get': {
        const found = await getTrip(deps, accountId, op.tripId);
        return found ? { ok: true, trip: found.trip, members: found.members } : NOT_FOUND;
      }
      case 'trip.update': {
        const trip = await updateTrip(deps, accountId, op.tripId, op);
        return trip ? { ok: true, trip } : NOT_FOUND;
      }
      case 'trip.plan': {
        const plan = await readPlan(deps, accountId, op.tripId);
        return plan ? { ok: true, plan } : NOT_FOUND;
      }
      case 'stop.add':
        return planResult(await addStop(deps, accountId, op.tripId, op));
      case 'stop.update':
        return planResult(await updateStop(deps, accountId, op.tripId, op.stopId, op));
      case 'stop.move':
        return planResult(await moveStop(deps, accountId, op.tripId, op.stopId, op.before));
      case 'stop.remove':
        return planResult(await removeStop(deps, accountId, op.tripId, op.stopId));
      case 'trip.delete.preview': {
        const deletion = await previewDeletion(deps, accountId, op.tripId);
        return deletion ? { ok: true, deletion } : NOT_FOUND;
      }
      case 'trip.delete':
        return (await deleteTrip(deps, accountId, op.tripId))
          ? { ok: true, deleted: true }
          : NOT_FOUND;
    }
  } catch (error) {
    if (error instanceof TripError)
      return { ok: false, reason: 'invalid', sentence: error.message };
    if (error instanceof PlanRefused)
      return error.failure.reason === 'items'
        ? { ok: false, reason: 'items', sentence: error.failure.sentence, days: error.failure.days }
        : { ok: false, reason: error.failure.reason, sentence: error.failure.sentence };
    if (error instanceof LimitReached)
      return { ok: false, reason: 'limit', sentence: error.sentence };
    throw error;
  }
}
