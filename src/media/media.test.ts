import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import sharp from 'sharp';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CryptoError, openBytes } from '../crypto/envelope';
import { ringOf } from '../crypto/keys';
import { dbAll, dbRun } from '../db/exec';
import { makeStore, testTarget } from '../db/test-support';
import { isFileId, thumbIdOf } from './files';
import { PHOTO_MAX_EDGE, THUMB_MAX_EDGE } from './images';
import {
  type MediaDeps,
  MAX_FILE_BYTES,
  ORPHAN_GRACE_MS,
  SENTENCES,
  deleteMedia,
  putMedia,
  readMedia,
  sweepOrphans,
  usageOf,
} from './service';

const { leg } = testTarget();
const ring = ringOf(randomBytes(32));
if (!ring) throw new Error('no ring');
const ALICE = 'account-alice';
const BOB = 'account-bob';
const NOW = 1_800_000_000_000;

let deps: MediaDeps;
let directory: string;
let close: () => Promise<void>;
let clock = NOW;

beforeAll(async () => {
  const store = await makeStore();
  close = store.close;
  directory = mkdtempSync(path.join(tmpdir(), 'waymark-media-'));
  deps = {
    database: store.database,
    ring,
    dir: path.join(directory, 'media'),
    maxAccountBytes: 50 * 1024 * 1024,
    now: () => clock,
  };
});
afterAll(async () => {
  await close();
  rmSync(directory, { recursive: true, force: true });
});
beforeEach(async () => {
  clock = NOW;
  deps = { ...deps, maxAccountBytes: 50 * 1024 * 1024 };
  rmSync(deps.dir, { recursive: true, force: true });
  await dbRun(deps.database, sql`DELETE FROM ${table()}`);
});

const table = () => sql.raw(deps.database.dialect === 'postgres' ? 'waymark.media' : 'media');
const filesOnDisk = () => readdirSync(deps.dir, { withFileTypes: true }).map((e) => e.name);

/** A picture, optionally with what a phone writes into it: where it was, what took it and when, and an orientation. */
async function photo(
  options: {
    width?: number;
    height?: number;
    orientation?: number;
    planted?: boolean;
    format?: 'jpeg' | 'png' | 'avif';
  } = {},
): Promise<Buffer> {
  const { width = 64, height = 32, orientation, planted = false, format = 'jpeg' } = options;
  let image = sharp({
    create: { width, height, channels: 3, background: { r: 200, g: 40, b: 40 } },
  });
  // `withMetadata` is what keeps an orientation tag; `withExif` alone does not.
  if (orientation !== undefined) image = image.withMetadata({ orientation });
  if (planted)
    image = image.withExif({
      IFD0: {
        Make: 'PLANTED-CAMERA',
        Software: 'PLANTED-SOFTWARE',
      },
      IFD3: {
        GPSLatitudeRef: 'N',
        GPSLatitude: '35/1 39/1 30/1',
        GPSLongitudeRef: 'E',
        GPSLongitude: '139/1 45/1 16/1',
      },
    });
  return format === 'jpeg'
    ? image.jpeg().toBuffer()
    : format === 'png'
      ? image.png().toBuffer()
      : image.avif().toBuffer();
}

const must = async <T>(value: Promise<T | undefined>): Promise<T> => {
  const found = await value;
  if (found === undefined) throw new Error('not found');
  return found;
};
const stored = async (input: Parameters<typeof putMedia>[1]) => {
  const result = await putMedia(deps, input);
  if (!result.ok) throw new Error(`refused: ${result.reason}`);
  return result;
};

describe(`the media store (${leg})`, () => {
  it('refuses an HTML page named .jpg, and anything that is not what the kind allows, before it decodes or stores anything', async () => {
    for (const content of [
      Buffer.from('<!doctype html><script>alert(1)</script>'),
      Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>'),
      Buffer.from('not an image at all'),
    ]) {
      expect(await putMedia(deps, { accountId: ALICE, kind: 'photo', bytes: content })).toEqual({
        ok: false,
        reason: 'not_allowed',
      });
    }
    // A PDF is not a photo, a picture is not an import, and a thumbnail is never uploaded.
    const pdf = Buffer.from('%PDF-1.7\n1 0 obj<<>>endobj');
    expect(await putMedia(deps, { accountId: ALICE, kind: 'photo', bytes: pdf })).toMatchObject({
      reason: 'not_allowed',
    });
    expect(
      await putMedia(deps, { accountId: ALICE, kind: 'import', bytes: await photo() }),
    ).toMatchObject({ reason: 'not_allowed' });
    expect(
      await putMedia(deps, { accountId: ALICE, kind: 'thumb' as never, bytes: await photo() }),
    ).toMatchObject({ reason: 'not_allowed' });
    expect(await usageOf(deps.database, ALICE)).toBe(0);
    expect(await dbAll(deps.database, sql`SELECT id FROM ${table()}`)).toEqual([]);
  });

  it('refuses what is empty, what is not an id, and what is larger than a file may be', async () => {
    expect(
      await putMedia(deps, { accountId: ALICE, kind: 'photo', bytes: new Uint8Array() }),
    ).toMatchObject({ reason: 'unreadable' });
    expect(
      await putMedia(deps, {
        accountId: ALICE,
        kind: 'photo',
        bytes: await photo(),
        id: '../../etc/passwd',
      }),
    ).toMatchObject({ reason: 'bad_id' });
    expect(
      await putMedia(deps, {
        accountId: ALICE,
        kind: 'photo',
        bytes: await photo(),
        id: 'not-a-uuid',
      }),
    ).toMatchObject({ reason: 'bad_id' });
    const big = Buffer.alloc(MAX_FILE_BYTES + 1, 0xff);
    big[1] = 0xd8;
    big[2] = 0xff;
    big[0] = 0xff;
    expect(await putMedia(deps, { accountId: ALICE, kind: 'photo', bytes: big })).toMatchObject({
      reason: 'too_big',
    });
  });

  it('re-encodes a photo with every piece of metadata gone: its location, what took it, the software, and the orientation tag', async () => {
    const original = await photo({ planted: true });
    expect((await sharp(original).metadata()).exif).toBeDefined();
    expect(original.toString('latin1')).toContain('PLANTED-CAMERA');
    const result = await stored({ accountId: ALICE, kind: 'photo', bytes: original });
    const file = await must(readMedia(deps, { accountId: ALICE, id: result.id }));
    expect(file.type).toBe('image/webp');
    const meta = await sharp(file.bytes).metadata();
    expect(meta.format).toBe('webp');
    expect(meta.exif).toBeUndefined();
    expect(meta.icc).toBeUndefined();
    expect(meta.xmp).toBeUndefined();
    expect(meta.orientation).toBeUndefined();
    const text = file.bytes.toString('latin1');
    for (const planted of ['PLANTED', 'GPS', 'Exif', 'Make'])
      expect(text, planted).not.toContain(planted);
    // Nor in the thumbnail.
    const thumb = await must(readMedia(deps, { accountId: ALICE, id: thumbIdOf(result.id) }));
    expect(thumb.bytes.toString('latin1')).not.toContain('PLANTED');
    expect((await sharp(thumb.bytes).metadata()).exif).toBeUndefined();
  });

  it('turns a photo upright by its orientation before the tag is dropped', async () => {
    // 64 wide and 32 high, marked as lying on its side (6): upright it is 32 wide and 64 high.
    const lying = await photo({ orientation: 6 });
    expect((await sharp(lying).metadata()).orientation).toBe(6);
    const result = await stored({
      accountId: ALICE,
      kind: 'photo',
      bytes: await photo({ orientation: 6 }),
    });
    const meta = await sharp(
      (await must(readMedia(deps, { accountId: ALICE, id: result.id }))).bytes,
    ).metadata();
    expect([meta.width, meta.height]).toEqual([32, 64]);
  });

  it('keeps a photo within 2,560 px and its thumbnail within 480, and never makes either larger', async () => {
    const wide = await stored({
      accountId: ALICE,
      kind: 'photo',
      bytes: await photo({ width: 4000, height: 1000 }),
    });
    const big = await sharp(
      (await must(readMedia(deps, { accountId: ALICE, id: wide.id }))).bytes,
    ).metadata();
    expect([big.width, big.height]).toEqual([PHOTO_MAX_EDGE, 640]);
    const little = await sharp(
      (await must(readMedia(deps, { accountId: ALICE, id: thumbIdOf(wide.id) }))).bytes,
    ).metadata();
    expect([little.width, little.height]).toEqual([THUMB_MAX_EDGE, 120]);
    const small = await stored({
      accountId: ALICE,
      kind: 'photo',
      bytes: await photo({ width: 100, height: 50 }),
    });
    expect(
      (
        await sharp(
          (await must(readMedia(deps, { accountId: ALICE, id: small.id }))).bytes,
        ).metadata()
      ).width,
    ).toBe(100);
  });

  it('reads PNG and AVIF, and says in a sentence that it cannot read a HEIC this build cannot decode, or a file that only claims to be an image', async () => {
    for (const format of ['png', 'avif'] as const) {
      const result = await putMedia(deps, {
        accountId: ALICE,
        kind: 'photo',
        bytes: await photo({ format }),
      });
      expect(result, format).toMatchObject({ ok: true });
    }
    // The first bytes of a HEIC file, and nothing that can be decoded behind them.
    const heic = Buffer.concat([
      Buffer.from([0, 0, 0, 24]),
      Buffer.from('ftypheic'),
      Buffer.alloc(32),
    ]);
    const refused = await putMedia(deps, { accountId: ALICE, kind: 'photo', bytes: heic });
    expect(refused.ok).toBe(false);
    expect(['unsupported', 'unreadable']).toContain(refused.ok ? '' : refused.reason);
    const truncated = (await photo()).subarray(0, 40);
    expect(
      await putMedia(deps, { accountId: ALICE, kind: 'photo', bytes: truncated }),
    ).toMatchObject({ ok: false });
    expect(SENTENCES.unsupported).toContain('JPEG');
  });

  it('keeps a PDF as it is, an import as it is, and serves each as the type it is', async () => {
    const pdf = Buffer.from('%PDF-1.7\n1 0 obj<<>>endobj\n%%EOF');
    const a = await stored({ accountId: ALICE, kind: 'attachment', bytes: pdf });
    expect(a.thumbId).toBeUndefined();
    const file = await must(readMedia(deps, { accountId: ALICE, id: a.id }));
    expect(file.type).toBe('application/pdf');
    expect(file.bytes.equals(pdf)).toBe(true);
    const zip = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), randomBytes(200)]);
    const z = await stored({ accountId: ALICE, kind: 'import', bytes: zip });
    expect((await must(readMedia(deps, { accountId: ALICE, id: z.id }))).type).toBe(
      'application/zip',
    );
  });

  it('keeps a file on disk unreadable without the key: sealed, named by its id alone, bound to it', async () => {
    const original = await photo({ width: 300, height: 200, planted: true });
    const result = await stored({ accountId: ALICE, kind: 'photo', bytes: original });
    const names = filesOnDisk();
    expect(names.sort()).toEqual([result.id, thumbIdOf(result.id)].sort());
    for (const name of names) expect(isFileId(name)).toBe(true);
    const onDisk = readFileSync(path.join(deps.dir, result.id));
    // Not an image, and not the file it was made from: no format's signature, no word of the original.
    expect(onDisk.subarray(0, 4).toString('latin1')).not.toBe('RIFF');
    expect(onDisk.toString('latin1')).not.toContain('WEBP');
    expect(onDisk.toString('latin1')).not.toContain('PLANTED');
    // It opens with the key, for its id, and not with another key or as another file.
    const opened = openBytes(onDisk, { id: result.id, purpose: 'file' }, ring);
    expect((await sharp(opened).metadata()).format).toBe('webp');
    expect(() =>
      openBytes(onDisk, { id: result.id, purpose: 'file' }, ringOf(randomBytes(32)) ?? ring),
    ).toThrow(CryptoError);
    expect(() => openBytes(onDisk, { id: randomUUID(), purpose: 'file' }, ring)).toThrow(
      CryptoError,
    );
    // A file copied over another's name does not open there.
    writeFileSync(path.join(deps.dir, thumbIdOf(result.id)), onDisk);
    await expect(readMedia(deps, { accountId: ALICE, id: thumbIdOf(result.id) })).rejects.toThrow(
      CryptoError,
    );
  });

  it('gives another person nothing of a file: not its bytes, not its removal, and not a second upload under its id', async () => {
    const result = await stored({ accountId: ALICE, kind: 'photo', bytes: await photo() });
    expect(await readMedia(deps, { accountId: BOB, id: result.id })).toBeUndefined();
    expect(await readMedia(deps, { accountId: BOB, id: thumbIdOf(result.id) })).toBeUndefined();
    expect(await deleteMedia(deps, { accountId: BOB, id: result.id })).toBe(false);
    expect(
      await putMedia(deps, { accountId: BOB, kind: 'photo', bytes: await photo(), id: result.id }),
    ).toEqual({ ok: false, reason: 'id_taken' });
    // Nothing changed for its owner, and nothing was written for the other.
    expect(await readMedia(deps, { accountId: ALICE, id: result.id })).toBeDefined();
    expect(await usageOf(deps.database, BOB)).toBe(0);
    // A file that is not there reads the same as one that is someone else's.
    expect(await readMedia(deps, { accountId: ALICE, id: randomUUID() })).toBeUndefined();
    expect(await readMedia(deps, { accountId: ALICE, id: '../secret' })).toBeUndefined();
  });

  it('is idempotent on an id the device made: a replay stores nothing twice and answers as the first did', async () => {
    const id = randomUUID();
    const bytes = await photo({ width: 200, height: 100 });
    const first = await stored({ accountId: ALICE, kind: 'photo', bytes, id });
    const usage = await usageOf(deps.database, ALICE);
    const again = await stored({ accountId: ALICE, kind: 'photo', bytes, id });
    expect(again).toMatchObject({ id, existing: true, thumbId: first.thumbId });
    expect(await usageOf(deps.database, ALICE)).toBe(usage);
    expect(filesOnDisk()).toHaveLength(2);
    expect(await dbAll(deps.database, sql`SELECT id FROM ${table()}`)).toHaveLength(2);
  });

  it('counts what an account keeps, thumbnails included, refuses what goes over the limit with a sentence, and frees the room when a file is deleted', async () => {
    const one = await stored({
      accountId: ALICE,
      kind: 'photo',
      bytes: await photo({ width: 800, height: 600 }),
    });
    const used = await usageOf(deps.database, ALICE);
    expect(used).toBe(one.bytes);
    expect(used).toBeGreaterThan(0);
    // Room for one more like it, and not two.
    deps = { ...deps, maxAccountBytes: used * 2 + 10 };
    const noisy = async () => {
      // Noise does not compress, so each is as large as the first.
      const raw = randomBytes(800 * 600 * 3);
      return sharp(raw, { raw: { width: 800, height: 600, channels: 3 } })
        .jpeg({ quality: 100 })
        .toBuffer();
    };
    deps = { ...deps, maxAccountBytes: used + 1000 };
    const refused = await putMedia(deps, { accountId: ALICE, kind: 'photo', bytes: await noisy() });
    expect(refused).toEqual({ ok: false, reason: 'over_limit' });
    expect(SENTENCES.over_limit).toMatch(/limit/);
    expect(SENTENCES.over_limit).not.toMatch(/over_limit|error/i);
    // Another account has a limit of its own.
    expect(
      await putMedia(deps, {
        accountId: BOB,
        kind: 'photo',
        bytes: await photo({ width: 100, height: 50 }),
      }),
    ).toMatchObject({ ok: true });
    // Deleting makes room again, and takes the thumbnail with it.
    expect(await deleteMedia(deps, { accountId: ALICE, id: one.id })).toBe(true);
    expect(await usageOf(deps.database, ALICE)).toBe(0);
    expect(
      await putMedia(deps, {
        accountId: ALICE,
        kind: 'photo',
        bytes: await photo({ width: 100, height: 50 }),
      }),
    ).toMatchObject({ ok: true });
    expect(await readMedia(deps, { accountId: ALICE, id: one.id })).toBeUndefined();
    expect(await readMedia(deps, { accountId: ALICE, id: thumbIdOf(one.id) })).toBeUndefined();
  });

  it('sweeps what a crash left: a row whose file never came and a file with no row, and nothing that is in use or still arriving', async () => {
    const kept = await stored({ accountId: ALICE, kind: 'photo', bytes: await photo() });
    // A row with no file, made a long time ago, and one made a moment ago (an upload in flight).
    const stale = randomUUID();
    const fresh = randomUUID();
    for (const [id, at] of [
      [stale, NOW - ORPHAN_GRACE_MS - 1],
      [fresh, NOW - 1000],
    ] as const)
      await dbRun(
        deps.database,
        sql`INSERT INTO ${table()} (id, account_id, kind, type, bytes, state, created_at) VALUES (${id}, ${ALICE}, 'photo', 'image/webp', 10, 'pending', ${at})`,
      );
    // Files with no row: an old one, a young one, and the temporary name of a write that died.
    const oldFile = randomUUID();
    const youngFile = randomUUID();
    writeFileSync(path.join(deps.dir, oldFile), 'x');
    writeFileSync(path.join(deps.dir, youngFile), 'x');
    writeFileSync(path.join(deps.dir, `.${randomUUID()}.1.1.tmp`), 'x');
    const old = new Date(((NOW - ORPHAN_GRACE_MS - 1000) / 1000) * 1000);
    clock = Date.now();
    const longAgo = new Date(clock - ORPHAN_GRACE_MS - 5000);
    utimesSync(path.join(deps.dir, oldFile), longAgo, longAgo);
    for (const name of readdirSync(deps.dir))
      if (name.endsWith('.tmp')) utimesSync(path.join(deps.dir, name), longAgo, longAgo);
    void old;
    // The rows above were made relative to NOW; the sweep's clock is now the real one, so re-date the stale row and keep the fresh one fresh.
    await dbRun(
      deps.database,
      sql`UPDATE ${table()} SET created_at = ${clock - ORPHAN_GRACE_MS - 1} WHERE id = ${stale}`,
    );
    await dbRun(
      deps.database,
      sql`UPDATE ${table()} SET created_at = ${clock - 1000} WHERE id = ${fresh}`,
    );
    await dbRun(
      deps.database,
      sql`UPDATE ${table()} SET created_at = ${clock - 1000} WHERE id IN (${kept.id}, ${thumbIdOf(kept.id)})`,
    );

    expect(await sweepOrphans(deps)).toEqual({ rows: 1, files: 2 });
    const rows = (await dbAll<{ id: string }>(deps.database, sql`SELECT id FROM ${table()}`)).map(
      (r) => r.id,
    );
    expect(rows).toContain(fresh);
    expect(rows).not.toContain(stale);
    expect(rows).toContain(kept.id);
    const names = filesOnDisk();
    expect(names).toContain(youngFile);
    expect(names).toContain(kept.id);
    expect(names).not.toContain(oldFile);
    expect(names.filter((name) => name.endsWith('.tmp'))).toEqual([]);
    // And again: nothing is left to find.
    expect(await sweepOrphans(deps)).toEqual({ rows: 0, files: 0 });
  });
});
