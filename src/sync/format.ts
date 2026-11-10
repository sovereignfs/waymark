import type { Address, PlaceSource } from '../places/clean';

/**
 * What a device may send, and what the server stores (DESIGN.md §15.2): **one definition, used by the browser before it queues a change and by the server when it applies one.** Nothing
 * here depends on the server, a browser or a database. `src/checkins/validate.ts` holds the rules a row and a mutation must meet.
 *
 * A **mutation** is what one thing a person did changes, applied once or not at all: its id, made by the device, makes replaying it harmless. It holds **changes**, each a whole row put
 * (a create, or an edit that replaces the row: the edit that reaches the server later stands, whole, §15.4) or a delete, and an edit carries the `baseVersion` it was made from. It belongs
 * to a **stream**: `account`, the person's own places and check-ins, today; a trip's (`trip:<id>`) joins with trips in phase 2.
 *
 * ```json
 * {
 *   "mutationId": "6f1c…", "stream": "account",
 *   "changes": [
 *     { "table": "place", "op": "put", "id": "a3d9…", "row": { "name": "Café de Flore", "lat": 48.854, "lng": 2.3326, "source": "osm", "tz": "Europe/Paris", "countryCode": "FR" } },
 *     { "table": "checkin", "op": "put", "id": "b81e…", "row": { "placeId": "a3d9…", "at": 1793000000000, "tz": "Europe/Paris", "offsetMin": 60, "companions": [], … } }
 *   ]
 * }
 * ```
 */

/** Bumped when a device and the server stop understanding each other. A device that is too old is told to update; its outbox is kept (§15.3). */
export const PROTOCOL_VERSION = 1;

/** The tables that sync in a person's own stream (§15.2): their places and their check-ins. */
export const TABLES = ['place', 'checkin'] as const;
export type SyncTable = (typeof TABLES)[number];

/** A person's own stream. */
export type Stream = 'account';
export const ACCOUNT_STREAM: Stream = 'account';

/** What a place is, as it travels. `unnamed` is a hint and is not stored: a place made from a point alone is named "A place near …" now, and by reverse lookup when it reaches the server (§9.2). */
export interface PlaceRow {
  readonly name: string;
  readonly lat: number;
  readonly lng: number;
  readonly address?: Address;
  readonly category?: string;
  readonly sourceId?: string;
  readonly source: PlaceSource;
  /** An IANA zone, found from the point on the device, and a default a person can correct (§7.3). */
  readonly tz: string | null;
  readonly countryCode: string | null;
  readonly unnamed?: boolean;
}

/** How a check-in was made (§9.1): at the moment, by hand for another time, or from an import. */
export type CheckinSource = 'live' | 'manual' | 'import:swarm';
export const CHECKIN_SOURCES: readonly CheckinSource[] = ['live', 'manual', 'import:swarm'];
/** Whether the trip link was made by the app (`auto`) or by a person (`manual`, which nothing automatic ever changes again, §12). */
export type LinkSource = 'auto' | 'manual';
/** Whether a check-in is shared with its trip: follow the trip's choice, or say yes or no for this one (§11.3). */
export type Share = 'trip' | 'on' | 'off';
export const SHARES: readonly Share[] = ['trip', 'on', 'off'];

/** What a check-in is, as it travels (§9.1). Photos join with 5.3. */
export interface CheckinRow {
  readonly placeId: string;
  /** The moment, in milliseconds since the epoch, UTC. */
  readonly at: number;
  /** The zone the person was in (§7.3), and its offset then, in minutes east of UTC, so that the local date and time are known without a zone table. */
  readonly tz: string;
  readonly offsetMin: number;
  readonly note?: string;
  readonly companions: readonly string[];
  readonly tripId: string | null;
  readonly linkSource: LinkSource | null;
  readonly share: Share;
  readonly source: CheckinSource;
  /** The import's own id, so that importing again adds nothing twice (§16). Only for `import:swarm`. */
  readonly externalId?: string;
}

export type Change =
  | {
      readonly table: 'place';
      readonly op: 'put';
      readonly id: string;
      /** The version this edit was made from; absent for a create. It says what was seen, and does not stop the edit: the later one stands (§15.4). */
      readonly baseVersion?: number;
      readonly row: PlaceRow;
    }
  | {
      readonly table: 'checkin';
      readonly op: 'put';
      readonly id: string;
      readonly baseVersion?: number;
      readonly row: CheckinRow;
    }
  | { readonly table: SyncTable; readonly op: 'delete'; readonly id: string };

export interface Mutation {
  readonly mutationId: string;
  readonly stream: Stream;
  readonly changes: readonly Change[];
}

export const LIMITS = {
  /** The most changes one mutation holds: a check-in at a new place is two. */
  changesPerMutation: 50,
  noteChars: 2000,
  companions: 20,
  companionChars: 60,
  photos: 10,
  externalIdChars: 200,
  /** How far ahead of the server's clock a check-in's moment may be, for the clocks of devices. */
  clockSkewMs: 5 * 60 * 1000,
} as const;
