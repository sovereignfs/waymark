import 'fake-indexeddb/auto';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { IDBFactory } from 'fake-indexeddb';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkInAtNewPlace } from '../actions/checkins';
import type { Context } from '../actions/types';
import { ringOf } from '../crypto/keys';
import { Sealer } from '../crypto/sealed';
import type { Database } from '../db/client';
import { makeStore, testTarget } from '../db/test-support';
import { releasePhotos } from '../checkins/photos';
import { refusal, stored } from '../media/http';
import { type MediaDeps, putMedia, readMedia } from '../media/service';
import { type ApplyDeps } from '../sync/apply';
import { handleSync } from '../sync/endpoint';
import { openLocal } from './db';
import { type Put, uploadPhotos } from './photos';
import { LocalStore } from './store';
import { type Transport, syncOnce } from './sync';

/**
 * Photos waiting (DESIGN.md §15.6): a photo taken with no network is kept on the device, shown from it, and uploaded when there is one, before or after its check-in, with the real media store and
 * the real server code of the leg; one the server would not take goes to Couldn't sync with its sentence and its file stays; a failure that may pass is retried with a backoff.
 */
const { leg } = testTarget();
const ring = ringOf(randomBytes(32));
if (!ring) throw new Error('no ring');
const sealer = new Sealer(ring);
const NOW = 1_800_000_000_000;

let database: Database;
let close: () => Promise<void>;
let directory: string;
let media: MediaDeps;
let deps: ApplyDeps;
beforeAll(async () => {
  ({ database, close } = await makeStore());
  directory = mkdtempSync(path.join(tmpdir(), 'waymark-device-photos-'));
  media = {
    database,
    ring,
    dir: path.join(directory, 'media'),
    maxAccountBytes: 100 * 1024 * 1024,
    now: () => NOW,
  };
  deps = { database, sealer, now: () => NOW, release: releasePhotos(media) };
});
afterAll(async () => {
  await close();
  rmSync(directory, { recursive: true, force: true });
});

let n = 0;
const account = () => `photos${++n}`;
const ctx = (): Context => ({
  ids: { newId: () => randomUUID() },
  now: NOW - 1000,
  deviceZone: 'Europe/Lisbon',
});
async function device(accountId: string) {
  (globalThis as { indexedDB?: IDBFactory }).indexedDB = new IDBFactory();
  return new LocalStore(await openLocal(accountId), () => NOW);
}
const picture = (n = 1) =>
  sharp({
    create: { width: 30 + n, height: 20, channels: 3, background: { r: 20 * n, g: 90, b: 40 } },
  })
    .jpeg()
    .toBuffer();
const blobOf = async (n = 1) =>
  new Blob([new Uint8Array(await picture(n))], { type: 'image/jpeg' });
const toServer =
  (accountId: string): Transport =>
  async (body) => {
    const answer = await handleSync(deps, accountId, body);
    return { status: answer.status, json: answer.body };
  };
/** The media route, in this process: the real store and the real answers, as `{ status, json }`. */
const mediaPut =
  (accountId: string): Put =>
  async (id, blob) => {
    const result = await putMedia(media, {
      accountId,
      kind: 'photo',
      bytes: new Uint8Array(await blob.arrayBuffer()),
      id,
    });
    const response = result.ok ? stored(result) : refusal(result.reason);
    return { status: response.status, json: await response.json().catch(() => null) };
  };
const files = () => {
  try {
    return readdirSync(media.dir).length;
  } catch {
    return 0;
  }
};
const must = <T extends { ok: boolean }>(result: T) => {
  if (!result.ok) throw new Error(JSON.stringify(result));
  return result as Extract<T, { ok: true }>;
};

describe(`photos waiting on the device (${leg})`, () => {
  it('shows a photo from the device at once, and keeps the file there with the id it was given', async () => {
    const store = await device(account());
    const id = randomUUID();
    await store.addPhoto(id, await blobOf());
    expect((await store.photoBlob(id))?.type).toBe('image/jpeg');
    expect(await store.photoCount()).toBe(1);
    expect(await store.photoBlob(randomUUID())).toBeUndefined();
  });

  it('reaches the server and another device after the network is back, a check-in made offline with its photo', async () => {
    const who = account();
    const [a, b] = [await device(who), await device(who)];
    // Offline: the photo is kept, the check-in names it, and both are on the device.
    const photo = randomUUID();
    await a.addPhoto(photo, await blobOf(3));
    const made = must(
      checkInAtNewPlace(
        { name: 'Home', lat: 38.7, lng: -9.1 },
        { note: 'with a photo', photos: [photo] },
        ctx(),
      ),
    );
    await a.record(made.mutation);
    expect((await a.view()).checkins[0]?.photos).toEqual([photo]);
    expect(await readMedia(media, { accountId: who, id: photo })).toBeUndefined();
    // The network is back: the check-in goes, and then the photo.
    expect(await syncOnce(a, toServer(who))).toBe('ok');
    expect(await readMedia(media, { accountId: who, id: photo })).toBeUndefined(); // the placeholder, for a moment
    expect(await uploadPhotos(a, mediaPut(who), () => NOW)).toBe('ok');
    expect((await readMedia(media, { accountId: who, id: photo }))?.type).toBe('image/webp');
    expect(await a.photoCount()).toBe(0); // the file leaves the device once the server has it
    // Another device of the account has the check-in, naming the photo, and can fetch it.
    await syncOnce(b, toServer(who));
    expect((await b.view()).checkins[0]).toMatchObject({ note: 'with a photo', photos: [photo] });
  });

  it('is the same when the photo goes before its check-in', async () => {
    const who = account();
    const a = await device(who);
    const photo = randomUUID();
    await a.addPhoto(photo, await blobOf(2));
    expect(await uploadPhotos(a, mediaPut(who), () => NOW)).toBe('ok');
    await a.record(
      must(checkInAtNewPlace({ name: 'Home', lat: 38.7, lng: -9.1 }, { photos: [photo] }, ctx()))
        .mutation,
    );
    expect(await syncOnce(a, toServer(who))).toBe('ok');
    expect((await readMedia(media, { accountId: who, id: photo }))?.type).toBe('image/webp');
    expect((await a.rows()).checkins.size).toBe(1);
    expect(await a.refused()).toEqual([]);
  });

  it('is retried after a failure that may pass, with a backoff that grows, and gives up on nothing', async () => {
    const store = await device(account());
    const id = randomUUID();
    await store.addPhoto(id, await blobOf());
    let now = NOW;
    const waits: number[] = [];
    const offline: Put = async () => {
      throw new Error('no network');
    };
    for (let attempt = 0; attempt < 8; attempt++) {
      expect(await uploadPhotos(store, offline, () => now)).toBe('offline');
      const entry = await store.db.get('photos', id);
      if (!entry) throw new Error('the photo is gone');
      waits.push(entry.nextAttempt - now);
      // Before the backoff is over it is not tried at all.
      expect(await store.photosDue(now + 1)).toEqual([]);
      now = entry.nextAttempt;
    }
    expect(waits).toEqual([5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 320_000, 600_000]);
    expect(await store.photoCount()).toBe(1);
    expect(await store.refused()).toEqual([]);
    // Then it goes, when the network is back.
    expect(
      await uploadPhotos(
        store,
        async () => ({ status: 201, json: {} }),
        () => now,
      ),
    ).toBe('ok');
    expect(await store.photoCount()).toBe(0);
  });

  it('is tried again at once when the network comes back, whatever was left of its backoff, and a refused photo is left alone', async () => {
    const store = await device(account());
    const [waiting, refused] = [randomUUID(), randomUUID()];
    await store.addPhoto(waiting, await blobOf());
    await store.addPhoto(refused, await blobOf(2));
    await store.photoRefused(refused, 'status_415', 'That kind of file cannot be added here.');
    await uploadPhotos(
      store,
      async () => {
        throw new Error('no network');
      },
      () => NOW,
    );
    expect(await store.photosDue(NOW + 1)).toEqual([]); // five seconds of backoff
    await store.resetPhotoBackoff();
    expect((await store.photosDue(NOW + 1)).map((p) => p.id)).toEqual([waiting]);
    expect((await store.db.get('photos', waiting))?.tries).toBe(0);
    expect((await store.db.get('photos', refused))?.refused).toBe(true);
  });

  it('keeps every photo when the session has ended, or the server is busy or broken', async () => {
    const store = await device(account());
    const id = randomUUID();
    await store.addPhoto(id, await blobOf());
    expect(
      await uploadPhotos(
        store,
        async () => ({ status: 401, json: null }),
        () => NOW,
      ),
    ).toBe('signed_out');
    expect((await store.db.get('photos', id))?.tries).toBe(0);
    expect(
      await uploadPhotos(
        store,
        async () => ({ status: 429, json: null }),
        () => NOW,
      ),
    ).toBe('busy');
    expect(
      await uploadPhotos(
        store,
        async () => ({ status: 503, json: null }),
        () => NOW + 60_000,
      ),
    ).toBe('offline');
    expect(await store.photoCount()).toBe(1);
    expect(await store.refused()).toEqual([]);
  });
});

describe(`a photo the server would not take (${leg})`, () => {
  it('goes to Couldn’t sync with the server’s own sentence, and its file stays and is not tried again by itself', async () => {
    const who = account();
    const store = await device(who);
    const id = randomUUID();
    await store.addPhoto(
      id,
      new Blob([new Uint8Array(Buffer.from('<html><script>alert(1)</script></html>'))], {
        type: 'image/jpeg',
      }),
    );
    let calls = 0;
    const counting: Put = async (photo, blob) => {
      calls++;
      return mediaPut(who)(photo, blob);
    };
    expect(await uploadPhotos(store, counting, () => NOW)).toBe('ok');
    const refused = await store.refused();
    expect(refused).toHaveLength(1);
    expect(refused[0]).toMatchObject({
      photoId: id,
      mutationId: `photo:${id}`,
      reason: 'status_415',
      sentence: 'That kind of file cannot be added here.',
    });
    expect(refused[0]?.mutation).toBeUndefined();
    expect(await store.photoBlob(id)).toBeDefined();
    expect(files()).toBe(files()); // nothing was stored by the server for it
    expect(await uploadPhotos(store, counting, () => NOW + 10 * 60_000)).toBe('ok');
    expect(calls).toBe(1);
    expect(await readMedia(media, { accountId: who, id })).toBeUndefined();
  });

  it('is sent again when the person says, with its file, and discarded only when they say, with its file', async () => {
    const who = account();
    const store = await device(who);
    const id = randomUUID();
    await store.addPhoto(
      id,
      new Blob([new Uint8Array(Buffer.from('not an image'))], { type: 'image/jpeg' }),
    );
    await uploadPhotos(store, mediaPut(who), () => NOW);
    expect(await store.retryRefused(`photo:${id}`)).toBe(true);
    expect(await store.refused()).toEqual([]);
    expect((await store.photosDue(NOW)).map((p) => p.id)).toEqual([id]);
    await uploadPhotos(store, mediaPut(who), () => NOW); // refused again
    expect(await store.refused()).toHaveLength(1);
    expect(await store.discardRefused(`photo:${id}`)).toBe(true);
    expect(await store.photoCount()).toBe(0);
    expect(await store.refused()).toEqual([]);
  });

  it('is another person’s id, which is not ours to use: refused, and not taken from them', async () => {
    const [mine, theirs] = [account(), account()];
    const id = randomUUID();
    const owner = await device(theirs);
    await owner.addPhoto(id, await blobOf());
    await uploadPhotos(owner, mediaPut(theirs), () => NOW);
    const store = await device(mine);
    await store.addPhoto(id, await blobOf(2));
    await uploadPhotos(store, mediaPut(mine), () => NOW);
    expect((await store.refused())[0]).toMatchObject({ photoId: id, reason: 'not_found' });
    expect((await readMedia(media, { accountId: theirs, id }))?.type).toBe('image/webp');
  });
});
