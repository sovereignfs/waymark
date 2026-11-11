import { type DBSchema, type IDBPDatabase, openDB, deleteDB } from 'idb';
import type { CheckinView, PlaceView } from '../actions/types';
import type { Mutation } from '../sync/format';
import type { ItemRecord, TripSets } from '../sync/trip-format';
import type { SharedCheckin } from '../sharing/read';
import type { TripMutation } from '../trips/sync-format';

/**
 * The device's database (DESIGN.md §15.1): **one for each account**, named `waymark-<account id>`, in IndexedDB through `idb`. It holds what the account may see, as the server last said it, and what the
 * person has done since that the server has not heard: the **outbox**. A person's places and check-ins are the rows; screens read **the rows with the outbox laid over them** (`store.ts`), so a change
 * shows at once and goes away by itself if the server refuses it. Plain text, as the screens need it: it is the device's, and is deleted at sign-out (§15.8). Encryption at rest is the server's.
 */
export const DB_VERSION = 3;

/** What a device sends: a mutation of the person's own stream, or of a trip's (6.6). */
export type AnyMutation = Mutation | TripMutation;
export const dbName = (accountId: string): string => `waymark-${accountId}`;

/** An account id as a database name: better-auth's ids are plain, and nothing else is let through, so a name cannot be made to mean another database. */
export const isAccountId = (accountId: string): boolean => /^[A-Za-z0-9_-]{1,128}$/.test(accountId);

export interface OutboxEntry {
  /** The order the changes were made in; made by the database. */
  readonly n?: number;
  readonly mutationId: string;
  readonly mutation: AnyMutation;
  readonly queuedAt: number;
}

/**
 * What the server refused, kept with the sentence (DESIGN.md §15.5): **never silently dropped**. A mutation (`mutation`), or a photo that could not be uploaded (`photoId`, whose file is kept in
 * `photos` until the person sends it again or discards it, §15.6). Exactly one of the two.
 */
export interface Refused {
  /** The mutation's id; for a photo, `photo:<id>`. */
  readonly mutationId: string;
  readonly mutation?: AnyMutation;
  readonly photoId?: string;
  readonly reason: string;
  readonly sentence: string;
  readonly at: number;
}

/**
 * A photo taken on this device (DESIGN.md §9.3, §15.6): **the file is kept here, under the id the device made, until the server has it**, and shown from here meanwhile. **It is kept as bytes and
 * not as a `Blob`**: a browser may refuse to store a `Blob` in IndexedDB (WebKit does in the one the tests run, and older Safari had its own faults with them), and bytes are stored everywhere; a `Blob` is made
 * from them when the photo is shown or sent. `nextAttempt` is when to try
 * again after a failure (a backoff), and `refused` marks one the server would not take, which waits in Couldn't sync and is not tried again until the person says.
 */
export interface PhotoEntry {
  readonly id: string;
  readonly data: ArrayBuffer;
  readonly type: string;
  readonly size: number;
  readonly queuedAt: number;
  readonly tries: number;
  readonly nextAttempt: number;
  readonly refused?: boolean;
}

/**
 * A trip the account is an active member of, as the server last said it (DESIGN.md §15.1): its **cursor and floor** (the trip's stream), the account's **role** in it, and the small sets, whole (`TripSets`). The items and the shared check-ins
 * are rows of their own (`tripItems`, `tripShared`), past the cursor.
 */
export interface TripEntry {
  readonly id: string;
  readonly role: string;
  readonly cursor: number;
  readonly floor: number;
  readonly head: number;
  readonly sets: TripSets | undefined;
}
export type TripItem = ItemRecord & { readonly tripId: string };
export type TripShared = SharedCheckin & { readonly tripId: string };

export type Meta = { key: 'cursor' | 'head' | 'floor'; value: number };

export interface LocalSchema extends DBSchema {
  places: { key: string; value: PlaceView };
  checkins: { key: string; value: CheckinView; indexes: { at: number } };
  outbox: { key: number; value: OutboxEntry };
  refused: { key: string; value: Refused };
  photos: { key: string; value: PhotoEntry };
  trips: { key: string; value: TripEntry };
  tripItems: { key: string; value: TripItem; indexes: { tripId: string } };
  tripShared: { key: string; value: TripShared; indexes: { tripId: string } };
  meta: { key: string; value: Meta };
}

export type LocalDb = IDBPDatabase<LocalSchema>;

/** Opens the account's database, making it if it is not there. A connection that another tab's delete (at sign-out) is waiting for closes itself. */
export async function openLocal(accountId: string): Promise<LocalDb> {
  if (!isAccountId(accountId)) throw new Error('not an account id');
  const name = dbName(accountId);
  const database = await openDB<LocalSchema>(name, DB_VERSION, {
    upgrade(db, oldVersion) {
      // Version 1: the rows, the outbox, the refused and the cursor. Version 2 (6.5): the photos waiting to be uploaded. A device on an older version gets only what it lacks.
      if (oldVersion < 1) {
        db.createObjectStore('places', { keyPath: 'id' });
        db.createObjectStore('checkins', { keyPath: 'id' }).createIndex('at', 'at');
        db.createObjectStore('outbox', { keyPath: 'n', autoIncrement: true });
        db.createObjectStore('refused', { keyPath: 'mutationId' });
        db.createObjectStore('meta', { keyPath: 'key' });
      }
      if (oldVersion < 2) db.createObjectStore('photos', { keyPath: 'id' });
      // Version 3 (6.6): trips, and the rows of their streams.
      if (oldVersion < 3) {
        db.createObjectStore('trips', { keyPath: 'id' });
        db.createObjectStore('tripItems', { keyPath: 'id' }).createIndex('tripId', 'tripId');
        db.createObjectStore('tripShared', { keyPath: 'id' }).createIndex('tripId', 'tripId');
      }
    },
    blocking() {
      database.close();
    },
    terminated() {
      // The browser closed it (storage cleared): the next use opens it again.
    },
  });
  return database;
}

/** Deletes the account's database. Resolves when it is gone, or at once if there was none. */
export async function deleteLocal(accountId: string): Promise<void> {
  if (!isAccountId(accountId)) return;
  await deleteDB(dbName(accountId));
}
