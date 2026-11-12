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
import { editCheckin } from '../actions/checkins';
import type { CheckinView, PlaceView } from '../actions/types';
import { LIMITS, type Mutation } from '../sync/format';
import { type Refused, deleteLocal, openLocal } from './db';
import { type Loop, browserEnv, startLoop } from './loop';
import { requestPersistence } from './persist';
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
  /**
   * Keeps a photo taken on this device under an id the device makes (or is given, when the check-in that names it was made first), and returns the id, to name in the check-in (`photos`): it is uploaded when there is a network, before or after the check-in,
   * and shown from here meanwhile (`photoSrc`). Refuses, with a sentence, a file that is more than 15 MB: the server would, and the person need not wait to be told.
   */
  addPhoto(
    blob: Blob,
    id?: string,
  ): Promise<{ ok: true; id: string } | { ok: false; sentence: string }>;
  /** Where to show a photo from: the file on this device while it is only here, and the server's otherwise. */
  photoSrc(id: string): Promise<string>;
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
  /** The `blob:` addresses made for photos shown from this device, to give back when the store closes. */
  const urls = useRef(new Map<string, string>());

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
      // What is on this device and not yet sent is only here: ask the browser to keep it (DESIGN.md §15.7). The browser decides, and a refusal is no error.
      void requestPersistence();
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
      for (const url of urls.current.values()) URL.revokeObjectURL(url);
      urls.current.clear();
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
        const entry = (await store.current?.refused())?.find(
          (each) => each.mutationId === mutationId,
        );
        await store.current?.discardRefused(mutationId);
        // A photo that is thrown away is taken out of its check-in too, so that the check-in does not wait for ever for a file that will not come.
        if (entry?.photoId && store.current) {
          const checkin = (await store.current.view()).checkins.find((c) =>
            c.photos?.includes(entry.photoId as string),
          );
          if (checkin) {
            const edit = editCheckin(
              checkin,
              { photos: (checkin.photos ?? []).filter((id) => id !== entry.photoId) },
              {
                ids: { newId: () => crypto.randomUUID() },
                now: Date.now(),
                deviceZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
              },
            );
            if (edit.ok) await store.current.record(edit.mutation);
          }
        }
        await read();
        loop.current?.nudge();
      },
      async addPhoto(blob, given) {
        const current = store.current;
        if (!current) return { ok: false, sentence: 'This browser cannot keep photos.' };
        if (blob.size > LIMITS.fileBytes)
          return { ok: false, sentence: 'That file is larger than 15 MB.' };
        const id = given ?? crypto.randomUUID();
        await current.addPhoto(id, blob);
        loop.current?.nudge();
        return { ok: true, id };
      },
      async photoSrc(id) {
        const blob = await store.current?.photoBlob(id);
        if (!blob) return `/api/media/${encodeURIComponent(id)}`;
        const known = urls.current.get(id);
        if (known) return known;
        const url = URL.createObjectURL(blob);
        urls.current.set(id, url);
        return url;
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
        return current
          ? (await current.pendingCount()) +
              (await current.refused()).length +
              (await current.photoCount())
          : 0;
      },
      async destroy() {
        for (const url of urls.current.values()) URL.revokeObjectURL(url);
        urls.current.clear();
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
