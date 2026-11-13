import type { CheckinView, PlaceView } from '../actions/types';
import type { SyncResponse } from '../sync/endpoint';
import type { DayRecord, ItemRecord, TripAsks, TripSets } from '../sync/trip-format';
import type { SharedCheckin } from '../sharing/read';
import type { IDBPTransaction } from 'idb';
import {
  type AnyMutation,
  type LocalDb,
  type LocalSchema,
  type OutboxEntry,
  type PhotoEntry,
  type Refused,
  type TripEntry,
} from './db';
import { overlay, overlayTrip } from './overlay';

/**
 * The device's store (DESIGN.md §15.1, §15.3): the rows, the outbox, the refused, and the cursor, behind the few things the app does with them.
 *
 *  - **`record`** puts a mutation in the outbox, in one transaction, and returns: **recording never waits** for a network, shows no "saving" and asks nothing. What the screens read already has it
 *    (`view`).
 *  - **`settle`** takes what the server answered: in **one transaction** a mutation that was applied, or was a replay, leaves the outbox; one that was refused moves to the refused with its sentence
 *    (a person's work is never thrown away); the rows past the cursor replace the device's and the tombstones delete theirs; and the cursor moves. A transaction that fails changes none of it, so
 *    a device that is stopped half way sends the same outbox again, which the server answers as replays.
 */
type SettleTx = IDBPTransaction<
  LocalSchema,
  ['places', 'checkins', 'outbox', 'refused', 'meta', 'trips', 'tripItems', 'tripShared'],
  'readwrite'
>;

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** What a trip's screens read (`LocalStore.tripView`). */
export interface TripData {
  role: string;
  sets: TripSets | undefined;
  items: ItemRecord[];
  days: DayRecord[];
  shared: SharedCheckin[];
  /** The items this account has marked done, with what is waiting in the outbox. */
  done: Set<string>;
}

export class LocalStore {
  constructor(
    readonly db: LocalDb,
    private readonly now: () => number = Date.now,
  ) {}

  /** Records what a person did, to be sent. */
  async record(mutation: AnyMutation): Promise<void> {
    await this.db.add('outbox', {
      mutationId: mutation.mutationId,
      mutation,
      queuedAt: this.now(),
    });
  }

  /** The mutations waiting to be sent, in the order they were made, at most `limit`. */
  async pending(limit = 50): Promise<OutboxEntry[]> {
    const all = await this.db.getAll('outbox', undefined, limit);
    return all;
  }

  async pendingCount(): Promise<number> {
    return this.db.count('outbox');
  }

  async cursor(): Promise<number> {
    return (await this.db.get('meta', 'cursor'))?.value ?? 0;
  }

  /** The floor of the stream the device last saw: the server gives a fresh snapshot to a device behind it (`sync/history.ts`). */
  async floor(): Promise<number> {
    return (await this.db.get('meta', 'floor'))?.value ?? 0;
  }

  /** What the device holds of each of its trips, to ask for what is past it (DESIGN.md §15.3). A trip it holds nothing of is not named, and is given whole. */
  async tripAsks(): Promise<TripAsks> {
    const asks: Record<string, { cursor: number; floor: number }> = {};
    for (const trip of await this.db.getAll('trips'))
      asks[trip.id] = { cursor: trip.cursor, floor: trip.floor };
    return asks;
  }

  /** The trips the account is in, as the server last said them. */
  async trips(): Promise<TripEntry[]> {
    return (await this.db.getAll('trips')).sort((a, b) => a.id.localeCompare(b.id));
  }

  /**
   * What a trip's screens show (DESIGN.md §15.1): the trip's small sets, its items with the outbox laid over them, its days with their edited words, and the check-ins others have shared with it. Read in **one transaction** for the
   * reason `view` is. `me` is the account, who made what is in the outbox. `undefined` for a trip the device does not hold.
   */
  async tripView(tripId: string, me: string): Promise<TripData | undefined> {
    const tx = this.db.transaction(['trips', 'tripItems', 'tripShared', 'outbox'], 'readonly');
    const [entry, items, shared, outbox] = await Promise.all([
      tx.objectStore('trips').get(tripId),
      tx.objectStore('tripItems').index('tripId').getAll(tripId),
      tx.objectStore('tripShared').index('tripId').getAll(tripId),
      tx.objectStore('outbox').getAll(),
    ]);
    await tx.done;
    if (!entry) return undefined;
    const places = new Map<string, NonNullable<ItemRecord['place']>>();
    for (const stop of entry.sets?.stops ?? []) places.set(stop.place.id, stop.place);
    for (const item of items) if (item.place) places.set(item.place.id, item.place);
    const seen = overlayTrip(
      tripId,
      {
        items: new Map(items.map((row) => [row.id, row])),
        days: new Map((entry.sets?.days ?? []).map((row) => [row.id, row])),
        done: new Set(entry.sets?.done ?? []),
      },
      places,
      outbox.map((each) => each.mutation),
      me,
    );
    return {
      role: entry.role,
      sets: entry.sets,
      items: [...seen.items.values()].sort(
        (a, b) =>
          a.dayId.localeCompare(b.dayId) ||
          compare(a.position, b.position) ||
          a.id.localeCompare(b.id),
      ),
      days: [...seen.days.values()].sort(
        (a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id),
      ),
      done: new Set(seen.done),
      shared: shared.sort((a, b) => b.at - a.at || a.id.localeCompare(b.id)),
    };
  }

  /** The rows as the server last said, with nothing laid over them: for the sync's own use and for tests. */
  async rows(): Promise<{ places: Map<string, PlaceView>; checkins: Map<string, CheckinView> }> {
    const [places, checkins] = await Promise.all([
      this.db.getAll('places'),
      this.db.getAll('checkins'),
    ]);
    return {
      places: new Map(places.map((row) => [row.id, row])),
      checkins: new Map(checkins.map((row) => [row.id, row])),
    };
  }

  /**
   * What the screens show: the rows with the outbox laid over them. **Read in one transaction**: a sync settling between two reads would leave a mutation out of the outbox (applied) and its rows not yet in the
   * rows the other read saw, and a check-in, or the place it was made at, would vanish from the screen for a moment (and from a search that was typed in that moment).
   */
  async view(): Promise<{ places: PlaceView[]; checkins: CheckinView[] }> {
    const tx = this.db.transaction(['places', 'checkins', 'outbox'], 'readonly');
    const [places, checkins, outbox] = await Promise.all([
      tx.objectStore('places').getAll(),
      tx.objectStore('checkins').getAll(),
      tx.objectStore('outbox').getAll(),
    ]);
    await tx.done;
    const seen = overlay(
      {
        places: new Map(places.map((row) => [row.id, row])),
        checkins: new Map(checkins.map((row) => [row.id, row])),
      },
      outbox.map((entry) => entry.mutation),
    );
    return {
      places: [...seen.places.values()].sort((a, b) => a.name.localeCompare(b.name)),
      // Newest first, as the timeline reads; the same moment by id, so the order is the same on every device.
      checkins: [...seen.checkins.values()].sort((a, b) => b.at - a.at || a.id.localeCompare(b.id)),
    };
  }

  async refused(): Promise<Refused[]> {
    const all = await this.db.getAll('refused');
    // The oldest first: the order they were refused in.
    return all.sort((a, b) => a.at - b.at || a.mutationId.localeCompare(b.mutationId));
  }

  /**
   * Puts a refused mutation back in the outbox, to be sent again (DESIGN.md §15.5): **in one transaction**, so it is never in neither. It goes to the end, with the id it had: the server rolled the refusal
   * back with everything else, so the id was not spent. Returns whether there was one.
   */
  async retryRefused(mutationId: string): Promise<boolean> {
    const tx = this.db.transaction(['refused', 'outbox', 'photos'], 'readwrite');
    const refused = await tx.objectStore('refused').get(mutationId);
    if (!refused) {
      await tx.done;
      return false;
    }
    if (refused.photoId !== undefined) {
      // A photo goes back to be uploaded, at once: its file is still here.
      const photo = await tx.objectStore('photos').get(refused.photoId);
      if (photo)
        await tx.objectStore('photos').put({ ...photo, refused: false, tries: 0, nextAttempt: 0 });
    } else if (refused.mutation) {
      await tx
        .objectStore('outbox')
        .add({ mutationId, mutation: refused.mutation, queuedAt: this.now() });
    }
    await tx.objectStore('refused').delete(mutationId);
    await tx.done;
    return true;
  }

  /** Throws a refused change away, which only the person decides (§15.5); a photo's file goes with it. Returns whether there was one. */
  async discardRefused(mutationId: string): Promise<boolean> {
    const tx = this.db.transaction(['refused', 'photos'], 'readwrite');
    const refused = await tx.objectStore('refused').get(mutationId);
    if (refused?.photoId !== undefined) await tx.objectStore('photos').delete(refused.photoId);
    await tx.objectStore('refused').delete(mutationId);
    await tx.done;
    return refused !== undefined;
  }

  /** Keeps a photo taken on this device, under the id the device made for it, until the server has it. */
  async addPhoto(id: string, blob: Blob): Promise<void> {
    await this.db.put('photos', {
      id,
      data: await blob.arrayBuffer(),
      type: blob.type,
      size: blob.size,
      queuedAt: this.now(),
      tries: 0,
      nextAttempt: 0,
    });
  }

  /** A photo's file if it is still on this device (not uploaded yet, or refused), to show it from here. */
  async photoBlob(id: string): Promise<Blob | undefined> {
    const photo = await this.db.get('photos', id);
    return photo ? new Blob([photo.data], { type: photo.type }) : undefined;
  }

  /** The photos that are due to be uploaded: not refused, and past their backoff. Oldest first. */
  async photosDue(now: number): Promise<PhotoEntry[]> {
    const all = await this.db.getAll('photos');
    return all
      .filter((photo) => !photo.refused && photo.nextAttempt <= now)
      .sort((a, b) => a.queuedAt - b.queuedAt || a.id.localeCompare(b.id));
  }

  /** How many photos are on this device only: waiting to be uploaded, or refused. */
  async photoCount(): Promise<number> {
    return this.db.count('photos');
  }

  /** The server has the photo: the file goes from here. */
  async photoUploaded(id: string): Promise<void> {
    await this.db.delete('photos', id);
  }

  /** The upload failed for a reason that may pass (no network, a busy or broken server): try again after a backoff that grows with the tries, and stops growing at ten minutes. */
  async photoFailed(id: string, now: number): Promise<void> {
    const photo = await this.db.get('photos', id);
    if (!photo) return;
    const wait = Math.min(5_000 * 2 ** photo.tries, 10 * 60_000);
    await this.db.put('photos', { ...photo, tries: photo.tries + 1, nextAttempt: now + wait });
  }

  /** The network is back (or the person asked): every photo waiting for its backoff to end is tried at once, and the backoff starts again from the beginning. A refused photo is left alone. */
  async resetPhotoBackoff(): Promise<void> {
    const tx = this.db.transaction('photos', 'readwrite');
    for (const photo of await tx.store.getAll())
      if (!photo.refused && (photo.tries > 0 || photo.nextAttempt > 0))
        await tx.store.put({ ...photo, tries: 0, nextAttempt: 0 });
    await tx.done;
  }

  /** The server would not take the photo (too large, not an image, over the person's room): it goes to Couldn't sync with the reason, and its file stays until the person decides. */
  async photoRefused(id: string, reason: string, sentence: string): Promise<void> {
    const tx = this.db.transaction(['photos', 'refused'], 'readwrite');
    const photo = await tx.objectStore('photos').get(id);
    if (photo) await tx.objectStore('photos').put({ ...photo, refused: true });
    await tx
      .objectStore('refused')
      .put({ mutationId: `photo:${id}`, photoId: id, reason, sentence, at: this.now() });
    await tx.done;
  }

  /**
   * Takes the server's answer to `sent` (the outbox entries the request carried, in order) and its page. All of it, or none: one transaction. The results are matched to the entries by mutation id,
   * so an answer for something no longer in the outbox (another tab settled it first) is ignored.
   */
  async settle(sent: readonly OutboxEntry[], response: SyncResponse): Promise<void> {
    const tx = this.db.transaction(
      ['places', 'checkins', 'outbox', 'refused', 'meta', 'trips', 'tripItems', 'tripShared'],
      'readwrite',
    );
    const byId = new Map(sent.map((entry) => [entry.mutationId, entry]));
    for (const result of response.results) {
      const entry = byId.get(result.mutationId);
      if (!entry || entry.n === undefined) continue;
      if (result.status === 'refused')
        await tx.objectStore('refused').put({
          mutationId: entry.mutationId,
          mutation: entry.mutation,
          reason: result.reason,
          sentence: result.sentence,
          at: this.now(),
        });
      await tx.objectStore('outbox').delete(entry.n);
    }
    const page = response.account;
    // A fresh snapshot (§15.8): the device had not heard of the stream since before deletes were pruned, so what it holds may include rows that no longer exist. They go first; the page, and those after
    // it, bring back every row there is, and what is waiting in the outbox is laid over them as always.
    if (page.reset) {
      await tx.objectStore('places').clear();
      await tx.objectStore('checkins').clear();
    }
    for (const place of page.places) await tx.objectStore('places').put(place);
    for (const checkin of page.checkins) await tx.objectStore('checkins').put(checkin);
    for (const gone of page.deleted)
      await tx.objectStore(gone.table === 'place' ? 'places' : 'checkins').delete(gone.id);
    await tx.objectStore('meta').put({ key: 'cursor', value: page.cursor });
    await tx.objectStore('meta').put({ key: 'head', value: page.head });
    await tx.objectStore('meta').put({ key: 'floor', value: page.floor });

    // The trips (6.6): one stream each. A trip the account is not in any more is deleted from here with everything of it.
    for (const tripId of response.gone) await this.forgetTrip(tx, tripId);
    for (const trip of response.trips) {
      const before = await tx.objectStore('trips').get(trip.tripId);
      // Behind the floor: what the device holds of this trip's rows may include ones that no longer exist; the page brings back every one there is.
      if (trip.reset || !before) await this.clearTripRows(tx, trip.tripId);
      let sets = trip.sets ?? before?.sets;
      // A Follower is never given an attachment: one that a device learns it may no longer see goes.
      if (trip.role === 'follower' && sets?.attachments) {
        const { attachments: _gone, ...rest } = sets;
        sets = rest;
      }
      await tx.objectStore('trips').put({
        id: trip.tripId,
        role: trip.role,
        cursor: trip.cursor,
        floor: trip.floor,
        head: trip.head,
        sets,
      });
      for (const item of trip.items)
        await tx.objectStore('tripItems').put({ ...item, tripId: trip.tripId });
      for (const copy of trip.shared)
        await tx.objectStore('tripShared').put({ ...copy, tripId: trip.tripId });
      for (const gone of trip.deleted)
        await tx.objectStore(gone.table === 'item' ? 'tripItems' : 'tripShared').delete(gone.id);
    }
    await tx.done;
  }

  private async clearTripRows(tx: SettleTx, tripId: string): Promise<void> {
    for (const name of ['tripItems', 'tripShared'] as const) {
      const store = tx.objectStore(name);
      for (const key of await store.index('tripId').getAllKeys(tripId)) await store.delete(key);
    }
  }

  private async forgetTrip(tx: SettleTx, tripId: string): Promise<void> {
    await this.clearTripRows(tx, tripId);
    await tx.objectStore('trips').delete(tripId);
  }

  close(): void {
    this.db.close();
  }
}
