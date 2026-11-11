import { TRIP_ID, TripError } from './format';
import {
  AttachmentRefused,
  type AttachmentDeps,
  type AttachmentView,
  deleteAttachment,
  listAttachments,
  updateAttachment,
} from './attachments';
import {
  LinkRefused,
  type LinkView,
  addLink,
  listLinks,
  moveLink,
  removeLink,
  updateLink,
} from './links';
import { setGoing, setRole } from './members';
import { setShareChoice } from '../sharing/choice';
import type { ShareChoice } from '../sharing/rules';
import { type SharedCheckin, listShared } from '../sharing/read';
import {
  type Plan,
  PlanRefused,
  addItem,
  addStop,
  clearDayItems,
  deleteItem,
  moveDayItems,
  moveItem,
  moveStop,
  readPlan,
  removeStop,
  updateItem,
  updateStop,
} from './plan';
import {
  LimitReached,
  type MemberView,
  type TripDeletion,
  type TripView,
  createTrip,
  deleteTrip,
  getTrip,
  listTrips,
  previewDeletion,
  setReady,
  updateTrip,
} from './trips';
import type { ItemPatch, NewItem, NewStop } from './plan';

/**
 * The operations on trips (DESIGN.md §15.7: **trips, stops, ready, members, roles, invitations, attachments and links are online operations**, decided by the server at once and not queued on a device). One request is one
 * operation, `{ "op": "trip.create", … }`; `parseOp` says whether it is one, and `applyOp` does it **for the account the session names, never for one the request names**. The answer to an operation is a body with `ok`:
 * a refusal says `not_found` for everything that is not the caller's or that their role does not allow (the same words for both, so that a trip is never confirmed to someone who is not in it), `invalid` with a sentence for a
 * value that is not a trip's, and `limit` with a sentence for a server limit.
 */
/** What the operations need: the trips' own, and the media store for the files of attachments. */
export type OpDeps = AttachmentDeps;

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
  | { op: 'trip.ready'; tripId: string }
  | { op: 'trip.planning'; tripId: string }
  | { op: 'member.role'; tripId: string; accountId: string; role: string }
  | { op: 'member.going'; tripId: string; going: boolean }
  | { op: 'member.share'; tripId: string; choice: string }
  | { op: 'checkin.shared'; tripId: string; after?: number }
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
  | ({ op: 'item.add'; tripId: string } & NewItem)
  | ({ op: 'item.update'; tripId: string; itemId: string } & ItemPatch)
  | { op: 'item.move'; tripId: string; itemId: string; dayId: string; before: string | null }
  | { op: 'item.delete'; tripId: string; itemId: string }
  | { op: 'day.moveItems'; tripId: string; fromDayId: string; toDayId: string }
  | { op: 'day.clearItems'; tripId: string; dayId: string }
  | { op: 'link.list'; tripId: string }
  | {
      op: 'link.add';
      tripId: string;
      url: unknown;
      kind?: unknown;
      title?: unknown;
      before?: string | null;
    }
  | {
      op: 'link.update';
      tripId: string;
      linkId: string;
      url?: unknown;
      kind?: unknown;
      title?: unknown;
    }
  | { op: 'link.move'; tripId: string; linkId: string; before: string | null }
  | { op: 'link.remove'; tripId: string; linkId: string }
  | { op: 'attachment.list'; tripId: string }
  | {
      op: 'attachment.update';
      tripId: string;
      attachmentId: string;
      title?: unknown;
      kind?: unknown;
      dayId?: unknown;
    }
  | { op: 'attachment.delete'; tripId: string; attachmentId: string }
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
  // Marking ready, and back to planning, is the owner's decision (DESIGN.md §10.2): Organizers.
  'trip.ready': 'organizer',
  'trip.planning': 'organizer',
  // Roles are changed by Organizers, and only an Organizer has a "Not going" switch (DESIGN.md §11.1).
  'member.role': 'organizer',
  'member.going': 'organizer',
  // A Traveler's (or going Organizer's) own choice to share their check-ins on the trip, and what the members are given of them: every member reads it, Followers too (DESIGN.md §11.3).
  'member.share': 'editor',
  'checkin.shared': 'member',
  'trip.update': 'organizer',
  // Organizers and Travelers edit the plan (DESIGN.md §10.3, §11.1).
  'stop.add': 'editor',
  'stop.update': 'editor',
  'stop.move': 'editor',
  'stop.remove': 'editor',
  // Items are the plan too: Organizers and Travelers (DESIGN.md §10.5, §11.1).
  'item.add': 'editor',
  'item.update': 'editor',
  'item.move': 'editor',
  'item.delete': 'editor',
  'day.moveItems': 'editor',
  'day.clearItems': 'editor',
  // Attachments: Organizers and Travelers see and change them, **Followers never** (DESIGN.md §10.6, §11.1).
  // Links are read by every member, Followers too, and edited by Organizers and Travelers (DESIGN.md §10.7, §11.1).
  'link.list': 'member',
  'link.add': 'editor',
  'link.update': 'editor',
  'link.move': 'editor',
  'link.remove': 'editor',
  'attachment.list': 'editor',
  'attachment.update': 'editor',
  'attachment.delete': 'editor',
  'trip.delete.preview': 'organizer',
  'trip.delete': 'organizer',
};

const isId = (value: unknown): value is string => typeof value === 'string' && TRIP_ID.test(value);
const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const KEYS: Readonly<Record<OpName, readonly string[]>> = {
  'trip.list': ['op'],
  'trip.get': ['op', 'tripId'],
  'trip.create': ['op', 'name', 'description', 'color'],
  'trip.update': ['op', 'tripId', 'name', 'description', 'color', 'coverPlaceId'],
  'trip.plan': ['op', 'tripId'],
  'trip.ready': ['op', 'tripId'],
  'trip.planning': ['op', 'tripId'],
  'member.role': ['op', 'tripId', 'accountId', 'role'],
  'member.going': ['op', 'tripId', 'going'],
  'member.share': ['op', 'tripId', 'choice'],
  'checkin.shared': ['op', 'tripId', 'after'],
  'stop.add': ['op', 'tripId', 'place', 'arrive', 'depart', 'note'],
  'stop.update': ['op', 'tripId', 'stopId', 'arrive', 'depart', 'note'],
  'stop.move': ['op', 'tripId', 'stopId', 'before'],
  'stop.remove': ['op', 'tripId', 'stopId'],
  'item.add': [
    'op',
    'tripId',
    'dayId',
    'title',
    'notes',
    'kind',
    'start',
    'end',
    'fixed',
    'place',
    'placeId',
    'before',
  ],
  'item.update': [
    'op',
    'tripId',
    'itemId',
    'title',
    'notes',
    'kind',
    'start',
    'end',
    'fixed',
    'place',
    'placeId',
  ],
  'item.move': ['op', 'tripId', 'itemId', 'dayId', 'before'],
  'item.delete': ['op', 'tripId', 'itemId'],
  'day.moveItems': ['op', 'tripId', 'fromDayId', 'toDayId'],
  'day.clearItems': ['op', 'tripId', 'dayId'],
  'link.list': ['op', 'tripId'],
  'link.add': ['op', 'tripId', 'url', 'kind', 'title', 'before'],
  'link.update': ['op', 'tripId', 'linkId', 'url', 'kind', 'title'],
  'link.move': ['op', 'tripId', 'linkId', 'before'],
  'link.remove': ['op', 'tripId', 'linkId'],
  'attachment.list': ['op', 'tripId'],
  'attachment.update': ['op', 'tripId', 'attachmentId', 'title', 'kind', 'dayId'],
  'attachment.delete': ['op', 'tripId', 'attachmentId'],
  'trip.delete.preview': ['op', 'tripId'],
  'trip.delete': ['op', 'tripId', 'confirm'],
};

/** The ids, besides the trip's, each operation must name. */
const NAMES: Partial<Record<OpName, readonly string[]>> = {
  'item.add': ['dayId'],
  'item.update': ['itemId'],
  'item.move': ['itemId', 'dayId'],
  'item.delete': ['itemId'],
  'day.moveItems': ['fromDayId', 'toDayId'],
  'day.clearItems': ['dayId'],
  'link.update': ['linkId'],
  'link.move': ['linkId'],
  'link.remove': ['linkId'],
  'attachment.update': ['attachmentId'],
  'attachment.delete': ['attachmentId'],
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
  // The ids an operation names, each one a trip-style id: what is inside a value is checked when the operation is done.
  for (const key of NAMES[name] ?? []) if (!isId(request[key])) return { ok: false };
  if (
    (name === 'item.move' || name === 'item.add') &&
    'before' in request &&
    request.before !== null &&
    !isId(request.before)
  )
    return { ok: false };
  if (name === 'item.move' && !('before' in request)) return { ok: false };
  if (
    name === 'item.update' &&
    !['title', 'notes', 'kind', 'start', 'end', 'fixed', 'place', 'placeId'].some(
      (key) => key in request,
    )
  )
    return { ok: false };
  if (
    name === 'member.role' &&
    (typeof request.accountId !== 'string' || typeof request.role !== 'string')
  )
    return { ok: false };
  if (
    name === 'link.add' &&
    (!('url' in request) ||
      ('before' in request && request.before !== null && !isId(request.before)))
  )
    return { ok: false };
  if (name === 'link.update' && !['url', 'kind', 'title'].some((key) => key in request))
    return { ok: false };
  if (
    name === 'link.move' &&
    (!('before' in request) || (request.before !== null && !isId(request.before)))
  )
    return { ok: false };
  if (name === 'attachment.update' && !['title', 'kind', 'dayId'].some((key) => key in request))
    return { ok: false };
  if (
    name === 'attachment.update' &&
    'dayId' in request &&
    request.dayId !== null &&
    !isId(request.dayId)
  )
    return { ok: false };
  if (name === 'member.going' && typeof request.going !== 'boolean') return { ok: false };
  if (name === 'member.share' && typeof request.choice !== 'string') return { ok: false };
  if (
    name === 'checkin.shared' &&
    'after' in request &&
    !(typeof request.after === 'number' && Number.isInteger(request.after) && request.after >= 0)
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
  | { ok: true; links: LinkView[] }
  | { ok: true; choice: ShareChoice }
  | { ok: true; checkins: SharedCheckin[] }
  | { ok: true; attachments: AttachmentView[] }
  | { ok: true; attachment: AttachmentView }
  | { ok: true; trips: TripView[] }
  | { ok: true; trip: TripView; members?: MemberView[] }
  | { ok: true; deletion: TripDeletion }
  | { ok: true; deleted: true }
  | { ok: true; plan: Plan }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'invalid' | 'limit' | 'overlap'; sentence: string }
  | { ok: false; reason: 'items'; sentence: string; days: string[] };

const NOT_FOUND = { ok: false, reason: 'not_found' } as const;
const linksResult = (links: LinkView[] | undefined): OpResult =>
  links ? { ok: true, links } : NOT_FOUND;
const planResult = (plan: Plan | undefined): OpResult => (plan ? { ok: true, plan } : NOT_FOUND);

/** Does one operation for the account. Never throws for what a person did: a value that is not a trip's, a limit and a trip that is not theirs are answers. */
export async function applyOp(deps: OpDeps, accountId: string, op: Op): Promise<OpResult> {
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
      case 'item.add':
        return planResult(await addItem(deps, accountId, op.tripId, op));
      case 'item.update':
        return planResult(await updateItem(deps, accountId, op.tripId, op.itemId, op));
      case 'item.move':
        return planResult(
          await moveItem(deps, accountId, op.tripId, op.itemId, op.dayId, op.before),
        );
      case 'item.delete':
        return planResult(await deleteItem(deps, accountId, op.tripId, op.itemId));
      case 'day.moveItems':
        return planResult(await moveDayItems(deps, accountId, op.tripId, op.fromDayId, op.toDayId));
      case 'day.clearItems':
        return planResult(await clearDayItems(deps, accountId, op.tripId, op.dayId));
      case 'trip.ready':
      case 'trip.planning': {
        const trip = await setReady(deps, accountId, op.tripId, op.op === 'trip.ready');
        return trip ? { ok: true, trip } : NOT_FOUND;
      }
      case 'member.role': {
        const trip = await setRole(deps, accountId, op.tripId, op.accountId, op.role);
        return trip ? { ok: true, trip } : NOT_FOUND;
      }
      case 'member.going': {
        const trip = await setGoing(deps, accountId, op.tripId, op.going);
        return trip ? { ok: true, trip } : NOT_FOUND;
      }
      case 'member.share': {
        const choice = await setShareChoice(deps, accountId, op.tripId, op.choice);
        return choice ? { ok: true, choice } : NOT_FOUND;
      }
      case 'checkin.shared': {
        const checkins = await listShared(
          deps.database,
          deps.sealer,
          accountId,
          op.tripId,
          op.after ?? 0,
        );
        return checkins ? { ok: true, checkins } : NOT_FOUND;
      }
      case 'link.list': {
        const links = await listLinks(deps, accountId, op.tripId);
        return links ? { ok: true, links } : NOT_FOUND;
      }
      case 'link.add':
        return linksResult(await addLink(deps, accountId, op.tripId, op));
      case 'link.update':
        return linksResult(await updateLink(deps, accountId, op.tripId, op.linkId, op));
      case 'link.move':
        return linksResult(await moveLink(deps, accountId, op.tripId, op.linkId, op.before));
      case 'link.remove':
        return linksResult(await removeLink(deps, accountId, op.tripId, op.linkId));
      case 'attachment.list': {
        const attachments = await listAttachments(deps, accountId, op.tripId);
        return attachments ? { ok: true, attachments } : NOT_FOUND;
      }
      case 'attachment.update': {
        const attachment = await updateAttachment(deps, accountId, op.tripId, op.attachmentId, op);
        return attachment ? { ok: true, attachment } : NOT_FOUND;
      }
      case 'attachment.delete':
        return (await deleteAttachment(deps, accountId, op.tripId, op.attachmentId))
          ? { ok: true, deleted: true }
          : NOT_FOUND;
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
    if (error instanceof LinkRefused)
      return { ok: false, reason: error.reason, sentence: error.sentence };
    if (error instanceof AttachmentRefused)
      return error.reason === 'limit'
        ? { ok: false, reason: 'limit', sentence: error.sentence }
        : { ok: false, reason: 'invalid', sentence: error.sentence };
    if (error instanceof LimitReached)
      return { ok: false, reason: 'limit', sentence: error.sentence };
    throw error;
  }
}
