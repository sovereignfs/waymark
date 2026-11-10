'use client';

import {
  type ReactNode,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { CheckinView, PlaceView } from '../actions/types';
import type { Mutation } from '../sync/format';
import { type Refused, deleteLocal, openLocal } from './db';
import { type Loop, browserEnv, startLoop } from './loop';
import { LocalStore } from './store';
import { type SyncState, fetchTransport } from './sync';

/**
 * The device's store and its sync, for the signed-in account (DESIGN.md §15.1): opens `waymark-<account id>`, runs the loop, and gives the screens **what the device holds** (`useLocal`) and the one way
 * to write (`record`, which is the outbox, and never waits). It is made by `SignedInArea`; the offline shell, which has no account yet, makes none, and `useLocal` is then `undefined`.
 */
export interface LocalContext {
  readonly accountId: string;
  /** Whether the store is open and has been read once: before that the lists are empty and should not be taken for "none". */
  readonly ready: boolean;
  readonly places: readonly PlaceView[];
  readonly checkins: readonly CheckinView[];
  readonly state: SyncState | 'starting';
  /** What the server refused, with the reason in a sentence, kept until the person sends it again or discards it (Couldn't sync, §15.5). */
  readonly refused: readonly Refused[];
  /** Puts a refused mutation back to be sent again. */
  retry(mutationId: string): Promise<void>;
  /** Throws a refused mutation away. */
  discard(mutationId: string): Promise<void>;
  /** Records what a person did: it shows at once and is sent when there is a network. */
  record(mutation: Mutation): Promise<void>;
  /** Sends what can be sent now, for sign-out. Says how it ended, or `undefined` when another tab is syncing. */
  syncNow(): Promise<SyncState | undefined>;
  /** What the device holds that the server has not taken: waiting to be sent, and refused (Couldn't sync). */
  unsent(): Promise<number>;
  /** Ends the loop and deletes this account's database from the browser (sign-out, §15.8). */
  destroy(): Promise<void>;
}

const Context = createContext<LocalContext | undefined>(undefined);
export const useLocal = (): LocalContext | undefined => useContext(Context);

export function LocalProvider({ accountId, children }: { accountId: string; children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [rows, setRows] = useState<{ places: PlaceView[]; checkins: CheckinView[] }>({
    places: [],
    checkins: [],
  });
  const [state, setState] = useState<SyncState | 'starting'>('starting');
  const [refused, setRefused] = useState<Refused[]>([]);
  const store = useRef<LocalStore | undefined>(undefined);
  const loop = useRef<Loop | undefined>(undefined);

  const read = useCallback(async () => {
    const current = store.current;
    if (!current) return;
    try {
      setRows(await current.view());
      setRefused(await current.refused());
      setReady(true);
    } catch {
      // The database was closed under us (signed out in another tab): nothing to show.
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      let opened: LocalStore;
      try {
        opened = new LocalStore(await openLocal(accountId));
      } catch {
        // IndexedDB is not there (a private window of an old browser): the app still works online, with nothing kept on the device.
        return;
      }
      if (cancelled) return opened.close();
      store.current = opened;
      await read();
      loop.current = startLoop({
        accountId,
        store: opened,
        transport: fetchTransport,
        env: browserEnv(),
        onChange: () => void read(),
        onState: setState,
      });
    })();
    return () => {
      cancelled = true;
      loop.current?.stop();
      loop.current = undefined;
      store.current?.close();
      store.current = undefined;
    };
  }, [accountId, read]);

  const value = useMemo<LocalContext>(
    () => ({
      accountId,
      ready,
      places: rows.places,
      checkins: rows.checkins,
      state,
      refused,
      async retry(mutationId) {
        await store.current?.retryRefused(mutationId);
        await read();
        loop.current?.nudge();
      },
      async discard(mutationId) {
        await store.current?.discardRefused(mutationId);
        await read();
      },
      async record(mutation) {
        const current = store.current;
        if (!current) throw new Error('the device store is not open');
        await current.record(mutation);
        await read();
        loop.current?.nudge();
      },
      syncNow: async () => (await loop.current?.syncNow()) ?? undefined,
      unsent: async () => {
        const current = store.current;
        return current ? (await current.pendingCount()) + (await current.refused()).length : 0;
      },
      async destroy() {
        loop.current?.stop();
        loop.current = undefined;
        store.current?.close();
        store.current = undefined;
        await deleteLocal(accountId);
      },
    }),
    [accountId, ready, rows, state, refused, read],
  );
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
