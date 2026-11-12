import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { unzipSync } from 'fflate';
import sharp from 'sharp';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { type KeyRing, ringOf } from '../crypto/keys';
import { Sealer } from '../crypto/sealed';
import type { Database } from '../db/client';
import { dbAll } from '../db/exec';
import { makeStore, testTarget } from '../db/test-support';
import { hasImport } from '../import/files';
import { putMedia, readMedia } from '../media/service';
import { setPref } from '../notices/prefs';
import { createProfile } from '../profile/profile';
import { applyMutation } from '../sync/apply';
import {
  type ExportDeps,
  READY_FOR_MS,
  deleteExport,
  deleteExportsOf,
  listExportsOf,
  openExport,
  requestExport,
  sweepExports,
  workOnExports,
} from './export';
import { JSON_NAME, parseExport } from './format';

/** Export (DESIGN.md §22), on whichever database the leg runs on: every place, check-in and photo of the person, in a ZIP whose JSON the format accepts, sealed on disk, and no one else's. */
const { leg } = testTarget();
const made = ringOf(randomBytes(32));
if (!made) throw new Error('no ring');
const ring: KeyRing = made;
const sealer = new Sealer(ring);
const ADA = 'ada-account';
const GRACE = 'grace-account';
let NOW = 1_800_000_000_000;

let database: Database;
let close: () => Promise<void>;
let directory: string;
let deps: ExportDeps;
beforeAll(async () => {
  ({ database, close } = await makeStore());
  directory = mkdtempSync(path.join(tmpdir(), 'waymark-export-'));
  deps = {
    database,
    sealer,
    ring,
    dir: path.join(directory, 'exports'),
    media: {
      database,
      ring,
      dir: path.join(directory, 'media'),
      maxAccountBytes: 100 * 1024 * 1024,
      now: () => NOW,
    },
    now: () => NOW,
  };
});
afterAll(async () => {
  await close();
  rmSync(directory, { recursive: true, force: true });
});
beforeEach(async () => {
  NOW += 1000;
  await dbAll(database, sql`DELETE FROM ${named('export_job')} RETURNING id`);
  rmSync(deps.dir, { recursive: true, force: true });
});

const named = (name: string) => sql.raw(database.dialect === 'postgres' ? `waymark.${name}` : name);
const picture = (color: number) =>
  sharp({ create: { width: 40, height: 30, channels: 3, background: { r: color, g: 90, b: 40 } } })
    .jpeg()
    .toBuffer();
let n = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;

/** Ada: three places, five check-ins, three photos (one not uploaded yet); Grace: one of each. Both have a profile with an address. */
async function seed() {
  for (const [id, name, email] of [
    [ADA, 'Ada Lovelace', 'ada.private@example.com'],
    [GRACE, 'Grace Hopper', 'grace.private@example.com'],
  ] as const)
    await createProfile(database, sealer, { accountId: id, name, email }, NOW);
  await setPref(database, ADA, 'import_finished', 'email', false, NOW);
  const photos = [uuid(), uuid(), uuid()];
  const gracePhoto = uuid();
  for (const [who, id, bytes] of [
    [ADA, photos[0] as string, await picture(10)],
    [ADA, photos[1] as string, await picture(60)],
    [GRACE, gracePhoto, await picture(200)],
  ] as const) {
    const stored = await putMedia(deps.media, { accountId: who, kind: 'photo', id, bytes });
    expect(stored.ok).toBe(true);
  }
  // photos[2] is named by a check-in and never uploaded.
  const place = (name: string, lat: number) => ({
    name,
    lat,
    lng: -9.1,
    source: 'manual',
    tz: 'Europe/Lisbon',
    countryCode: 'PT',
  });
  const row = (placeId: string, i: number, extra: Record<string, unknown> = {}) => ({
    placeId,
    at: NOW - (i + 1) * 3_600_000,
    tz: 'Europe/Lisbon',
    offsetMin: 0,
    companions: [],
    tripId: null,
    linkSource: null,
    share: 'trip',
    source: 'live',
    ...extra,
  });
  const apply = async (who: string, changes: unknown[]) =>
    expect(
      (await applyMutation(deps, who, { mutationId: uuid(), stream: 'account', changes })).status,
    ).toBe('applied');
  await apply(ADA, [
    { table: 'place', op: 'put', id: 'ada-p1', row: place('Zxqv Cafe', 38.7) },
    { table: 'place', op: 'put', id: 'ada-p2', row: place('Ada Museum', 38.8) },
    { table: 'place', op: 'put', id: 'ada-p3', row: place('Ada Park', 38.9) },
    {
      table: 'checkin',
      op: 'put',
      id: 'ada-c1',
      row: row('ada-p1', 0, { note: 'First!', companions: ['Grace', 'Alan'], photos: [photos[0]] }),
    },
    {
      table: 'checkin',
      op: 'put',
      id: 'ada-c2',
      row: row('ada-p1', 1, { photos: [photos[1], photos[2]] }),
    },
    { table: 'checkin', op: 'put', id: 'ada-c3', row: row('ada-p2', 2) },
    { table: 'checkin', op: 'put', id: 'ada-c4', row: row('ada-p2', 3, { note: 'Rainy' }) },
    { table: 'checkin', op: 'put', id: 'ada-c5', row: row('ada-p3', 4) },
  ]);
  await apply(GRACE, [
    { table: 'place', op: 'put', id: 'grace-p1', row: place('Grace Secret Place', 40.0) },
    {
      table: 'checkin',
      op: 'put',
      id: 'grace-c1',
      row: row('grace-p1', 0, { note: 'Grace private', photos: [gracePhoto] }),
    },
  ]);
  return { photos, gracePhoto };
}

/** The whole ZIP of an export, read back chunk by chunk from its sealed file. */
async function download(who: string, id: string): Promise<Buffer | undefined> {
  const file = await openExport(deps, who, id);
  if (!file) return undefined;
  const chunks: Buffer[] = [];
  for await (const chunk of file.stream) chunks.push(chunk);
  const all = Buffer.concat(chunks);
  expect(all.length).toBe(file.bytes);
  return all;
}

describe(`an export (${leg})`, () => {
  it('holds every place, check-in and photo of the person, in a ZIP whose JSON the format accepts', async () => {
    const { photos } = await seed();
    const asked = await requestExport(deps, ADA);
    if (!asked.ok) throw new Error('refused');
    expect(await workOnExports(deps)).toBe(true);
    expect(await workOnExports(deps)).toBe(false);
    const [view] = await listExportsOf(deps, ADA);
    expect(view).toMatchObject({ id: asked.id, status: 'ready', expiresAt: NOW + READY_FOR_MS });

    const zip = unzipSync(new Uint8Array((await download(ADA, asked.id)) as Buffer));
    expect(Object.keys(zip).sort()).toEqual(
      [JSON_NAME, `photos/${photos[0]}.webp`, `photos/${photos[1]}.webp`].sort(),
    );
    const parsed = parseExport(
      JSON.parse(Buffer.from(zip[JSON_NAME] as Uint8Array).toString('utf8')),
      NOW + 1,
    );
    if (!parsed.ok) throw new Error(parsed.sentence);
    const file = parsed.value;
    expect(file.profile).toEqual({
      name: 'Ada Lovelace',
      units: 'km',
      weekStart: 1,
      shareDefault: 'ask',
    });
    expect(file.settings.email).toEqual({ import_finished: false });
    expect(file.places.map((p) => p.id).sort()).toEqual(['ada-p1', 'ada-p2', 'ada-p3']);
    expect(file.checkins.map((c) => c.id).sort()).toEqual([
      'ada-c1',
      'ada-c2',
      'ada-c3',
      'ada-c4',
      'ada-c5',
    ]);
    expect(file.checkins.find((c) => c.id === 'ada-c1')).toMatchObject({
      note: 'First!',
      companions: ['Grace', 'Alan'],
      placeId: 'ada-p1',
      tz: 'Europe/Lisbon',
      photos: [photos[0]],
    });
    // The photo that never uploaded is named by its check-in and not in the file's list; the two that did are, and are the bytes the server holds.
    expect(file.checkins.find((c) => c.id === 'ada-c2')?.photos).toEqual([photos[1], photos[2]]);
    expect(file.photos.map((p) => p.id).sort()).toEqual([photos[0], photos[1]].sort());
    for (const photo of file.photos) {
      const stored = await readMedia(deps.media, { accountId: ADA, id: photo.id });
      expect(Buffer.from(zip[photo.file] as Uint8Array).equals(stored?.bytes as Buffer)).toBe(true);
    }
  });

  it('holds nothing of anyone else, and no address: not the person’s own, not another’s, not Grace’s places, notes or photo', async () => {
    const { gracePhoto } = await seed();
    const asked = await requestExport(deps, ADA);
    if (!asked.ok) throw new Error('refused');
    await workOnExports(deps);
    const zip = unzipSync(new Uint8Array((await download(ADA, asked.id)) as Buffer));
    const everything = Object.values(zip)
      .map((bytes) => Buffer.from(bytes).toString('latin1'))
      .join('\n');
    for (const forbidden of [
      'ada.private@example.com',
      'grace.private@example.com',
      'Grace Hopper',
      'Grace Secret Place',
      'Grace private',
      'grace-c1',
      'grace-p1',
      gracePhoto,
    ])
      expect(everything, forbidden).not.toContain(forbidden);
    expect(Object.keys(zip).some((name) => name.includes(gracePhoto))).toBe(false);
    // And Grace’s own export holds her things and none of Ada’s.
    const hers = await requestExport(deps, GRACE);
    if (!hers.ok) throw new Error('refused');
    await workOnExports(deps);
    const herZip = unzipSync(new Uint8Array((await download(GRACE, hers.id)) as Buffer));
    const text = Buffer.from(herZip[JSON_NAME] as Uint8Array).toString('utf8');
    expect(text).toContain('Grace Secret Place');
    expect(text).not.toContain('Zxqv Cafe');
    expect(text).not.toContain('grace.private@example.com');
  });

  it('is sealed on disk: the file is unreadable, and not a ZIP, without the instance key', async () => {
    await seed();
    const asked = await requestExport(deps, ADA);
    if (!asked.ok) throw new Error('refused');
    await workOnExports(deps);
    const raw = readFileSync(path.join(deps.dir, asked.id));
    expect(raw.includes(Buffer.from('waymark-export'))).toBe(false);
    expect(raw.includes(Buffer.from('Zxqv'))).toBe(false);
    expect(raw.subarray(0, 4).toString('latin1')).not.toBe('PK\u0003\u0004');
  });

  it('is one at a time for a person, and another person is not held up', async () => {
    await seed();
    const first = await requestExport(deps, ADA);
    expect(first.ok).toBe(true);
    expect(await requestExport(deps, ADA)).toEqual({ ok: false, reason: 'busy' });
    expect((await requestExport(deps, GRACE)).ok).toBe(true);
  });

  it('is two workers’ at once, built once', async () => {
    await seed();
    const asked = await requestExport(deps, ADA);
    if (!asked.ok) throw new Error('refused');
    const ran = await Promise.all([workOnExports(deps), workOnExports(deps)]);
    expect(ran.filter(Boolean)).toHaveLength(1);
    expect((await listExportsOf(deps, ADA))[0]?.status).toBe('ready');
  });
});

describe(`a line on the activity page at a core (${leg})`, () => {
  it('is queued when the export is ready, if the people here sign in through a core, and not otherwise', async () => {
    await seed();
    const rows = async () =>
      Number(
        (
          await dbAll<{ n: number | string }>(
            database,
            sql`SELECT COUNT(*) AS n FROM ${named('core_outbox')} WHERE account_id = ${ADA}`,
          )
        )[0]?.n,
      );
    const before = await rows();
    expect((await requestExport(deps, ADA)).ok).toBe(true);
    await workOnExports(deps);
    expect(await rows()).toBe(before);
    await dbAll(database, sql`DELETE FROM ${named('export_job')} RETURNING id`);
    expect((await requestExport(deps, ADA)).ok).toBe(true);
    await workOnExports({ ...deps, core: true });
    expect(await rows()).toBe(before + 1);
  });
});

describe(`who may have it, and for how long (${leg})`, () => {
  it('is the owner’s alone, only while ready, and only within the day', async () => {
    await seed();
    const asked = await requestExport(deps, ADA);
    if (!asked.ok) throw new Error('refused');
    // Not before it is built.
    expect(await openExport(deps, ADA, asked.id)).toBeUndefined();
    await workOnExports(deps);
    expect(await openExport(deps, GRACE, asked.id)).toBeUndefined();
    expect(await openExport(deps, ADA, 'not-an-export')).toBeUndefined();
    expect(await openExport(deps, ADA, asked.id)).toBeDefined();

    // Past the day: not downloadable even before the sweep, and the sweep deletes the file.
    NOW += READY_FOR_MS + 1;
    expect(await openExport(deps, ADA, asked.id)).toBeUndefined();
    expect(await hasImport(deps.dir, asked.id)).toBe(true);
    expect(await sweepExports(deps)).toMatchObject({ expired: 1 });
    expect(await hasImport(deps.dir, asked.id)).toBe(false);
    expect((await listExportsOf(deps, ADA))[0]?.status).toBe('expired');
    expect(await sweepExports(deps)).toMatchObject({ expired: 0 });
    // The record goes a week later.
    NOW += 8 * 24 * 3_600_000;
    expect((await sweepExports(deps)).forgotten).toBe(1);
    expect(await listExportsOf(deps, ADA)).toEqual([]);
  });

  it('is deleted at once by its owner and by no one else', async () => {
    await seed();
    const asked = await requestExport(deps, ADA);
    if (!asked.ok) throw new Error('refused');
    await workOnExports(deps);
    expect(await deleteExport(deps, GRACE, asked.id)).toBe(false);
    expect(await hasImport(deps.dir, asked.id)).toBe(true);
    expect(await deleteExport(deps, ADA, asked.id)).toBe(true);
    expect(await deleteExport(deps, ADA, asked.id)).toBe(false);
    expect(await hasImport(deps.dir, asked.id)).toBe(false);
  });

  it('is removed with the person, files and rows, and no one else’s', async () => {
    await seed();
    const a = await requestExport(deps, ADA);
    const g = await requestExport(deps, GRACE);
    if (!a.ok || !g.ok) throw new Error('refused');
    await workOnExports(deps);
    await workOnExports(deps);
    expect(await deleteExportsOf(deps, ADA)).toBe(1);
    expect(await deleteExportsOf(deps, ADA)).toBe(0);
    expect(await hasImport(deps.dir, a.id)).toBe(false);
    expect(await hasImport(deps.dir, g.id)).toBe(true);
  });

  it('sweeps a file no request names once it is an hour old', async () => {
    await seed();
    const { writeImport } = await import('../import/files');
    const stray = '22222222-2222-4222-8222-222222222222';
    await writeImport(
      deps.dir,
      stray,
      (async function* () {
        yield Buffer.from('x');
      })(),
      ring,
    );
    expect((await sweepExports({ database, dir: deps.dir, now: () => Date.now() })).files).toBe(0);
    expect(
      (await sweepExports({ database, dir: deps.dir, now: () => Date.now() + 2 * 3_600_000 }))
        .files,
    ).toBe(1);
    expect(readdirSync(deps.dir)).toEqual([]);
  });
});

describe(`when it cannot be built (${leg})`, () => {
  it('ends as failed with no file left, and the person can ask again', async () => {
    // A person with no profile has nothing to export it under: the build throws.
    const asked = await requestExport(deps, 'nobody-account');
    if (!asked.ok) throw new Error('refused');
    expect(await workOnExports(deps)).toBe(true);
    expect((await listExportsOf(deps, 'nobody-account'))[0]?.status).toBe('failed');
    expect(await hasImport(deps.dir, asked.id)).toBe(false);
    expect((await requestExport(deps, 'nobody-account')).ok).toBe(true);
  });
});
