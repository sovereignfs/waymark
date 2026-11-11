import { type ApplyDeps, applyMutation } from './apply';
import { TRIP_ID } from '../trips/format';
import { applyTripMutation } from '../trips/sync';
import { LIMITS, PROTOCOL_VERSION } from './format';
import { DEFAULT_PAGE, MAX_PAGE, type Page, pullAccount } from './pull';
import type { TripAsks, TripPage } from './trip-format';
import { pullTrips } from './trips';

/**
 * `POST /api/sync` without the HTTP around it (DESIGN.md §15.3): what a device sends, and what the server answers. The session and `Origin` are checked by the route before this is called, and the
 * **account is the session's**: nothing in the request says whose rows these are.
 *
 * A request carries the device's **outbox, in order**, and a **cursor** for its stream; the answer says, for each mutation, whether it was **applied**, was **a replay** (it had reached the server
 * before, and a lost answer is how a device finds out) or was **refused**, with a reason and a sentence (the device keeps it in Couldn't sync, §15.5), and then **what changed since the cursor**,
 * a page at a time (`more` says to ask again at once). A refused mutation does not stop the ones after it: they are separate, and one that depended on it is refused for that. The mutations are
 * applied before the pull, so a device is given its own changes back at once and sees the server's numbers on them.
 *
 * A device that speaks another protocol is told to update before anything is done, and its outbox stays with it (§15.3). Nothing here logs what a mutation or a page holds.
 */
export interface SyncRequest {
  readonly protocol: number;
  readonly outbox?: unknown[];
  /** The number of the last change the device has seen in its stream; 0 for a device that has none. */
  readonly cursor?: number;
  /** The floor of the stream the device last saw (`history.ts`); 0 for a device that has none. A device behind it is given a fresh snapshot. */
  readonly floor?: number;
  readonly limit?: number;
  /** For each trip the device holds: the cursor and floor of its stream. A trip the account is in that is not named is given whole (6.6). */
  readonly trips?: TripAsks;
}

export type Outcome =
  | { readonly mutationId: string; readonly status: 'applied'; readonly seq: number }
  | { readonly mutationId: string; readonly status: 'replay' }
  | {
      readonly mutationId: string;
      readonly status: 'refused';
      readonly reason: string;
      readonly sentence: string;
    };

export interface SyncResponse {
  readonly protocol: number;
  /** One for each mutation sent, in the order sent. */
  readonly results: Outcome[];
  readonly account: Page;
  /** One page for each trip the account is an active member of (6.6). */
  readonly trips: TripPage[];
  /** Trips the device holds that the account is not in any more: the device deletes its copy. */
  readonly gone: string[];
}

export type SyncAnswer =
  | { readonly status: 200; readonly body: SyncResponse }
  | {
      readonly status: 400 | 413 | 426;
      readonly body: { readonly code: string; readonly protocol?: number };
    };

/** The most mutations a request carries: a device with more sends them in turns. */
export const MAX_OUTBOX = LIMITS.outbox;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export async function handleSync(
  deps: ApplyDeps,
  accountId: string,
  body: unknown,
): Promise<SyncAnswer> {
  if (!isObject(body)) return { status: 400, body: { code: 'BAD_REQUEST' } };
  if (body.protocol !== PROTOCOL_VERSION)
    return { status: 426, body: { code: 'UPDATE_REQUIRED', protocol: PROTOCOL_VERSION } };
  const outbox = body.outbox ?? [];
  if (!Array.isArray(outbox)) return { status: 400, body: { code: 'BAD_REQUEST' } };
  if (outbox.length > MAX_OUTBOX) return { status: 413, body: { code: 'TOO_MANY' } };
  const cursor = body.cursor ?? 0;
  if (typeof cursor !== 'number' || !Number.isInteger(cursor) || cursor < 0)
    return { status: 400, body: { code: 'BAD_REQUEST' } };
  const floor = body.floor ?? 0;
  if (typeof floor !== 'number' || !Number.isInteger(floor) || floor < 0)
    return { status: 400, body: { code: 'BAD_REQUEST' } };
  const limit = body.limit ?? DEFAULT_PAGE;
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE)
    return { status: 400, body: { code: 'BAD_REQUEST' } };

  const asked = readAsks(body.trips);
  if (asked === undefined) return { status: 400, body: { code: 'BAD_REQUEST' } };

  const results: Outcome[] = [];
  for (const mutation of outbox) {
    // The id is read for the answer only; whether it is a valid one is `applyMutation`'s to say.
    const mutationId =
      isObject(mutation) && typeof mutation.mutationId === 'string'
        ? mutation.mutationId.slice(0, 64)
        : '';
    // A mutation names the stream it belongs to: the person's own, or a trip's.
    const inTrip =
      isObject(mutation) &&
      typeof mutation.stream === 'string' &&
      mutation.stream.startsWith('trip:');
    const applied = inTrip
      ? await applyTripMutation(
          {
            database: deps.database,
            sealer: deps.sealer,
            now: deps.now,
            limits: deps.limits,
            delivery: deps.notify?.delivery,
          },
          accountId,
          mutation,
        )
      : await applyMutation(deps, accountId, mutation);
    if (applied.status === 'applied')
      results.push({ mutationId, status: 'applied', seq: applied.seq });
    else if (applied.status === 'replay') results.push({ mutationId, status: 'replay' });
    else
      results.push({
        mutationId,
        status: 'refused',
        reason: applied.reason,
        sentence: applied.sentence,
      });
  }
  const account = await pullAccount(deps, accountId, cursor, limit, floor);
  const { trips, gone } = await pullTrips(deps, accountId, asked, limit);
  return { status: 200, body: { protocol: PROTOCOL_VERSION, results, account, trips, gone } };
}

/** The most trips a device names in one request. */
const MAX_TRIPS = 500;

/** What a device says it holds of its trips: ids with a cursor and a floor each, or undefined if it is not that. */
function readAsks(value: unknown): TripAsks | undefined {
  if (value === undefined) return {};
  if (!isObject(value)) return undefined;
  const entries = Object.entries(value);
  if (entries.length > MAX_TRIPS) return undefined;
  const asks: Record<string, { cursor: number; floor: number }> = {};
  for (const [id, ask] of entries) {
    if (
      !TRIP_ID.test(id) ||
      !isObject(ask) ||
      typeof ask.cursor !== 'number' ||
      !Number.isInteger(ask.cursor) ||
      ask.cursor < 0 ||
      typeof ask.floor !== 'number' ||
      !Number.isInteger(ask.floor) ||
      ask.floor < 0
    )
      return undefined;
    asks[id] = { cursor: ask.cursor, floor: ask.floor };
  }
  return asks;
}
