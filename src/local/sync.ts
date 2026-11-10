import type { SyncResponse } from '../sync/endpoint';
import { LIMITS, PROTOCOL_VERSION } from '../sync/format';
import type { LocalStore } from './store';

/**
 * The device's side of the sync (DESIGN.md §15.3): send the outbox in order with the cursor, settle what comes back, and go on while there is more to send or to pull. **Nothing here can lose
 * what a person recorded:** a request that fails for any reason leaves the outbox as it was, and sending it again is safe, since the server answers a mutation it has already applied as a replay.
 */
export type SyncState =
  /** Caught up with what the server said. */
  | 'ok'
  /** No network, or the server could not be reached: the outbox is kept and it is tried again. */
  | 'offline'
  /** The session has ended: sign in again as the same account; the outbox is kept (§15.8). */
  | 'signed_out'
  /** This version of the app is too old for the server: update; the outbox is kept (§15.3). */
  | 'update_required'
  /** Too many requests: later. */
  | 'busy'
  /** Anything else: the same as offline, and said apart so that it can be looked at. */
  | 'error';

/** Sends a request and gives back the status and the JSON. It throws when there is no network. */
export type Transport = (body: unknown) => Promise<{ status: number; json: unknown }>;

/** The browser's: a POST to this app's own server, with the session cookie, which the browser sends with `Origin`. */
export const fetchTransport: Transport = async (body) => {
  const response = await fetch('/api/sync', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json: unknown = await response.json().catch(() => null);
  return { status: response.status, json };
};

function isResponse(value: unknown): value is SyncResponse {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Partial<SyncResponse>;
  return (
    v.protocol === PROTOCOL_VERSION &&
    Array.isArray(v.results) &&
    typeof v.account === 'object' &&
    v.account !== null &&
    Array.isArray(v.account.places) &&
    Array.isArray(v.account.checkins) &&
    Array.isArray(v.account.deleted) &&
    typeof v.account.cursor === 'number' &&
    typeof v.account.floor === 'number' &&
    typeof v.account.reset === 'boolean' &&
    typeof v.account.more === 'boolean'
  );
}

/** The most requests one run makes before it stops and lets the next trigger go on: a device a very long way behind catches up over a few runs. */
const MAX_ROUNDS = 40;

/** One run: sends the outbox in turns of fifty, pulls pages until there are no more, and says how it ended. */
export async function syncOnce(
  store: LocalStore,
  transport: Transport,
  options: { limit?: number } = {},
): Promise<SyncState> {
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const sent = await store.pending(LIMITS.outbox);
    const cursor = await store.cursor();
    const floor = await store.floor();
    let reply: { status: number; json: unknown };
    try {
      reply = await transport({
        protocol: PROTOCOL_VERSION,
        outbox: sent.map((entry) => entry.mutation),
        cursor,
        floor,
        ...(options.limit ? { limit: options.limit } : {}),
      });
    } catch {
      return 'offline';
    }
    if (reply.status === 401) return 'signed_out';
    if (reply.status === 426) return 'update_required';
    if (reply.status === 429) return 'busy';
    if (reply.status >= 500) return 'offline';
    if (reply.status !== 200 || !isResponse(reply.json)) return 'error';
    await store.settle(sent, reply.json);
    // More to pull, or more to send than one request carries: go round again at once.
    if (reply.json.account.more || (await store.pendingCount()) > 0) {
      // A request that applied nothing and moved no cursor would go round for ever.
      if (!reply.json.account.more && sent.length === 0) return 'ok';
      continue;
    }
    return 'ok';
  }
  return 'ok';
}
