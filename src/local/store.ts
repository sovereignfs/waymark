import type { CheckinView, PlaceView } from '../actions/types';
import type { Mutation } from '../sync/format';
import type { SyncResponse } from '../sync/endpoint';
import { type LocalDb, type OutboxEntry, type PhotoEntry, type Refused } from './db';
import { overlay } from './overlay';

/**
 * The device's store (DESIGN.md §15.1, §15.3): the rows, the outbox, the refused, and the cursor, behind the few things the app does with them.
 *
 *  - **`record`** puts a mutation in the outbox, in one transaction, and returns: **recording never waits** for a network, shows no "saving" and asks nothing. What the screens read already has it
 *    (`view`).
 *  - **`settle`** takes what the server answered: in **one transaction** a mutation that was applied, or was a replay, leaves the outbox; one that was refused moves to the refused with its sentence
 *    (a person's work is never thrown away); the rows past the cursor replace the device's and the tombstones delete theirs; and the cursor moves. A transaction that fails changes none of it, so
 *    a device that is stopped half way sends the same outbox again, which the server answers as replays.
 */
export class LocalStore {
  constructor(
    readonly db: LocalDb,
    private readonly now: () => number = Date.now,
  ) {}

  /** Records what a person did, to be sent. */
  async record(mutation: Mutation): Promise<void> {
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

  /** What the screens show: the rows with the outbox laid over them. */
  async view(): Promise<{ places: PlaceView[]; checkins: CheckinView[] }> {
    const [rows, outbox] = await Promise.all([this.rows(), this.db.getAll('outbox')]);
    const seen = overlay(
      rows,
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
      ['places', 'checkins', 'outbox', 'refused', 'meta'],
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
    for (const place of page.places) await tx.objectStore('places').put(place);
    for (const checkin of page.checkins) await tx.objectStore('checkins').put(checkin);
    for (const gone of page.deleted)
      await tx.objectStore(gone.table === 'place' ? 'places' : 'checkins').delete(gone.id);
    await tx.objectStore('meta').put({ key: 'cursor', value: page.cursor });
    await tx.objectStore('meta').put({ key: 'head', value: page.head });
    await tx.done;
  }

  close(): void {
    this.db.close();
  }
}
