import { type DBSchema, type IDBPDatabase, openDB, deleteDB } from 'idb';
import type { CheckinView, PlaceView } from '../actions/types';
import type { Mutation } from '../sync/format';

/**
 * The device's database (DESIGN.md §15.1): **one for each account**, named `waymark-<account id>`, in IndexedDB through `idb`. It holds what the account may see, as the server last said it, and what the
 * person has done since that the server has not heard: the **outbox**. A person's places and check-ins are the rows; screens read **the rows with the outbox laid over them** (`store.ts`), so a change
 * shows at once and goes away by itself if the server refuses it. Plain text, as the screens need it: it is the device's, and is deleted at sign-out (§15.8). Encryption at rest is the server's.
 */
export const DB_VERSION = 1;
export const dbName = (accountId: string): string => `waymark-${accountId}`;

/** An account id as a database name: better-auth's ids are plain, and nothing else is let through, so a name cannot be made to mean another database. */
export const isAccountId = (accountId: string): boolean => /^[A-Za-z0-9_-]{1,128}$/.test(accountId);

export interface OutboxEntry {
  /** The order the changes were made in; made by the database. */
  readonly n?: number;
  readonly mutationId: string;
  readonly mutation: Mutation;
  readonly queuedAt: number;
}

/** A mutation the server refused, kept with the sentence (DESIGN.md §15.5): **never silently dropped**. Fixing and sending it again, or discarding it, is 6.3's. */
export interface Refused {
  readonly mutationId: string;
  readonly mutation: Mutation;
  readonly reason: string;
  readonly sentence: string;
  readonly at: number;
}

export type Meta = { key: 'cursor' | 'head'; value: number };

export interface LocalSchema extends DBSchema {
  places: { key: string; value: PlaceView };
  checkins: { key: string; value: CheckinView; indexes: { at: number } };
  outbox: { key: number; value: OutboxEntry };
  refused: { key: string; value: Refused };
  meta: { key: string; value: Meta };
}

export type LocalDb = IDBPDatabase<LocalSchema>;

/** Opens the account's database, making it if it is not there. A connection that another tab's delete (at sign-out) is waiting for closes itself. */
export async function openLocal(accountId: string): Promise<LocalDb> {
  if (!isAccountId(accountId)) throw new Error('not an account id');
  const name = dbName(accountId);
  const database = await openDB<LocalSchema>(name, DB_VERSION, {
    upgrade(db) {
      db.createObjectStore('places', { keyPath: 'id' });
      db.createObjectStore('checkins', { keyPath: 'id' }).createIndex('at', 'at');
      db.createObjectStore('outbox', { keyPath: 'n', autoIncrement: true });
      db.createObjectStore('refused', { keyPath: 'mutationId' });
      db.createObjectStore('meta', { keyPath: 'key' });
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
