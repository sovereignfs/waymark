import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '../db/client';
import { dbAll } from '../db/exec';
import { makeStore, testTarget } from '../db/test-support';
import { CHUNK_BYTES, readImport, writeImport } from '../import/files';
import { createImport } from '../import/service';
import { enqueueMail } from '../mail/outbox';
import { putMedia, readMedia } from '../media/service';
import { raiseNotice } from '../notices/notices';
import { createProfile, getProfile } from '../profile/profile';
import { getPlace, listPlaces, makePlace, updatePlace } from '../places/places';
import { applyMutation } from '../sync/apply';
import { CryptoError, fingerprintOfEnvelope } from './envelope';
import { type KeyRing, ringOf } from './keys';
import { PHASES, type RotateDeps, rotateKeys, rotationOf } from './rotate';
import { Sealer } from './sealed';

/**
 * Rotating the instance key (DESIGN.md §18.1, 3.3), on whichever database the leg runs on: **after a rotation and the old key removed, every row and file opens**, a rotation stopped halfway resumes and finishes,
 * and what was sealed under a key that is neither is counted and does not stop the rest.
 */
const { leg } = testTarget();
const keyA = randomBytes(32);
const keyB = randomBytes(32);
const keyC = randomBytes(32);
const must = (ring: KeyRing | undefined): KeyRing => {
  if (!ring) throw new Error('no ring');
  return ring;
};
const ringA = must(ringOf(keyA));
const ringBA = must(ringOf(keyB, keyA));
const ringB = must(ringOf(keyB));
const ringCA = must(ringOf(keyC, keyA));
const NOW = 1_800_000_000_000;
const ACCOUNT = 'rot-account';
const PHOTO = '55555555-5555-4555-8555-555555555555';

let database: Database;
let close: () => Promise<void>;
let directory: string;
let dirs: RotateDeps['dirs'];
let import1 = '';
let bigImport = '';
let original: Buffer;
beforeAll(async () => {
  ({ database, close } = await makeStore());
  directory = mkdtempSync(path.join(tmpdir(), 'waymark-rotate-'));
  dirs = {
    media: path.join(directory, 'media'),
    imports: path.join(directory, 'imports'),
    exports: path.join(directory, 'exports'),
  };
  const sealer = new Sealer(ringA);
  const media = {
    database,
    ring: ringA,
    dir: dirs.media,
    maxAccountBytes: 100 * 1024 * 1024,
    now: () => NOW,
  };
  // Everything sealed, under the old key: a profile, a place, a check-in, a notice, mail waiting, an import with its file, a photo, and a file of several chunks.
  await createProfile(
    database,
    sealer,
    { accountId: ACCOUNT, name: 'Ada Lovelace', email: 'ada@example.com' },
    NOW,
  );
  await makePlace({ database, sealer, now: () => NOW }, ACCOUNT, {
    name: 'Zxqv Cafe',
    lat: 38.7,
    lng: -9.1,
  });
  const stored = await putMedia(media, {
    accountId: ACCOUNT,
    kind: 'photo',
    id: PHOTO,
    bytes: await sharp({
      create: { width: 20, height: 10, channels: 3, background: { r: 1, g: 2, b: 3 } },
    })
      .jpeg()
      .toBuffer(),
  });
  expect(stored.ok).toBe(true);
  const place = (await listPlaces({ database, sealer }, ACCOUNT))[0];
  expect(
    (
      await applyMutation({ database, sealer, now: () => NOW }, ACCOUNT, {
        mutationId: 'rot-1',
        stream: 'account',
        changes: [
          {
            table: 'checkin',
            op: 'put',
            id: 'rot-c1',
            row: {
              placeId: place?.id,
              at: NOW - 1000,
              tz: 'Europe/Lisbon',
              offsetMin: 0,
              note: 'a note nobody else reads',
              companions: ['Grace'],
              tripId: null,
              linkSource: null,
              share: 'trip',
              source: 'live',
              photos: [PHOTO],
            },
          },
        ],
      })
    ).status,
  ).toBe('applied');
  await raiseNotice(database, sealer, NOW, {
    to: ACCOUNT,
    by: 'x',
    kind: 'import_finished',
    content: { title: 'Done' },
  });
  await enqueueMail(database, sealer, NOW, {
    accountId: ACCOUNT,
    kind: 'notice',
    message: { to: 'ada@example.com', subject: 'S', text: 'T' },
  });
  const created = await createImport(
    {
      database,
      sealer,
      ring: ringA,
      dir: dirs.imports,
      workDir: path.join(directory, 'work'),
      now: () => NOW,
      readers: { swarm: { source: 'swarm' } as never },
    },
    {
      accountId: ACCOUNT,
      source: 'swarm',
      body: (async function* () {
        yield Buffer.from('PK a small export');
      })(),
    },
  );
  if (!created.ok) throw new Error('could not seed an import');
  import1 = created.id;
  // A file of several chunks, as an export is.
  original = randomBytes(CHUNK_BYTES * 2 + 777);
  bigImport = '66666666-6666-4666-8666-666666666666';
  await writeImport(
    dirs.exports,
    bigImport,
    (async function* () {
      yield original;
    })(),
    ringA,
  );
});
afterAll(async () => {
  await close();
  rmSync(directory, { recursive: true, force: true });
});

/** A sealed column as the driver gives it: bytes, or an ArrayBuffer of them. */
const bytes = (value: unknown): Uint8Array =>
  value instanceof Uint8Array ? value : new Uint8Array(value as ArrayBuffer);

const named = (name: string) => sql.raw(database.dialect === 'postgres' ? `waymark.${name}` : name);
const deps = (ring: KeyRing): RotateDeps => ({ database, ring, dirs, now: () => NOW });

/** The fingerprint of every sealed envelope in the database, by table. */
async function fingerprints(): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {};
  for (const table of ['profile', 'place', 'checkin', 'notice', 'mail_outbox', 'import_job']) {
    const rows = await dbAll<{ sealed: unknown }>(
      database,
      sql`SELECT sealed FROM ${named(table)} WHERE sealed IS NOT NULL`,
    );
    out[table] = rows.map((row) => fingerprintOfEnvelope(bytes(row.sealed)) ?? 'none');
  }
  return out;
}
const all = (found: Record<string, string[]>) => Object.values(found).flat();

/** Everything seeded, opened with `ring` alone. */
async function opensWith(ring: KeyRing) {
  const sealer = new Sealer(ring);
  expect(await getProfile(database, sealer, ACCOUNT)).toMatchObject({ name: 'Ada Lovelace' });
  expect((await listPlaces({ database, sealer }, ACCOUNT))[0]?.name).toBe('Zxqv Cafe');
  const media = { database, ring, dir: dirs.media, maxAccountBytes: 1, now: () => NOW };
  expect((await readMedia(media, { accountId: ACCOUNT, id: PHOTO }))?.type).toBe('image/webp');
  const rows = await dbAll<{ id: string; sealed: unknown }>(
    database,
    sql`SELECT id, sealed FROM ${named('checkin')}`,
  );
  expect(sealer.unseal('checkin', rows[0]?.id as string, bytes(rows[0]?.sealed))).toMatchObject({
    note: 'a note nobody else reads',
  });
  const notices = await dbAll<{ id: string; sealed: unknown }>(
    database,
    sql`SELECT id, sealed FROM ${named('notice')}`,
  );
  expect(
    sealer.unseal('notice', notices[0]?.id as string, bytes(notices[0]?.sealed)),
  ).toMatchObject({ content: { title: 'Done' } });
  const mail = await dbAll<{ id: string; sealed: unknown }>(
    database,
    sql`SELECT id, sealed FROM ${named('mail_outbox')}`,
  );
  expect(sealer.unseal('mail_outbox', mail[0]?.id as string, bytes(mail[0]?.sealed))).toMatchObject(
    { address: 'ada@example.com' },
  );
  const chunks: Buffer[] = [];
  for await (const chunk of readImport(dirs.exports, bigImport, ring)) chunks.push(chunk);
  expect(Buffer.concat(chunks).equals(original)).toBe(true);
  const small: Buffer[] = [];
  for await (const chunk of readImport(dirs.imports, import1, ring)) small.push(chunk);
  expect(Buffer.concat(small).toString()).toBe('PK a small export');
}

describe(`rotating the key (${leg})`, () => {
  it('has everything under the old key to begin with: it opens with the old key and not with the new', async () => {
    await opensWith(ringA);
    expect(new Set(all(await fingerprints()))).toEqual(new Set([ringA.current.fingerprint]));
    await expect(opensWith(ringB)).rejects.toBeInstanceOf(CryptoError);
    expect(await rotationOf(database, ringA)).toEqual({
      state: 'none',
      rewrapped: 0,
      unopenable: 0,
    });
    // With a previous key given and nothing yet done, it is under way.
    expect((await rotationOf(database, ringBA)).state).toBe('running');
    // It still opens with both keys in the ring, which is the whole of the time a rotation takes.
    await opensWith(ringBA);
  });

  it('is stopped halfway and carries on from where it was: some under the new key, all opening, and the rest moved by the next run', async () => {
    const first = await rotateKeys(deps(ringBA), { batch: 1, maxBatches: 4 });
    expect(first.state).toBe('running');
    expect(first.rewrapped).toBeGreaterThan(0);
    expect(await rotationOf(database, ringBA)).toMatchObject({
      state: 'running',
      rewrapped: first.rewrapped,
    });
    // Some are new and some are old, and everything opens with the two keys in the ring.
    const mixed = new Set(all(await fingerprints()));
    expect(mixed.has(ringB.current.fingerprint)).toBe(true);
    await opensWith(ringBA);

    // A process that starts afterwards reads where it was, from the database, and finishes.
    const done = await rotateKeys(deps(ringBA), { batch: 1 });
    expect(done).toMatchObject({ state: 'done', unopenable: 0 });
    expect(done.rewrapped).toBeGreaterThan(first.rewrapped);
    expect(await rotationOf(database, ringBA)).toMatchObject({ state: 'done' });
  });

  it('leaves every row and file under the new key, and everything opens with the old key removed', async () => {
    expect(new Set(all(await fingerprints()))).toEqual(new Set([ringB.current.fingerprint]));
    // The rows were a profile, a place, a check-in, a notice and mail (an import's own row seals only what went wrong, and nothing did).
    expect(all(await fingerprints())).toHaveLength(5);
    await opensWith(ringB);
    // And a file of several chunks is whole, chunk by chunk, with the old key gone from its every frame.
    const frames = readFileSync(path.join(dirs.exports, bigImport));
    expect(frames.includes(Buffer.from(ringA.current.fingerprint, 'hex'))).toBe(false);
  });

  it('does nothing the second time, and nothing without a previous key; the state says it is done', async () => {
    const again = await rotateKeys(deps(ringBA));
    expect(again).toMatchObject({ state: 'done' });
    expect(await rotateKeys(deps(ringB))).toEqual({ state: 'none', rewrapped: 0, unopenable: 0 });
    expect(await rotationOf(database, ringB)).toEqual({
      state: 'none',
      rewrapped: 0,
      unopenable: 0,
    });
  });
});

describe(`what cannot be moved (${leg})`, () => {
  it('is counted and does not stop the rest: a row sealed under a key that is neither is unopenable, and the others move', async () => {
    // A third key: a row sealed under C when the ring is {D current, A previous}.
    const sealerC = new Sealer(must(ringOf(keyC)));
    await createProfile(
      database,
      sealerC,
      { accountId: 'stranded-account', name: 'Stranded', email: 's@example.com' },
      NOW,
    );
    const sealerA = new Sealer(ringA);
    await createProfile(
      database,
      sealerA,
      { accountId: 'movable-account', name: 'Movable', email: 'm@example.com' },
      NOW,
    );
    const result = await rotateKeys(deps(ringCA));
    expect(result.state).toBe('done');
    expect(result.unopenable).toBeGreaterThanOrEqual(1);
    // The one under A moved to C; the one under C was already current, and is left.
    expect(
      await getProfile(database, new Sealer(must(ringOf(keyC))), 'movable-account'),
    ).toMatchObject({ name: 'Movable' });
    // The earlier rotation's rows (under B, which is neither A nor C) are the ones it could not move.
    expect(result.unopenable).toBeGreaterThanOrEqual(5);
  });
});

describe(`a row written while it is being moved (${leg})`, () => {
  it('is not overwritten with the version that was read: the later write stands, and is under the new key already', async () => {
    const ring = must(ringOf(randomBytes(32), keyB));
    // A place sealed under B (the previous key of this ring), and a person renaming it, with the new key, after the rotation has read it and before it writes.
    const old = new Sealer(ringB);
    const fresh = new Sealer(ring);
    const made = await makePlace({ database, sealer: old, now: () => NOW }, 'racer-account', {
      name: 'Before',
      lat: 1,
      lng: 1,
    });
    if (!made.ok) throw new Error('no place');
    let renamed = false;
    const result = await rotateKeys({
      ...deps(ring),
      afterRead: async (table) => {
        if (table !== 'place' || renamed) return;
        renamed = true;
        const updated = await updatePlace(
          { database, sealer: fresh, now: () => NOW + 1 },
          'racer-account',
          made.place.id,
          { name: 'After' },
        );
        expect(updated?.name).toBe('After');
      },
    });
    expect(result.state).toBe('done');
    expect(renamed).toBe(true);
    expect(
      (await getPlace({ database, sealer: fresh }, 'racer-account', made.place.id))?.name,
    ).toBe('After');
    const rows = await dbAll<{ sealed: unknown }>(
      database,
      sql`SELECT sealed FROM ${named('place')} WHERE id = ${made.place.id}`,
    );
    expect(fingerprintOfEnvelope(bytes(rows[0]?.sealed))).toBe(ring.current.fingerprint);
  });
});

describe('the phases', () => {
  it('are every table with a sealed column and the three directories of sealed files', () => {
    expect(PHASES).toEqual([
      'profile',
      'place',
      'checkin',
      'trip',
      'stop',
      'day',
      'item',
      'notice',
      'mail_outbox',
      'core_outbox',
      'import_job',
      'media',
      'imports',
      'exports',
    ]);
  });
});
