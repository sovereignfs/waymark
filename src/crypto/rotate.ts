import { sql } from 'drizzle-orm';
import { fingerprintOfEnvelope, rewrapBytes } from './envelope';
import type { KeyEntry, KeyRing } from './keys';
import { rowBinding, type SealedTable } from './sealed';
import type { Database } from '../db/client';
import { APP_STORE } from '../db/config';
import { dbAll } from '../db/exec';
import * as postgresSchema from '../db/schema/postgres';
import * as sqliteSchema from '../db/schema/sqlite';
import { rewrapImportFile, listImports } from '../import/files';
import { isFileId, listFiles, rewrapFile } from '../media/files';

/**
 * **Rotating the instance key** (DESIGN.md §18.1, 3.3): a new `WAYMARK_ENCRYPTION_KEY`, with the old one given as `WAYMARK_ENCRYPTION_KEY_PREVIOUS` beside it, and a job that moves everything sealed from the old to the new
 * **without opening any of it**: an envelope is a data key wrapped under the instance key and a payload sealed under the data key, so only the wrapping is done again, bound to the same row or file, and the payload,
 * which is most of the bytes, is not read. The job:
 *
 *  1. walks the `sealed` column of every table that has one, in the order of its key, a batch at a time, and replaces an envelope that names the old key by one that names the new, **only if the row is still as it
 *     was read** (its `version`, or `updated_at`, is what it was: a plain column, since the envelope itself is never in a condition), so a row written meanwhile (which is sealed under the new key already) is never
 *     overwritten with an older version;
 *  2. then the files under `/data/media`, and the sealed files of imports and exports (which are chunked and are moved a chunk at a time), each replaced only if it was not written meanwhile;
 *  3. keeps where it has got to in `key_rotation` after every batch, so **a stop, a crash or a deploy carries on from there** and not from the start, and a second process does not run at once (a lease);
 *  4. says when it is **done**, which is the person's cue that the previous key can be removed, and **counts what it could not open** (sealed under a key that is neither of the two) without stopping.
 *
 * What is written is new bytes for the same thing: nothing a person typed or uploaded is read, changed or logged, and nothing here logs more than counts and fingerprints. Rotating again before a rotation is done leaves
 * what is still under the first key unopenable (the ring holds only two), which is why health says a rotation is under way until it is complete.
 */
export interface RotateDeps {
  readonly database: Database;
  readonly ring: KeyRing;
  /** `<data>/media`, `<data>/imports` and `<data>/exports`. */
  readonly dirs: { readonly media: string; readonly imports: string; readonly exports: string };
  readonly now: () => number;
  /** For a test: called after a batch of rows has been read and before it is written, to write one of them in between, as a person might. */
  readonly afterRead?: (table: SealedTable) => Promise<void>;
}

/** The tables with a sealed column, each by the column that names its rows and what the envelope is bound to. */
export const ROW_PHASES: readonly { table: SealedTable; key: string; guard?: string }[] = [
  // `guard` is a plain column that changes whenever the row is written, so that an envelope is replaced only if the row is as it was read. A table whose envelope is never rewritten after it is made has none.
  { table: 'profile', key: 'account_id', guard: 'updated_at' },
  { table: 'place', key: 'id', guard: 'version' },
  { table: 'checkin', key: 'id', guard: 'version' },
  { table: 'notice', key: 'id' },
  { table: 'mail_outbox', key: 'id' },
  { table: 'core_outbox', key: 'id' },
  { table: 'import_job', key: 'id', guard: 'updated_at' },
];
export const FILE_PHASES = ['media', 'imports', 'exports'] as const;
export const PHASES: readonly string[] = [...ROW_PHASES.map((p) => p.table), ...FILE_PHASES];

export const BATCH = 200;

const rotationTable = (database: Database) =>
  database.dialect === 'postgres' ? postgresSchema.keyRotation : sqliteSchema.keyRotation;
const tableName = (database: Database, name: string) =>
  sql.raw(database.dialect === 'postgres' ? `"${APP_STORE}"."${name}"` : `"${name}"`);

export interface Rotation {
  readonly state: 'none' | 'running' | 'done';
  readonly rewrapped: number;
  readonly unopenable: number;
}

interface State {
  phase: string;
  after: string;
  rewrapped: number;
  unopenable: number;
  done: boolean;
}

/** Where a rotation to the ring's current key is, or `none` when no previous key is given (nothing is being rotated). Cheap: one row. */
export async function rotationOf(database: Database, ring: KeyRing): Promise<Rotation> {
  if (!ring.previous) return { state: 'none', rewrapped: 0, unopenable: 0 };
  const rows = await dbAll<{
    state: string;
    rewrapped: number | string;
    unopenable: number | string;
  }>(
    database,
    sql`SELECT state, rewrapped, unopenable FROM ${rotationTable(database)} WHERE fingerprint = ${ring.current.fingerprint}`,
  );
  const row = rows[0];
  // A previous key is given and nothing has been done yet: it is under way as soon as the job runs.
  if (!row) return { state: 'running', rewrapped: 0, unopenable: 0 };
  return {
    state: row.state === 'done' ? 'done' : 'running',
    rewrapped: Number(row.rewrapped),
    unopenable: Number(row.unopenable),
  };
}

async function load(deps: RotateDeps, previous: KeyEntry): Promise<State> {
  const fingerprint = deps.ring.current.fingerprint;
  const rows = await dbAll<{
    state: string;
    phase: string;
    after: string;
    rewrapped: number | string;
    unopenable: number | string;
  }>(
    deps.database,
    sql`SELECT state, phase, "after", rewrapped, unopenable FROM ${rotationTable(deps.database)} WHERE fingerprint = ${fingerprint}`,
  );
  const row = rows[0];
  if (row)
    return {
      phase: row.phase,
      after: row.after,
      rewrapped: Number(row.rewrapped),
      unopenable: Number(row.unopenable),
      done: row.state === 'done',
    };
  await dbAll(
    deps.database,
    sql`INSERT INTO ${rotationTable(deps.database)} (fingerprint, previous_fingerprint, state, phase, "after", rewrapped, unopenable, started_at, updated_at)
        VALUES (${fingerprint}, ${previous.fingerprint}, 'running', ${PHASES[0] ?? ''}, '', 0, 0, ${deps.now()}, ${deps.now()})
        ON CONFLICT (fingerprint) DO NOTHING RETURNING fingerprint`,
  );
  return { phase: PHASES[0] ?? '', after: '', rewrapped: 0, unopenable: 0, done: false };
}

async function save(deps: RotateDeps, state: State): Promise<void> {
  await dbAll(
    deps.database,
    sql`UPDATE ${rotationTable(deps.database)}
        SET phase = ${state.phase}, "after" = ${state.after}, rewrapped = ${state.rewrapped}, unopenable = ${state.unopenable},
            state = ${state.done ? 'done' : 'running'}, updated_at = ${deps.now()},
            finished_at = ${state.done ? deps.now() : null}
        WHERE fingerprint = ${deps.ring.current.fingerprint} RETURNING fingerprint`,
  );
}

/** One batch of one table: returns the last key it read (or undefined at the end of the table) and how many it moved and could not open. */
async function rowBatch(
  deps: RotateDeps,
  phase: (typeof ROW_PHASES)[number],
  after: string,
  from: KeyEntry,
  size: number,
): Promise<{ last: string | undefined; moved: number; unopenable: number }> {
  const t = tableName(deps.database, phase.table);
  const key = sql.raw(`"${phase.key}"`);
  const guard = phase.guard ? sql.raw(`"${phase.guard}"`) : sql.raw('1');
  const rows = await dbAll<{
    id: string;
    sealed: Uint8Array | ArrayBuffer | null;
    guard: number | string;
  }>(
    deps.database,
    sql`SELECT ${key} AS id, sealed, ${guard} AS guard FROM ${t} WHERE ${key} > ${after} ORDER BY ${key} LIMIT ${size}`,
  );
  await deps.afterRead?.(phase.table);
  let moved = 0;
  let unopenable = 0;
  for (const row of rows) {
    // An import's own row has no envelope until something goes wrong with it.
    if (row.sealed === null || row.sealed === undefined) continue;
    const envelope = Buffer.from(
      row.sealed instanceof Uint8Array ? row.sealed : new Uint8Array(row.sealed as ArrayBuffer),
    );
    const fingerprint = fingerprintOfEnvelope(envelope);
    if (fingerprint === deps.ring.current.fingerprint) continue;
    if (fingerprint !== from.fingerprint) {
      unopenable += 1;
      continue;
    }
    let next: Buffer;
    try {
      next = rewrapBytes(envelope, rowBinding(phase.table, row.id), from, deps.ring.current);
    } catch {
      unopenable += 1;
      continue;
    }
    // Only if the row is still as it was read: one written meanwhile is under the new key already, and is not replaced with an older version.
    const done = await dbAll<{ id: string }>(
      deps.database,
      phase.guard
        ? sql`UPDATE ${t} SET sealed = ${next} WHERE ${key} = ${row.id} AND ${guard} = ${row.guard} RETURNING ${key} AS id`
        : sql`UPDATE ${t} SET sealed = ${next} WHERE ${key} = ${row.id} RETURNING ${key} AS id`,
    );
    moved += done.length;
  }
  return { last: rows.length === size ? rows[rows.length - 1]?.id : undefined, moved, unopenable };
}

async function fileBatch(
  deps: RotateDeps,
  phase: (typeof FILE_PHASES)[number],
  after: string,
  from: KeyEntry,
  size: number,
): Promise<{ last: string | undefined; moved: number; unopenable: number }> {
  const dir = deps.dirs[phase];
  const names =
    phase === 'media'
      ? (await listFiles(dir)).map((file) => file.name).filter((name) => isFileId(name))
      : await listImports(dir);
  const todo = names
    .filter((name) => name > after)
    .sort()
    .slice(0, BATCH);
  let moved = 0;
  let unopenable = 0;
  for (const name of todo) {
    const verdict =
      phase === 'media'
        ? await rewrapFile(dir, name, from, deps.ring.current)
        : await rewrapImportFile(dir, name, from, deps.ring.current);
    if (verdict === 'moved') moved += 1;
    if (verdict === 'unknown') unopenable += 1;
  }
  return { last: todo.length === size ? todo[todo.length - 1] : undefined, moved, unopenable };
}

/**
 * Works the rotation for up to `budgetMs` (or `maxBatches` batches, which a test uses to stop it half way), from where it left off. Does nothing when no previous key is given, and when the rotation to this key is done. Returns the state it leaves. Safe to run from two
 * processes (the job holds a lease), and safe to run again: an envelope already under the new key is left as it is.
 */
export async function rotateKeys(
  deps: RotateDeps,
  options: { budgetMs?: number; maxBatches?: number; batch?: number } = {},
): Promise<Rotation> {
  const size = options.batch ?? BATCH;
  let batches = 0;
  const previous = deps.ring.previous;
  if (!previous) return { state: 'none', rewrapped: 0, unopenable: 0 };
  const state = await load(deps, previous);
  if (state.done)
    return { state: 'done', rewrapped: state.rewrapped, unopenable: state.unopenable };
  const until = deps.now() + (options.budgetMs ?? 20_000);
  let index = Math.max(0, PHASES.indexOf(state.phase));
  while (
    index < PHASES.length &&
    deps.now() < until &&
    batches < (options.maxBatches ?? Infinity)
  ) {
    batches += 1;
    const name = PHASES[index] as string;
    const rows = ROW_PHASES.find((phase) => phase.table === name);
    const batch = rows
      ? await rowBatch(deps, rows, state.after, previous, size)
      : await fileBatch(deps, name as (typeof FILE_PHASES)[number], state.after, previous, size);
    state.rewrapped += batch.moved;
    state.unopenable += batch.unopenable;
    if (batch.last === undefined) {
      // The end of this table or directory: the next begins at its start.
      index += 1;
      state.phase = PHASES[index] ?? name;
      state.after = '';
      if (index >= PHASES.length) state.done = true;
    } else {
      state.after = batch.last;
    }
    await save(deps, state);
  }
  return {
    state: state.done ? 'done' : 'running',
    rewrapped: state.rewrapped,
    unopenable: state.unopenable,
  };
}
