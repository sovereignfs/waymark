import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type KeyRing, ringOf } from '../crypto/keys';
import { Sealer } from '../crypto/sealed';
import type { Database } from '../db/client';
import { dbAll } from '../db/exec';
import { makeStore, testTarget } from '../db/test-support';
import { listNotices } from '../notices/notices';
import { applyMutation } from '../sync/apply';
import { hasImport, writeImport } from './files';
import {
  type CheckinsRead,
  type ImportDeps,
  type ImportItem,
  type ImportReader,
  LEASE_MS,
  STEP_ITEMS,
  applyBatch,
  claimImport,
  idFor,
  workOnImports,
} from './job';
import {
  cancelImport,
  createImport,
  deleteImportsOf,
  importDirBeside,
  listImportsOf,
  sweepImports,
} from './service';

/**
 * The import job (DESIGN.md §16), on whichever database the leg runs on, with a reader of our own that reads a JSON list: carried out through the one write path, resumable from its cursor, once for any
 * number of workers, cancellable, and never twice. A real service's reader is 8.2's.
 */
const { leg } = testTarget();
const made = ringOf(randomBytes(32));
if (!made) throw new Error('no ring');
const ring: KeyRing = made;
const sealer = new Sealer(ring);
const NOW = 1_800_000_000_000;
const ADA = 'ada-account';
const GRACE = 'grace-account';

let database: Database;
let close: () => Promise<void>;
let directory: string;
let deps: ImportDeps;
let cursorsRead: number[] = [];
let onStep: (cursor: number) => void | Promise<void> = () => undefined;
let failWith: Error | undefined;

/** A reader of a file that is a JSON list of items: it reads the whole (small) file from the sealed store, so the file matters, and gives the batch after the cursor. */
const reader: ImportReader = {
  source: 'swarm',
  async open(file) {
    return {
      async checkins({ cursor, limit }): Promise<CheckinsRead> {
        cursorsRead.push(cursor);
        await onStep(cursor);
        if (failWith) throw failWith;
        const chunks: Buffer[] = [];
        for await (const chunk of file.stream()) chunks.push(chunk);
        const all = JSON.parse(Buffer.concat(chunks).toString('utf8')) as ImportItem[];
        const items = all.slice(cursor, cursor + limit);
        return { items, cursor: cursor + items.length, done: cursor + items.length >= all.length };
      },
      close: async () => undefined,
    };
  },
};

beforeAll(async () => {
  ({ database, close } = await makeStore());
  directory = mkdtempSync(path.join(tmpdir(), 'waymark-import-job-'));
  deps = {
    database,
    sealer,
    ring,
    dir: path.join(directory, 'imports'),
    workDir: path.join(directory, 'work'),
    now: () => NOW,
    readers: { swarm: reader },
  };
});
afterAll(async () => {
  await close();
  rmSync(directory, { recursive: true, force: true });
});
beforeEach(async () => {
  cursorsRead = [];
  onStep = () => undefined;
  failWith = undefined;
  // Each test starts with no import of anyone's waiting, and no file.
  rmSync(deps.dir, { recursive: true, force: true });
  await dbAll(database, sql`DELETE FROM ${named('import_job')} RETURNING id`);
});

const named = (name: string) => sql.raw(database.dialect === 'postgres' ? `waymark.${name}` : name);
const VENUES = Array.from({ length: 7 }, (_, i) => ({
  sourceId: `venue-${i}`,
  name: `Venue ${i}`,
  lat: 38.7 + i / 100,
  lng: -9.1,
  category: i % 2 ? 'Cafe' : 'Bar',
}));
const items = (count: number, prefix = 'c'): ImportItem[] =>
  Array.from({ length: count }, (_, i) => ({
    externalId: `${prefix}${i}`,
    at: 1_700_000_000_000 + i * 3_600_000,
    note: `note ${i}`,
    companions: i % 5 === 0 ? ['Grace'] : [],
    place: VENUES[i % VENUES.length] as ImportItem['place'],
  }));
const upload = (accountId: string, list: unknown) =>
  createImport(deps, {
    accountId,
    source: 'swarm',
    body: (async function* () {
      yield Buffer.from(typeof list === 'string' ? list : JSON.stringify(list));
    })(),
  });
async function uploaded(accountId: string, list: unknown): Promise<string> {
  const result = await upload(accountId, list);
  if (!result.ok) throw new Error(`upload refused: ${result.reason}`);
  return result.id;
}
const count = async (table: string, accountId: string, extra = '') =>
  Number(
    (
      await dbAll<{ n: number | string }>(
        database,
        sql.raw(
          `SELECT COUNT(*) AS n FROM ${database.dialect === 'postgres' ? `waymark.${table}` : table} WHERE account_id = '${accountId}' ${extra}`,
        ),
      )
    )[0]?.n ?? 0,
  );
const job = async (id: string) =>
  (await listImportsOf(deps, ADA, 50)).find((each) => each.id === id);
const jobOf = async (accountId: string, id: string) =>
  (await listImportsOf(deps, accountId, 50)).find((each) => each.id === id);

describe(`importing (${leg})`, () => {
  it('makes a place for each venue and a check-in for each item, through the write path, with the service’s own ids; 60 items are three steps; the file goes, and the person is told once', async () => {
    const id = await uploaded(ADA, items(60));
    expect(await hasImport(deps.dir, id)).toBe(true);
    expect(await workOnImports(deps)).toEqual({ ended: 1 });
    expect(cursorsRead).toEqual([0, STEP_ITEMS, STEP_ITEMS * 2]);

    expect(await job(id)).toMatchObject({
      status: 'done',
      checkinsDone: 60,
      checkinsSkipped: 0,
      placesMade: 7,
    });
    expect(await count('checkin', ADA, "AND source = 'import:swarm'")).toBe(60);
    expect(await count('place', ADA, "AND source = 'import'")).toBe(7);
    expect(await count('checkin', ADA, 'AND external_id IS NOT NULL')).toBe(60);
    // Ids made from the service's own, so they are the same on every run.
    expect(await count('checkin', ADA, `AND id = '${idFor('checkin', ADA, 'c0')}'`)).toBe(1);
    // The file is deleted, and the person has one notice, which says what happened and opens their check-ins.
    expect(await hasImport(deps.dir, id)).toBe(false);
    const told = (await listNotices(deps, ADA)).filter((each) => each.kind === 'import_finished');
    expect(told).toHaveLength(1);
    expect(told[0]).toMatchObject({ title: 'Your import has finished', href: '/checkins' });
    expect(told[0]?.detail).toContain('60 check-ins were added');
  });

  it('goes through the same write path as a device: the stream numbers each change, so another device pulls them', async () => {
    const before = Number(
      (
        await dbAll<{ seq: number | string }>(
          database,
          sql`SELECT seq FROM ${named('account_stream')} WHERE account_id = ${GRACE}`,
        )
      )[0]?.seq ?? 0,
    );
    await uploaded(GRACE, items(10, 'g'));
    await workOnImports(deps);
    const after = Number(
      (
        await dbAll<{ seq: number | string }>(
          database,
          sql`SELECT seq FROM ${named('account_stream')} WHERE account_id = ${GRACE}`,
        )
      )[0]?.seq ?? 0,
    );
    // Seven places and ten check-ins.
    expect(after - before).toBe(17);
  });

  it('creates nothing a second time, by another import of the same file, and leaves what the person changed since as they changed it', async () => {
    await uploaded(ADA, items(10, 'again'));
    await workOnImports(deps);
    const checkins = await count('checkin', ADA);
    const places = await count('place', ADA);
    // The person renames a place and deletes a check-in.
    const placeId = idFor('place', ADA, 'venue-0');
    const renamed = await applyMutation(deps, ADA, {
      mutationId: 'rename-1',
      stream: 'account',
      changes: [
        {
          table: 'place',
          op: 'put',
          id: placeId,
          row: {
            name: 'My own name for it',
            lat: 38.7,
            lng: -9.1,
            source: 'import',
            tz: 'Europe/Lisbon',
            countryCode: null,
          },
        },
      ],
    });
    expect(renamed.status).toBe('applied');
    const gone = idFor('checkin', ADA, 'again3');
    expect(
      (
        await applyMutation(deps, ADA, {
          mutationId: 'delete-1',
          stream: 'account',
          changes: [{ table: 'checkin', op: 'delete', id: gone }],
        })
      ).status,
    ).toBe('applied');

    const second = await uploaded(ADA, items(10, 'again'));
    await workOnImports(deps);
    expect(await job(second)).toMatchObject({
      status: 'done',
      checkinsDone: 0,
      checkinsSkipped: 10,
      placesMade: 0,
    });
    // Nothing made, the deleted one not brought back, the rename kept.
    expect(await count('checkin', ADA)).toBe(checkins - 1);
    expect(await count('place', ADA)).toBe(places);
    const { getPlace } = await import('../places/places');
    expect((await getPlace(deps, ADA, placeId))?.name).toBe('My own name for it');
  });

  it('skips an item that is not a place or a check-in, counts it, and goes on with the rest', async () => {
    const list = items(6, 'bad').map((item, i) =>
      i === 1
        ? { ...item, place: { ...item.place, lat: 999 } }
        : i === 3
          ? { ...item, externalId: '' }
          : i === 4
            ? { ...item, at: NOW + 86_400_000 }
            : item,
    );
    const id = await uploaded(ADA, list);
    await workOnImports(deps);
    expect(await job(id)).toMatchObject({ status: 'done', checkinsDone: 3, checkinsSkipped: 3 });
  });
});

describe(`a line on the activity page at a core (${leg})`, () => {
  it('is queued with the end of an import when the people here sign in through a core, and not otherwise', async () => {
    const before = await count('core_outbox', ADA);
    await uploaded(ADA, items(3, 'act'));
    await workOnImports(deps);
    expect(await count('core_outbox', ADA)).toBe(before);
    await uploaded(ADA, items(4, 'act2'));
    await workOnImports({ ...deps, delivery: () => ({ core: true as const }) });
    // The notice's two (core's bell and core's email) and the line on the activity page.
    expect(await count('core_outbox', ADA)).toBe(before + 3);
    const kinds = await dbAll<{ kind: string }>(
      database,
      sql`SELECT kind FROM ${named('core_outbox')} WHERE account_id = ${ADA}`,
    );
    expect(kinds.map((k) => k.kind).sort()).toEqual(['activity', 'email', 'notification']);
  });
});

describe(`resuming (${leg})`, () => {
  it('carries on from the cursor after a stop, reading nothing twice, and the whole is made once', async () => {
    const id = await uploaded(ADA, items(80, 'r'));
    // The process is told to stop during the second step: it finishes that step and gives the lease up.
    const stop = new AbortController();
    onStep = (cursor) => {
      if (cursor === STEP_ITEMS) stop.abort();
    };
    expect(await workOnImports(deps, { signal: stop.signal })).toEqual({ ended: 0 });
    expect(cursorsRead).toEqual([0, STEP_ITEMS]);
    expect(await job(id)).toMatchObject({ status: 'running', checkinsDone: 50 });
    expect(await hasImport(deps.dir, id)).toBe(true);

    // After a restart: the next run takes it, at the cursor.
    cursorsRead = [];
    onStep = () => undefined;
    expect(await workOnImports(deps)).toEqual({ ended: 1 });
    expect(cursorsRead).toEqual([STEP_ITEMS * 2, STEP_ITEMS * 3]);
    expect(await job(id)).toMatchObject({ status: 'done', checkinsDone: 80 });
    expect(await count('checkin', ADA, "AND external_id LIKE 'r%'")).toBe(80);
  });

  it('applies a batch whose worker died before moving the cursor a second time and writes nothing twice', async () => {
    const id = await uploaded(ADA, items(60, 'k'));
    const claimed = await claimImport(deps);
    if (!claimed) throw new Error('nothing claimed');
    // The first worker applied the first batch and died before it wrote the cursor.
    const first = await applyBatch(deps, claimed, 0, items(60, 'k').slice(0, STEP_ITEMS));
    expect(first).toMatchObject({ checkins: STEP_ITEMS });
    await dbAll(
      database,
      sql`UPDATE ${named('import_job')} SET claimed_until = 0 WHERE id = ${id} RETURNING id`,
    );
    cursorsRead = [];
    expect(await workOnImports(deps)).toEqual({ ended: 1 });
    // It started from the cursor the dead worker left, 0, and made the 60 once.
    expect(cursorsRead[0]).toBe(0);
    expect(await count('checkin', ADA, "AND external_id LIKE 'k%'")).toBe(60);
    expect(await job(id)).toMatchObject({ status: 'done', checkinsDone: 35, checkinsSkipped: 25 });
    // A replay of the very mutation writes nothing either.
    const replay = await applyBatch(deps, claimed, 0, items(60, 'k').slice(0, STEP_ITEMS));
    expect(replay.checkins).toBe(0);
  });

  it('is worked by one of two workers that run at the same time, each step once', async () => {
    const id = await uploaded(ADA, items(100, 'w'));
    await Promise.all([workOnImports(deps), workOnImports(deps)]);
    expect(await job(id)).toMatchObject({ status: 'done', checkinsDone: 100 });
    expect(new Set(cursorsRead).size).toBe(cursorsRead.length);
    expect(cursorsRead).toEqual([0, 25, 50, 75]);
  });

  it('does not take an import another worker holds, and takes it when the lease has ended', async () => {
    const id = await uploaded(ADA, items(5, 'l'));
    const held = await claimImport(deps);
    expect(held?.id).toBe(id);
    expect(await claimImport(deps)).toBeUndefined();
    expect(await workOnImports(deps)).toEqual({ ended: 0 });
    const later: ImportDeps = { ...deps, now: () => NOW + LEASE_MS + 1 };
    expect((await claimImport(later))?.id).toBe(id);
  });
});

describe(`cancelling and failing (${leg})`, () => {
  it('stops at the next step when cancelled, deletes the file, keeps what was imported, and raises no notice', async () => {
    const id = await uploaded(ADA, items(80, 'x'));
    onStep = async (cursor) => {
      if (cursor === STEP_ITEMS) expect(await cancelImport(deps, ADA, id)).toBe(true);
    };
    expect(await workOnImports(deps)).toEqual({ ended: 1 });
    expect(await job(id)).toMatchObject({ status: 'cancelled' });
    expect(await hasImport(deps.dir, id)).toBe(false);
    expect(await count('checkin', ADA, "AND external_id LIKE 'x%'")).toBeLessThanOrEqual(50);
    expect(await count('checkin', ADA, "AND external_id LIKE 'x%'")).toBeGreaterThanOrEqual(25);
    expect(cursorsRead).toEqual([0, STEP_ITEMS]);
  });

  it('cancels one that is waiting and has not begun, and cancels once', async () => {
    const id = await uploaded(ADA, items(5, 'q'));
    expect(await cancelImport(deps, ADA, id)).toBe(true);
    expect(await cancelImport(deps, ADA, id)).toBe(false);
    expect(await hasImport(deps.dir, id)).toBe(false);
    expect(await workOnImports(deps)).toEqual({ ended: 0 });
    expect(cursorsRead).toEqual([]);
  });

  it('is not another person’s to cancel or see', async () => {
    const id = await uploaded(ADA, items(5, 'p'));
    expect(await cancelImport(deps, GRACE, id)).toBe(false);
    expect(await jobOf(GRACE, id)).toBeUndefined();
    expect(await job(id)).toMatchObject({ status: 'queued' });
    expect(await hasImport(deps.dir, id)).toBe(true);
  });

  it('fails with a sentence of ours when the reader cannot read the file, deletes it, and tells the person; nothing of the file or the error is kept', async () => {
    const id = await uploaded(ADA, items(5, 'f'));
    failWith = new Error('line 3: Zxqv Cafe has no coordinates');
    expect(await workOnImports(deps)).toEqual({ ended: 1 });
    const view = await job(id);
    expect(view).toMatchObject({ status: 'failed', checkinsDone: 0 });
    expect(view?.errors[0]?.sentence).toContain('could not be read');
    expect(JSON.stringify(view)).not.toContain('Zxqv');
    expect(await hasImport(deps.dir, id)).toBe(false);
    const told = (await listNotices(deps, ADA)).find(
      (each) => each.title === 'Your import could not be finished',
    );
    expect(told).toBeDefined();
    expect(JSON.stringify(told)).not.toContain('Zxqv');
    const raw = await dbAll<Record<string, unknown>>(
      database,
      sql`SELECT * FROM ${named('import_job')} WHERE id = ${id}`,
    );
    expect(
      Buffer.from(raw[0]?.sealed as Uint8Array).includes(Buffer.from('could not be read')),
    ).toBe(false);
  });

  it('fails an import whose service has no reader on this server', async () => {
    const id = await uploaded(ADA, items(2, 'u'));
    const without: ImportDeps = { ...deps, readers: {} };
    expect(await workOnImports(without)).toEqual({ ended: 1 });
    expect((await job(id))?.errors[0]?.sentence).toContain('not available');
  });
});

describe(`uploading (${leg})`, () => {
  it('refuses a service with no reader, a second import while one is waiting, a file that is too big and one that is empty, storing nothing', async () => {
    expect(
      await createImport(
        { ...deps, readers: {} },
        {
          accountId: ADA,
          source: 'swarm',
          body: (async function* () {
            yield Buffer.from('x');
          })(),
        },
      ),
    ).toEqual({ ok: false, reason: 'unavailable' });
    await uploaded(ADA, items(2, 'o'));
    expect(await upload(ADA, items(2, 'o2'))).toEqual({ ok: false, reason: 'busy' });
    // Another person is not held up by it.
    expect((await upload(GRACE, items(2, 'o3'))).ok).toBe(true);
    await dbAll(database, sql`DELETE FROM ${named('import_job')} RETURNING id`);
    const big = await createImport(deps, {
      accountId: ADA,
      source: 'swarm',
      maxBytes: 10,
      body: (async function* () {
        yield Buffer.alloc(11);
      })(),
    });
    expect(big).toEqual({ ok: false, reason: 'too_big' });
    expect(await upload(ADA, '')).toEqual({ ok: false, reason: 'empty' });
    expect(await listImportsOf(deps, ADA)).toEqual([]);
  });
});

describe(`what is left (${leg})`, () => {
  it('removes an import’s files and rows with the person, and no one else’s, and again changes nothing', async () => {
    const a = await uploaded(ADA, items(2, 'd'));
    const g = await uploaded(GRACE, items(2, 'e'));
    expect(await deleteImportsOf({ database, dir: deps.dir }, ADA)).toBe(1);
    expect(await deleteImportsOf({ database, dir: deps.dir }, ADA)).toBe(0);
    expect(await hasImport(deps.dir, a)).toBe(false);
    expect(await hasImport(deps.dir, g)).toBe(true);
    expect(await jobOf(GRACE, g)).toBeDefined();
    expect(importDirBeside(path.join('/data', 'media'))).toBe(path.join('/data', 'imports'));
  });

  it('sweeps a file no row names once it is an hour old, an import whose file is gone, and finished imports older than 90 days', async () => {
    // A file with no row.
    const stray = '11111111-1111-4111-8111-111111111111';
    await writeImport(
      deps.dir,
      stray,
      (async function* () {
        yield Buffer.from('x');
      })(),
      ring,
    );
    const soon = await sweepImports({ database, dir: deps.dir, now: () => Date.now() });
    expect(soon.files).toBe(0);
    const later = { database, dir: deps.dir, now: () => Date.now() + 2 * 3_600_000 };
    // An import waiting whose file has been lost.
    const lost = await uploaded(ADA, items(2, 'z'));
    await dbAll(database, sql`SELECT 1`);
    const { removeImport } = await import('./files');
    await removeImport(deps.dir, lost);
    const swept = await sweepImports(later);
    expect(swept.files).toBe(1);
    expect(existsSync(path.join(deps.dir, stray))).toBe(false);
    expect(swept.orphaned).toBe(1);
    expect((await job(lost))?.status).toBe('failed');
    // A finished one past ninety days.
    const old = { database, dir: deps.dir, now: () => Date.now() + 100 * 86_400_000 };
    expect((await sweepImports(old)).pruned).toBeGreaterThanOrEqual(1);
    expect(await job(lost)).toBeUndefined();
  });
});
