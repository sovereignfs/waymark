import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { unzipSync } from 'fflate';
import { sql } from 'drizzle-orm';
import sharp from 'sharp';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type KeyRing, ringOf } from '../crypto/keys';
import { Sealer } from '../crypto/sealed';
import type { Database } from '../db/client';
import { dbAll } from '../db/exec';
import { makeStore, testTarget } from '../db/test-support';
import { hasImport } from '../import/files';
import { type ImportDeps, STEP_ITEMS, idFor, workOnImports } from '../import/job';
import { cancelImport, createImport, listImportsOf } from '../import/service';
import { putMedia, readMedia } from '../media/service';
import { listNotices } from '../notices/notices';
import { createProfile, getProfile } from '../profile/profile';
import { applyMutation } from '../sync/apply';
import { type ExportDeps, openExport, requestExport, workOnExports } from './export';
import { FORMAT, JSON_NAME, SENTENCES, VERSION } from './format';
import { waymarkReader } from './reader';
import { ZipWriter } from './zip';

/**
 * Importing a Waymark file (DESIGN.md §22), on whichever database the leg runs on, through the import job: **export, import into a second account, export again, and the two match but for ids and times**; importing
 * the same file twice creates nothing the second time; a file that is wrong in any way is refused whole with a sentence and nothing is made.
 */
const { leg } = testTarget();
const made = ringOf(randomBytes(32));
if (!made) throw new Error('no ring');
const ring: KeyRing = made;
const sealer = new Sealer(ring);
const ADA = 'ada-account';
const GRACE = 'grace-account';
const HAL = 'hal-account';
let NOW = 1_800_000_000_000;

let database: Database;
let close: () => Promise<void>;
let directory: string;
let exportDeps: ExportDeps;
let importDeps: ImportDeps;
beforeAll(async () => {
  ({ database, close } = await makeStore());
  directory = mkdtempSync(path.join(tmpdir(), 'waymark-import-file-'));
  const media = {
    database,
    ring,
    dir: path.join(directory, 'media'),
    maxAccountBytes: 100 * 1024 * 1024,
    now: () => NOW,
  };
  exportDeps = {
    database,
    sealer,
    ring,
    dir: path.join(directory, 'exports'),
    media,
    now: () => NOW,
  };
  importDeps = {
    database,
    sealer,
    ring,
    dir: path.join(directory, 'imports'),
    workDir: path.join(directory, 'work'),
    now: () => NOW,
    media,
    readers: { waymark: waymarkReader },
  };
  for (const [id, name] of [
    [ADA, 'Ada Lovelace'],
    [GRACE, 'Grace Hopper'],
    [HAL, 'Hal Smith'],
  ] as const)
    await createProfile(database, sealer, { accountId: id, name, email: `${id}@example.com` }, NOW);
});
afterAll(async () => {
  await close();
  rmSync(directory, { recursive: true, force: true });
});
beforeEach(async () => {
  NOW += 1000;
  await dbAll(database, sql`DELETE FROM ${named('import_job')} RETURNING id`);
  await dbAll(database, sql`DELETE FROM ${named('export_job')} RETURNING id`);
});

const named = (name: string) => sql.raw(database.dialect === 'postgres' ? `waymark.${name}` : name);
const picture = (color: number) =>
  sharp({ create: { width: 40, height: 30, channels: 3, background: { r: color, g: 90, b: 40 } } })
    .jpeg()
    .toBuffer();
let n = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++n + 1000).padStart(12, '0')}`;
const apply = async (who: string, changes: unknown[]) =>
  expect(
    (await applyMutation(exportDeps, who, { mutationId: uuid(), stream: 'account', changes }))
      .status,
  ).toBe('applied');

/** Ada's data: places, check-ins of each kind, companions, notes and two photos on one check-in. Seeded once. */
let seeded: { photos: string[] } | undefined;
async function seedAda() {
  if (seeded) return seeded;
  const photos = [uuid(), uuid()];
  for (const [id, color] of [
    [photos[0] as string, 10],
    [photos[1] as string, 120],
  ] as const) {
    expect(
      (
        await putMedia(exportDeps.media, {
          accountId: ADA,
          kind: 'photo',
          id,
          bytes: await picture(color),
        })
      ).ok,
    ).toBe(true);
  }
  const place = (name: string, lat: number, extra: Record<string, unknown> = {}) => ({
    name,
    lat,
    lng: -9.1,
    source: 'manual',
    tz: 'Europe/Lisbon',
    countryCode: 'PT',
    ...extra,
  });
  const row = (placeId: string, i: number, extra: Record<string, unknown> = {}) => ({
    placeId,
    at: 1_700_000_000_000 + i * 3_600_000,
    tz: 'Europe/Lisbon',
    offsetMin: 0,
    companions: [],
    tripId: null,
    linkSource: null,
    share: 'trip',
    source: 'live',
    ...extra,
  });
  await apply(ADA, [
    {
      table: 'place',
      op: 'put',
      id: 'rt-p1',
      row: place('Pastéis de Belém', 38.697, {
        category: 'Bakery',
        sourceId: 'node/42',
        source: 'osm',
        address: { city: 'Lisbon', country: 'Portugal', countryCode: 'PT' },
      }),
    },
    { table: 'place', op: 'put', id: 'rt-p2', row: place('Ada Museum', 38.8) },
    { table: 'place', op: 'put', id: 'rt-p3', row: place('Never Visited', 38.9) },
    {
      table: 'checkin',
      op: 'put',
      id: 'rt-c1',
      row: row('rt-p1', 0, { note: 'First!', companions: ['Grace', 'Alan'], photos: photos }),
    },
    {
      table: 'checkin',
      op: 'put',
      id: 'rt-c2',
      row: row('rt-p1', 1, { source: 'manual', note: 'Remembered later' }),
    },
    { table: 'checkin', op: 'put', id: 'rt-c3', row: row('rt-p2', 2) },
    {
      table: 'checkin',
      op: 'put',
      id: 'rt-c4',
      row: row('rt-p2', 3, { source: 'import:swarm', externalId: '4sq-abc' }),
    },
  ]);
  seeded = { photos };
  return seeded;
}

/** An export of a person, as the ZIP file it is. */
async function exportOf(who: string): Promise<Buffer> {
  const asked = await requestExport(exportDeps, who);
  if (!asked.ok) throw new Error('busy');
  await workOnExports(exportDeps);
  const file = await openExport(exportDeps, who, asked.id);
  if (!file) throw new Error('not ready');
  const chunks: Buffer[] = [];
  for await (const chunk of file.stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function importFile(who: string, bytes: Uint8Array, budget?: { signal?: AbortSignal }) {
  const created = await createImport(importDeps, {
    accountId: who,
    source: 'waymark',
    body: (async function* () {
      yield bytes;
    })(),
  });
  if (!created.ok) throw new Error(`refused: ${created.reason}`);
  await workOnImports(importDeps, budget);
  const view = (await listImportsOf(importDeps, who, 50)).find((each) => each.id === created.id);
  return { id: created.id, view };
}

const documentOf = (zip: Buffer) => {
  const files = unzipSync(new Uint8Array(zip));
  return { json: JSON.parse(Buffer.from(files[JSON_NAME] as Uint8Array).toString('utf8')), files };
};

/** What an export holds that should be the same after a round trip: everything but ids, times of export and the person. */
function essence(zip: Buffer) {
  const { json } = documentOf(zip);
  const placeName = new Map<string, string>(
    json.places.map((p: { id: string; name: string }) => [p.id, p.name]),
  );
  // A photo is stored by re-encoding it (the media store judges it by its bytes and strips it), so one that has been through an import is the same picture and not the same bytes: its type is compared, and the
  // size of the picture is compared where the test decodes it.
  const photoBytes = new Map<string, string>(
    json.photos.map((p: { id: string; file: string; type: string }) => [
      p.id,
      `${p.type} ${p.file.split('.').pop()}`,
    ]),
  );
  return {
    places: json.places
      .map(({ id: _id, ...rest }: { id: string }) => rest)
      .sort((a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name)),
    checkins: json.checkins
      .map((c: Record<string, unknown> & { placeId: string; photos?: string[] }) => {
        const { id: _id, placeId, photos, ...rest } = c;
        return {
          ...rest,
          place: placeName.get(placeId),
          photos: (photos ?? []).map((id) => photoBytes.get(id)),
        };
      })
      .sort((a: { at: number }, b: { at: number }) => a.at - b.at),
  };
}

describe(`export, import, export (${leg})`, () => {
  it('matches but for ids and times: every place, check-in, companion, note, source and photo, byte for byte', async () => {
    const { photos } = await seedAda();
    const first = await exportOf(ADA);
    const { id, view } = await importFile(GRACE, first);
    expect(view).toMatchObject({
      status: 'done',
      checkinsDone: 4,
      checkinsSkipped: 0,
      placesMade: 3,
      photosDone: 2,
      photosFailed: 0,
    });
    const second = await exportOf(GRACE);
    expect(essence(second)).toEqual(essence(first));
    // The ids are Grace's own, not Ada's, and the photos are stored for Grace.
    const { json } = documentOf(second);
    expect(json.places.some((p: { id: string }) => p.id === 'rt-p1')).toBe(false);
    expect(json.checkins.every((c: { id: string }) => !c.id.startsWith('rt-'))).toBe(true);
    for (const photo of json.photos)
      expect(await readMedia(exportDeps.media, { accountId: GRACE, id: photo.id })).toBeDefined();
    expect(
      await readMedia(exportDeps.media, { accountId: ADA, id: photos[0] as string }),
    ).toBeDefined();
    // The pictures are the pictures: decoded, they are the size they were.
    for (const photo of json.photos) {
      const stored = await readMedia(exportDeps.media, { accountId: GRACE, id: photo.id });
      const meta = await sharp(stored?.bytes).metadata();
      expect([meta.width, meta.height]).toEqual([40, 30]);
    }
    // A Swarm check-in keeps its Foursquare id, not the file’s own.
    expect(
      json.checkins.find((c: { source: string }) => c.source === 'import:swarm')?.externalId,
    ).toBe('4sq-abc');
    // The file is gone, and the importer was told once.
    expect(await hasImport(importDeps.dir, id)).toBe(false);
    expect(
      (await listNotices(importDeps, GRACE)).filter((x) => x.title === 'Your import has finished'),
    ).toHaveLength(1);
  });

  it('creates nothing the second time, and leaves what the importer changed or deleted as they left it', async () => {
    await seedAda();
    const file = await exportOf(ADA);
    const again = await importFile(HAL, file);
    expect(again.view).toMatchObject({ status: 'done', checkinsDone: 4 });
    // Hal renames a place and deletes a check-in.
    const placeId = idFor('place', HAL, 'rt-p2');
    expect(
      (
        await applyMutation(exportDeps, HAL, {
          mutationId: uuid(),
          stream: 'account',
          changes: [
            {
              table: 'place',
              op: 'put',
              id: placeId,
              row: {
                name: 'Hal’s Museum',
                lat: 38.8,
                lng: -9.1,
                source: 'manual',
                tz: 'Europe/Lisbon',
                countryCode: 'PT',
              },
            },
            { table: 'checkin', op: 'delete', id: idFor('checkin', HAL, 'rt-c3') },
          ],
        })
      ).status,
    ).toBe('applied');
    const before = essence(await exportOf(HAL));
    const second = await importFile(HAL, file);
    expect(second.view).toMatchObject({
      status: 'done',
      checkinsDone: 0,
      checkinsSkipped: 5,
      placesMade: 0,
      photosDone: 0,
    });
    const after = essence(await exportOf(HAL));
    expect(after).toEqual(before);
    expect(after.places.some((p: { name: string }) => p.name === 'Hal’s Museum')).toBe(true);
    expect(after.checkins).toHaveLength(3);
  });

  it('brings no profile and no settings: the importer’s name is theirs still', async () => {
    await seedAda();
    await importFile(GRACE, await exportOf(ADA));
    expect(await getProfile(database, sealer, GRACE)).toMatchObject({ name: 'Grace Hopper' });
  });

  it('carries on after a stop, from the cursor, and makes the whole once', async () => {
    // Enough check-ins for several steps, at one place, by a file we build.
    const many = STEP_ITEMS * 3 + 5;
    const place = {
      id: 'big-p',
      name: 'Big Place',
      lat: 10,
      lng: 10,
      source: 'manual',
      tz: 'Africa/Lagos',
      countryCode: null,
    };
    const checkins = Array.from({ length: many }, (_, i) => ({
      id: `big-c${i}`,
      placeId: 'big-p',
      at: 1_600_000_000_000 + i * 60_000,
      tz: 'Africa/Lagos',
      offsetMin: 60,
      companions: [],
      tripId: null,
      linkSource: null,
      share: 'trip',
      source: 'manual',
    }));
    const bytes = zipOf({ places: [place], checkins, photos: [] });
    const stop = new AbortController();
    // The process is told to stop during the first step: it finishes that step and gives the lease up.
    const stopping: ImportDeps = {
      ...importDeps,
      readers: {
        waymark: {
          source: 'waymark',
          open: async (file, context) => {
            const inner = await waymarkReader.open(file, context);
            return {
              checkins: async (input) => {
                const read = await inner.checkins(input);
                if (input.cursor === 0) stop.abort();
                return read;
              },
              close: () => inner.close(),
            };
          },
        },
      },
    };
    const created = await createImport(importDeps, {
      accountId: GRACE,
      source: 'waymark',
      body: (async function* () {
        yield bytes;
      })(),
    });
    if (!created.ok) throw new Error('refused');
    expect(await workOnImports(stopping, { signal: stop.signal })).toEqual({ ended: 0 });
    const midway = (await listImportsOf(importDeps, GRACE, 50)).find(
      (each) => each.id === created.id,
    );
    expect(midway).toMatchObject({ status: 'running', checkinsDone: STEP_ITEMS });
    // After a restart, the next run takes it at the cursor and makes the rest.
    await workOnImports(importDeps);
    const done = (await listImportsOf(importDeps, GRACE, 50)).find(
      (each) => each.id === created.id,
    );
    expect(done).toMatchObject({ status: 'done', checkinsDone: many, placesMade: 1 });
  });
});

/** A Waymark file built by hand, for the cases an export would never make. */
function zipOf(
  parts: { places: unknown[]; checkins: unknown[]; photos: unknown[] },
  over: Record<string, unknown> = {},
  files: [string, Uint8Array][] = [],
): Buffer {
  const document = {
    format: FORMAT,
    version: VERSION,
    exportedAt: new Date(NOW).toISOString(),
    profile: { name: 'Someone', units: 'km', weekStart: 1, shareDefault: 'ask' },
    settings: { email: {} },
    ...parts,
    ...over,
  };
  const zip = new ZipWriter(new Date(NOW));
  const out: Buffer[] = [];
  for (const [name, data] of files) for (const part of zip.add(name, data)) out.push(part);
  for (const part of zip.add(JSON_NAME, Buffer.from(JSON.stringify(document)), { deflate: true }))
    out.push(part);
  for (const part of zip.finish()) out.push(part);
  return Buffer.concat(out);
}

describe(`a file that is not right (${leg})`, () => {
  const place = {
    id: 'p',
    name: 'Somewhere',
    lat: 1,
    lng: 1,
    source: 'manual',
    tz: 'Africa/Lagos',
    countryCode: null,
  };
  const checkin = {
    id: 'c',
    placeId: 'p',
    at: 1_600_000_000_000,
    tz: 'Africa/Lagos',
    offsetMin: 60,
    companions: [],
    tripId: null,
    linkSource: null,
    share: 'trip',
    source: 'manual',
  };

  async function refused(bytes: Uint8Array, who = GRACE) {
    const before = await listPlacesCount(who);
    const { id, view } = await importFile(who, bytes);
    expect(view?.status).toBe('failed');
    // Nothing was made, the file is gone, and the person was told, in the sentence.
    expect(await listPlacesCount(who)).toBe(before);
    expect(await hasImport(importDeps.dir, id)).toBe(false);
    const told = (await listNotices(importDeps, who)).find(
      (x) => x.title === 'Your import could not be finished',
    );
    expect(told).toBeDefined();
    return view?.errors[0]?.sentence;
  }
  const listPlacesCount = async (who: string) =>
    Number(
      (
        await dbAll<{ n: number | string }>(
          database,
          sql`SELECT COUNT(*) AS n FROM ${named('place')} WHERE account_id = ${who}`,
        )
      )[0]?.n,
    );

  it('is refused whole with a sentence, and nothing is made: not a ZIP, a ZIP with no waymark.json, another format, JSON that is not JSON', async () => {
    expect(await refused(Buffer.from('this is not a zip file at all'))).toBe(SENTENCES.notWaymark);
    const noJson = new ZipWriter(new Date(NOW));
    const bytes = Buffer.concat([
      ...noJson.add('readme.txt', Buffer.from('hi')),
      ...noJson.finish(),
    ]);
    expect(await refused(bytes)).toBe(SENTENCES.notWaymark);
    expect(
      await refused(zipOf({ places: [], checkins: [], photos: [] }, { format: 'something-else' })),
    ).toBe(SENTENCES.notWaymark);
    const garbage = new ZipWriter(new Date(NOW));
    expect(
      await refused(
        Buffer.concat([...garbage.add(JSON_NAME, Buffer.from('{not json')), ...garbage.finish()]),
      ),
    ).toBe(SENTENCES.unreadable);
  });

  it('is refused if it is from a newer version, with what to do', async () => {
    const said = await refused(
      zipOf({ places: [place], checkins: [checkin], photos: [] }, { version: VERSION + 1 }),
    );
    expect(said).toBe(SENTENCES.newer);
    expect(said).toContain('Update Waymark');
  });

  it('is refused if one check-in in it is not valid, even the last, and none of the others are made', async () => {
    const good = Array.from({ length: 30 }, (_, i) => ({
      ...checkin,
      id: `ok${i}`,
      at: checkin.at + i * 1000,
    }));
    const bad = { ...checkin, id: 'bad', placeId: 'nowhere' };
    expect(await refused(zipOf({ places: [place], checkins: [...good, bad], photos: [] }))).toBe(
      SENTENCES.broken,
    );
  });

  it('is refused if it lists a photo the ZIP does not hold, or one larger than a photo may be', async () => {
    const photoId = '33333333-3333-4333-8333-333333333333';
    const withPhoto = { ...checkin, photos: [photoId] };
    const listed = { id: photoId, file: `photos/${photoId}.webp`, type: 'image/webp' };
    expect(await refused(zipOf({ places: [place], checkins: [withPhoto], photos: [listed] }))).toBe(
      SENTENCES.broken,
    );
    const huge = Buffer.alloc(16 * 1024 * 1024, 1);
    expect(
      await refused(
        zipOf({ places: [place], checkins: [withPhoto], photos: [listed] }, {}, [
          [listed.file, huge],
        ]),
      ),
    ).toBe(SENTENCES.broken);
  });

  it('leaves off a photo that is not an image, counts it, and still makes the check-in', async () => {
    const photoId = '44444444-4444-4444-8444-444444444444';
    const withPhoto = { ...checkin, id: 'c-html', photos: [photoId] };
    const listed = { id: photoId, file: `photos/${photoId}.webp`, type: 'image/webp' };
    const { view } = await importFile(
      GRACE,
      zipOf({ places: [place], checkins: [withPhoto], photos: [listed] }, {}, [
        [listed.file, Buffer.from('<html><script>alert(1)</script></html>')],
      ]),
    );
    expect(view).toMatchObject({ status: 'done', checkinsDone: 1, photosDone: 0, photosFailed: 1 });
    const stored = await dbAll<{ n: number | string }>(
      database,
      sql`SELECT COUNT(*) AS n FROM ${named('checkin_photo')} WHERE account_id = ${GRACE} AND id = ${idFor('photo', GRACE, photoId)}`,
    );
    expect(Number(stored[0]?.n)).toBe(0);
  });

  it('is cancelled like any import, and keeps nothing', async () => {
    await seedAda();
    const created = await createImport(importDeps, {
      accountId: HAL,
      source: 'waymark',
      body: (async function* () {
        yield await exportOf(ADA);
      })(),
    });
    if (!created.ok) throw new Error('refused');
    expect(await cancelImport(importDeps, HAL, created.id)).toBe(true);
    expect(await hasImport(importDeps.dir, created.id)).toBe(false);
  });
});
