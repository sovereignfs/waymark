import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ringOf } from '../crypto/keys';
import { Sealer } from '../crypto/sealed';
import type { Database } from '../db/client';
import { dbAll, dbGet, dbRun } from '../db/exec';
import { makeStore, testTarget } from '../db/test-support';
import { type MediaDeps, putMedia, readMedia } from '../media/service';
import { type ApplyDeps, applyMutation } from '../sync/apply';
import { releasePhotos, sweepUnattachedPhotos, UNATTACHED_GRACE_MS } from './photos';

/**
 * Photos on check-ins (DESIGN.md §9.3, §15.6): the ids the device made, in order, a photo that may arrive after its check-in, and files that go when a photo leaves a check-in or the
 * check-in is deleted. Against whichever database the leg runs on, with real files in a directory of the test's own.
 */
const { leg } = testTarget();
const ring = ringOf(randomBytes(32));
if (!ring) throw new Error('no ring');
const sealer = new Sealer(ring);
const ADA = 'ada-photos';
const GRACE = 'grace-photos';
const NOW = 1_800_000_000_000;

let database: Database;
let close: () => Promise<void>;
let directory: string;
let media: MediaDeps;
let deps: ApplyDeps;
const tbl = (name: string) => sql.raw(database.dialect === 'postgres' ? `waymark.${name}` : name);

beforeAll(async () => {
  ({ database, close } = await makeStore());
  directory = mkdtempSync(path.join(tmpdir(), 'waymark-photos-'));
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

const picture = (n: number) =>
  sharp({
    create: { width: 30 + n, height: 20, channels: 3, background: { r: 20 * n, g: 90, b: 40 } },
  })
    .jpeg()
    .toBuffer();
const upload = async (accountId: string, id = randomUUID(), n = 1) => {
  const result = await putMedia(media, { accountId, kind: 'photo', bytes: await picture(n), id });
  if (!result.ok) throw new Error(`could not seed a photo: ${result.reason}`);
  return id;
};
const files = () => {
  try {
    return readdirSync(media.dir).length;
  } catch {
    return 0;
  }
};
const PLACE = {
  name: 'Café',
  lat: 48.854,
  lng: 2.3326,
  source: 'manual',
  tz: 'Europe/Paris',
  countryCode: null,
};
let n = 0;
const uid = (what: string) => `${what}-${++n}`;
const row = (placeId: string, photos?: string[]) => ({
  placeId,
  at: NOW - 60_000,
  tz: 'Europe/Paris',
  offsetMin: 120,
  companions: [],
  tripId: null,
  linkSource: null,
  share: 'trip',
  source: 'live',
  ...(photos ? { photos } : {}),
});
const mutation = (changes: unknown[]) => ({ mutationId: uid('m'), stream: 'account', changes });
const putPlace = (id: string) => ({ table: 'place', op: 'put', id, row: PLACE });
const putCheckin = (id: string, placeId: string, photos?: string[]) => ({
  table: 'checkin',
  op: 'put',
  id,
  row: row(placeId, photos),
});
const photosOf = async (checkinId: string) =>
  (
    await dbAll<{ id: string }>(
      database,
      sql`SELECT id FROM ${tbl('checkin_photo')} WHERE checkin_id = ${checkinId} ORDER BY position`,
    )
  ).map((r) => r.id);

describe(`photos on a check-in (${leg})`, () => {
  it('round-trips three photos, in order, each readable by its owner', async () => {
    const place = uid('place');
    const checkin = uid('checkin');
    const ids = [
      await upload(ADA, randomUUID(), 1),
      await upload(ADA, randomUUID(), 2),
      await upload(ADA, randomUUID(), 3),
    ];
    const result = await applyMutation(
      deps,
      ADA,
      mutation([putPlace(place), putCheckin(checkin, place, ids)]),
    );
    expect(result).toMatchObject({ status: 'applied', released: [] });
    expect(await photosOf(checkin)).toEqual(ids);
    for (const id of ids)
      expect((await readMedia(media, { accountId: ADA, id }))?.type).toBe('image/webp');
    // Another person cannot read any of them.
    for (const id of ids) expect(await readMedia(media, { accountId: GRACE, id })).toBeUndefined();
  });

  it('is reordered and a photo taken away by sending the list again, and the file of the one taken away goes, with its thumbnail', async () => {
    const place = uid('place');
    const checkin = uid('checkin');
    const [a, b, c] = [await upload(ADA), await upload(ADA), await upload(ADA)];
    await applyMutation(
      deps,
      ADA,
      mutation([putPlace(place), putCheckin(checkin, place, [a, b, c])]),
    );
    const filesBefore = files();
    await applyMutation(deps, ADA, mutation([putCheckin(checkin, place, [c, a])]));
    expect(await photosOf(checkin)).toEqual([c, a]);
    expect(await readMedia(media, { accountId: ADA, id: b })).toBeUndefined();
    expect(files()).toBe(filesBefore - 2); // the photo and its thumbnail
    expect((await readMedia(media, { accountId: ADA, id: a }))?.type).toBe('image/webp');
  });

  it('leaves no file on disk when the check-in is deleted', async () => {
    const place = uid('place');
    const checkin = uid('checkin');
    const ids = [await upload(ADA), await upload(ADA)];
    const filesBefore = files();
    await applyMutation(deps, ADA, mutation([putPlace(place), putCheckin(checkin, place, ids)]));
    const gone = await applyMutation(
      deps,
      ADA,
      mutation([{ table: 'checkin', op: 'delete', id: checkin }]),
    );
    expect(gone).toMatchObject({ status: 'applied', released: expect.arrayContaining(ids) });
    expect(files()).toBe(filesBefore - 4);
    for (const id of ids) expect(await readMedia(media, { accountId: ADA, id })).toBeUndefined();
    expect(await photosOf(checkin)).toEqual([]);
    const left = await dbGet<{ n: number | string }>(
      database,
      sql`SELECT COUNT(*) AS n FROM ${tbl('media')} WHERE id IN (${ids[0]}, ${ids[1]})`,
    );
    expect(Number(left?.n)).toBe(0);
  });

  it('is accepted before its file has arrived, and attaches when the file does', async () => {
    const place = uid('place');
    const checkin = uid('checkin');
    const early = randomUUID();
    const result = await applyMutation(
      deps,
      ADA,
      mutation([putPlace(place), putCheckin(checkin, place, [early])]),
    );
    expect(result.status).toBe('applied');
    expect(await photosOf(checkin)).toEqual([early]);
    // The placeholder: nothing to read yet.
    expect(await readMedia(media, { accountId: ADA, id: early })).toBeUndefined();
    await upload(ADA, early);
    expect((await readMedia(media, { accountId: ADA, id: early }))?.type).toBe('image/webp');
    expect(await photosOf(checkin)).toEqual([early]);
  });

  it('is refused for a photo that is another person’s file, or is on another person’s check-in, with nothing kept', async () => {
    const graces = await upload(GRACE);
    const place = uid('place');
    const refused = await applyMutation(
      deps,
      ADA,
      mutation([putPlace(place), putCheckin(uid('c'), place, [graces])]),
    );
    expect(refused).toMatchObject({ status: 'refused', reason: 'photos' });
    expect(
      await dbGet(database, sql`SELECT id FROM ${tbl('place')} WHERE id = ${place}`),
    ).toBeUndefined();
    // On another person's check-in, though the file does not exist yet.
    const gplace = uid('place');
    const gcheckin = uid('checkin');
    const shared = randomUUID();
    await applyMutation(
      deps,
      GRACE,
      mutation([putPlace(gplace), putCheckin(gcheckin, gplace, [shared])]),
    );
    const aplace = uid('place');
    const refusedToo = await applyMutation(
      deps,
      ADA,
      mutation([putPlace(aplace), putCheckin(uid('c'), aplace, [shared])]),
    );
    expect(refusedToo).toMatchObject({ status: 'refused', reason: 'photos' });
    expect(await photosOf(gcheckin)).toEqual([shared]);
  });

  it('is more than ten, or no UUID, or twice: refused with a sentence', async () => {
    const place = uid('place');
    const many = Array.from({ length: 11 }, () => randomUUID());
    for (const photos of [many, ['not-a-uuid'], [many[0] as string, many[0] as string]])
      expect(
        await applyMutation(
          deps,
          ADA,
          mutation([putPlace(place), putCheckin(uid('c'), place, photos)]),
        ),
      ).toMatchObject({
        status: 'refused',
        reason: 'photos',
      });
  });

  it('is not undone by a file that could not be removed: the mutation stands and the sweep has the file', async () => {
    const place = uid('place');
    const checkin = uid('checkin');
    const photo = await upload(ADA);
    const failing: ApplyDeps = {
      ...deps,
      release: async () => {
        throw new Error('disk gone');
      },
    };
    await applyMutation(
      failing,
      ADA,
      mutation([putPlace(place), putCheckin(checkin, place, [photo])]),
    );
    const result = await applyMutation(
      failing,
      ADA,
      mutation([{ table: 'checkin', op: 'delete', id: checkin }]),
    );
    expect(result).toMatchObject({ status: 'applied', released: [photo] });
    expect(await photosOf(checkin)).toEqual([]);
    // The file is still there, with no check-in naming it: the sweep takes it once the wait is over.
    expect((await readMedia(media, { accountId: ADA, id: photo }))?.type).toBe('image/webp');
    const later = { ...media, now: () => NOW + UNATTACHED_GRACE_MS + 10 * 86_400_000 };
    expect(await sweepUnattachedPhotos(later)).toBeGreaterThanOrEqual(1);
    expect(await readMedia(media, { accountId: ADA, id: photo })).toBeUndefined();
  });
});

describe(`photos that no check-in names (${leg})`, () => {
  it('are swept after a long wait, with their thumbnails, and photos that are attached or recent stay', async () => {
    const place = uid('place');
    const attached = await upload(ADA);
    await applyMutation(
      deps,
      ADA,
      mutation([putPlace(place), putCheckin(uid('c'), place, [attached])]),
    );
    const recent = await upload(ADA);
    const old = await upload(ADA);
    // `old` was uploaded a long time ago, and nothing ever named it.
    await dbRun(
      database,
      sql`UPDATE ${tbl('media')} SET created_at = ${NOW - UNATTACHED_GRACE_MS - 1000} WHERE id = ${old}`,
    );
    await dbRun(
      database,
      sql`UPDATE ${tbl('media')} SET created_at = ${NOW - UNATTACHED_GRACE_MS - 1000} WHERE id = ${attached}`,
    );
    expect(await sweepUnattachedPhotos(media)).toBe(1);
    expect(await readMedia(media, { accountId: ADA, id: old })).toBeUndefined();
    expect((await readMedia(media, { accountId: ADA, id: attached }))?.type).toBe('image/webp');
    expect((await readMedia(media, { accountId: ADA, id: recent }))?.type).toBe('image/webp');
    expect(await sweepUnattachedPhotos(media)).toBe(0);
  });
});
