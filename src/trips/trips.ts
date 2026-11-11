import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { MEMBERS, ORGANIZERS, memberOf, tableOf } from '../access/trip';
import { visibleProfile } from '../access/visibility';
import type { LimitSettings } from '../config';
import type { Sealer } from '../crypto/sealed';
import type { Database } from '../db/client';
import { dbAll, dbGet, transaction } from '../db/exec';
import { removeFile } from '../media/files';
import type { MediaDeps } from '../media/service';
import type { Delivery } from '../notices/notices';
import { getProfile } from '../profile/profile';
import { notifyMembers } from './notify';
import { type TripStatus, statusOf } from './status';
import {
  type Role,
  type TripColor,
  TRIP_ID,
  TripError,
  cleanTripColor,
  cleanTripDescription,
  cleanTripName,
} from './format';

/**
 * A person's trips (DESIGN.md §10.1, §11.1): made, read, renamed, recoloured, described and deleted. **Every statement names the caller's membership and the role it needs** (`src/access/trip.ts`), as a condition of the
 * statement itself: a trip the caller is not in is a trip that is not there, and so is one they are in with too little of a role, and the answer for each is the answer for none. The creator is the first Organizer, and a trip
 * always has one (changing roles, leaving and removing are 10.1 and 10.4).
 *
 * **What a trip is called is sealed** (`SEALED.trip`: the name and the description): this file is the only one that writes or reads `trip.sealed`.
 */
export interface Trip {
  readonly id: string;
  readonly name: string;
  readonly description: string | undefined;
  readonly color: TripColor;
  /** Computed from `readyAt`, the dates and now, in the first stop's zone, and never stored (DESIGN.md §10.2). */
  readonly status: TripStatus;
  /** Planning, with dates that are already over: it can still be marked ready, to reach its journal. */
  readonly datesPassed: boolean;
  /** Derived from the trip's stops (9.2): null until it has one. */
  readonly startDate: string | null;
  readonly endDate: string | null;
  /** When an Organizer marked it ready (9.4). Status is computed from this and the dates, and never stored. */
  readonly readyAt: number | null;
  readonly coverPlaceId: string | null;
  readonly createdBy: string | null;
  readonly seq: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** A trip as the caller has it: with their own part in it. */
export interface TripView extends Trip {
  readonly role: Role;
  readonly going: boolean;
}

/** A member as the caller may see them: a name for every member, an address only where DESIGN.md §6.1 allows it. */
export interface MemberView {
  readonly accountId: string;
  readonly name: string;
  readonly email?: string;
  readonly role: Role;
  readonly going: boolean;
  readonly joinedAt: number;
  readonly self: boolean;
}

export interface TripDeps {
  readonly database: Database;
  readonly sealer: Sealer;
  readonly now: () => number;
  readonly limits: LimitSettings;
  /** How notices also reach people on this server; absent, the bell alone. */
  readonly delivery?: (() => Delivery) | undefined;
  /** The media store, whose files go with a trip's attachments. Absent where nothing stores files (the files, if there are any, are found by the orphan sweep). */
  readonly media?: MediaDeps | undefined;
}

interface TripRow {
  id: string;
  color: string;
  startDate: string | null;
  endDate: string | null;
  readyAt: number | string | null;
  coverPlaceId: string | null;
  createdBy: string | null;
  seq: number | string;
  sealed: Uint8Array | ArrayBuffer;
  createdAt: number | string;
  updatedAt: number | string;
  /** The zone of the first stop that has dates: the one the trip's status is decided in. */
  firstZone: string | null;
}

/** The columns of a trip, and **the zone of its first dated stop**, which its status is decided in (a scalar subquery, so a list needs no join). */
const columnsOf = (database: Database) =>
  sql.raw(
    `t.id, t.color, t.start_date AS "startDate", t.end_date AS "endDate", t.ready_at AS "readyAt", t.cover_place_id AS "coverPlaceId", t.created_by AS "createdBy", t.seq, t.sealed, t.created_at AS "createdAt", t.updated_at AS "updatedAt",
     (SELECT p.tz FROM ${database.dialect === 'postgres' ? 'waymark.stop' : 'stop'} s JOIN ${database.dialect === 'postgres' ? 'waymark.place' : 'place'} p ON p.id = s.place_id AND p.trip_id = s.trip_id
      WHERE s.trip_id = t.id AND s.arrive IS NOT NULL ORDER BY s.arrive, s.depart, s.position, s.id LIMIT 1) AS "firstZone"`,
  );

const bytes = (value: Uint8Array | ArrayBuffer): Uint8Array =>
  value instanceof Uint8Array ? value : new Uint8Array(value);

function tripOf(deps: TripDeps, row: TripRow): Trip {
  const fields = deps.sealer.unseal('trip', row.id, bytes(row.sealed));
  const readyAt = row.readyAt === null ? null : Number(row.readyAt);
  const decided = statusOf(
    { readyAt, startDate: row.startDate, endDate: row.endDate },
    deps.now(),
    row.firstZone,
  );
  return {
    id: row.id,
    name: fields.name,
    description: fields.description,
    color: row.color as TripColor,
    status: decided.status,
    datesPassed: decided.datesPassed,
    startDate: row.startDate,
    endDate: row.endDate,
    readyAt,
    coverPlaceId: row.coverPlaceId,
    createdBy: row.createdBy,
    seq: Number(row.seq),
    createdAt: Number(row.createdAt),
    updatedAt: Number(row.updatedAt),
  };
}

const sealedFields = (name: string, description: string | undefined) => ({
  name,
  ...(description ? { description } : {}),
});

/** The server would not take what was asked, and says why in a sentence of its own (never repeating what was typed). */
export class LimitReached extends Error {
  override name = 'LimitReached';
  constructor(readonly sentence: string) {
    super('a limit was reached');
  }
}

export interface NewTrip {
  readonly name: unknown;
  readonly description?: unknown;
  readonly color?: unknown;
}

/**
 * Makes a trip, and its creator its first Organizer who is going, in one transaction. Throws `TripError` for a value that is not a trip's, and `LimitReached` when the account is already in as many trips as the server allows
 * (`WAYMARK_LIMIT_ACCOUNT_TRIPS`); then nothing is made.
 */
export async function createTrip(
  deps: TripDeps,
  accountId: string,
  input: NewTrip,
): Promise<TripView> {
  const name = cleanTripName(input.name);
  const description = cleanTripDescription(input.description);
  const color = cleanTripColor(input.color);
  const id = randomUUID();
  const now = deps.now();
  const sealed = deps.sealer.seal('trip', id, sealedFields(name, description));
  await transaction(deps.database, async (tx) => {
    await dbAll(
      tx,
      sql`INSERT INTO ${tableOf(tx, 'trip')} (id, color, seq, created_by, sealed, created_at, updated_at)
          VALUES (${id}, ${color}, 1, ${accountId}, ${sealed}, ${now}, ${now}) RETURNING id`,
    );
    await dbAll(
      tx,
      sql`INSERT INTO ${tableOf(tx, 'trip_member')} (trip_id, account_id, role, going, share_checkins, added_by, joined_at, seq)
          VALUES (${id}, ${accountId}, 'organizer', ${true}, 'ask', ${accountId}, ${now}, 1) RETURNING trip_id`,
    );
    // After its own row is in, so that the count includes it: more than the limit and the whole of it is rolled back.
    const held = await dbGet<{ n: number | string }>(
      tx,
      sql`SELECT COUNT(*) AS n FROM ${tableOf(tx, 'trip_member')} WHERE account_id = ${accountId} AND left_at IS NULL`,
    );
    if (Number(held?.n ?? 0) > deps.limits.accountTrips)
      throw new LimitReached(
        `You are in as many trips as this server allows (${deps.limits.accountTrips}). Leave or delete one first.`,
      );
  });
  const made = await getTrip(deps, accountId, id);
  if (!made) throw new Error('the trip that was just made is not there');
  return made.trip;
}

/** The trips the caller is a member of, with their part in each: soonest first, a trip with no dates yet after those that have them, then newest made. */
export async function listTrips(deps: TripDeps, accountId: string): Promise<TripView[]> {
  const rows = await dbAll<TripRow & { role: string; going: boolean | number }>(
    deps.database,
    sql`SELECT ${columnsOf(deps.database)}, m.role AS role, m.going AS going
        FROM ${tableOf(deps.database, 'trip')} t
        JOIN ${tableOf(deps.database, 'trip_member')} m ON m.trip_id = t.id
        WHERE m.account_id = ${accountId} AND m.left_at IS NULL
        ORDER BY CASE WHEN t.start_date IS NULL THEN 1 ELSE 0 END, t.start_date, t.created_at DESC, t.id`,
  );
  return rows.map((row) => ({
    ...tripOf(deps, row),
    role: row.role as Role,
    going: Boolean(row.going),
  }));
}

export interface TripDetail {
  readonly trip: TripView;
  readonly members: MemberView[];
}

/** One trip, with its members as the caller may see them, or `undefined` when the caller is not a member of it. One statement asks for the trip and the caller's membership together. */
export async function getTrip(
  deps: TripDeps,
  accountId: string,
  tripId: string,
): Promise<TripDetail | undefined> {
  if (!TRIP_ID.test(tripId)) return undefined;
  const row = await dbGet<TripRow & { role: string; going: boolean | number }>(
    deps.database,
    sql`SELECT ${columnsOf(deps.database)}, m.role AS role, m.going AS going
        FROM ${tableOf(deps.database, 'trip')} t
        JOIN ${tableOf(deps.database, 'trip_member')} m ON m.trip_id = t.id
        WHERE t.id = ${tripId} AND m.account_id = ${accountId} AND m.left_at IS NULL`,
  );
  if (!row) return undefined;
  const trip: TripView = {
    ...tripOf(deps, row),
    role: row.role as Role,
    going: Boolean(row.going),
  };
  const members = await dbAll<{
    accountId: string;
    role: string;
    going: boolean | number;
    joinedAt: number | string;
  }>(
    deps.database,
    sql`SELECT m.account_id AS "accountId", m.role AS role, m.going AS going, m.joined_at AS "joinedAt"
        FROM ${tableOf(deps.database, 'trip_member')} m
        WHERE m.trip_id = ${tripId} AND m.left_at IS NULL
          AND ${memberOf(deps.database, sql`${tripId}`, accountId, MEMBERS)}
        ORDER BY CASE m.role WHEN 'organizer' THEN 0 WHEN 'traveler' THEN 1 ELSE 2 END, m.joined_at, m.account_id`,
  );
  const views: MemberView[] = [];
  for (const member of members) {
    const profile = await getProfile(deps.database, deps.sealer, member.accountId);
    const self = member.accountId === accountId;
    // What the caller may see of the person is §6.1's one function: the relation is the caller's own part in this trip.
    const shown = profile
      ? visibleProfile(profile, self ? 'self' : trip.role === 'organizer' ? 'organizer' : 'member')
      : undefined;
    views.push({
      accountId: member.accountId,
      name: shown?.name ?? 'Someone',
      ...(shown?.email !== undefined ? { email: shown.email } : {}),
      role: member.role as Role,
      going: Boolean(member.going),
      joinedAt: Number(member.joinedAt),
      self,
    });
  }
  return { trip, members: views };
}

export interface TripPatch {
  readonly name?: unknown;
  /** `null` or an empty text takes the description away. */
  readonly description?: unknown;
  readonly color?: unknown;
  /** One of the trip's own places (a stop's), or `null` for none: shown as the trip's map thumbnail (DESIGN.md §10.1). */
  readonly coverPlaceId?: unknown;
}

/**
 * Renames, recolours or describes a trip: **Organizers only**. The row is read, changed and written back **only if it is still as it was read** (its `seq`) and the caller is still an Organizer, in one statement, so that two
 * changes at once never write over each other and a person removed meanwhile changes nothing; a conflict is tried again. Returns the trip, or `undefined` for a trip the caller cannot change. Throws `TripError` for a value that is not a trip's.
 */
export async function updateTrip(
  deps: TripDeps,
  accountId: string,
  tripId: string,
  patch: TripPatch,
): Promise<TripView | undefined> {
  if (!TRIP_ID.test(tripId)) return undefined;
  // Checked before anything is read, so that a bad value is the same answer for everyone.
  const name = patch.name === undefined ? undefined : cleanTripName(patch.name);
  const description =
    patch.description === undefined ? undefined : (cleanTripDescription(patch.description) ?? null);
  const color = patch.color === undefined ? undefined : cleanTripColor(patch.color);
  const cover = patch.coverPlaceId;
  if (
    cover !== undefined &&
    cover !== null &&
    (typeof cover !== 'string' || cover === '' || cover.length > 64)
  )
    throw new TripError("a trip's cover is one of its own places, or none");
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const current = await dbGet<{
      seq: number | string;
      color: string;
      sealed: Uint8Array | ArrayBuffer;
    }>(
      deps.database,
      sql`SELECT t.seq AS seq, t.color AS color, t.sealed AS sealed FROM ${tableOf(deps.database, 'trip')} t
          WHERE t.id = ${tripId} AND ${memberOf(deps.database, sql`t.id`, accountId, ORGANIZERS)}`,
    );
    if (!current) return undefined;
    const fields = deps.sealer.unseal('trip', tripId, bytes(current.sealed));
    const next = deps.sealer.seal(
      'trip',
      tripId,
      sealedFields(
        name ?? fields.name,
        description === undefined ? fields.description : (description ?? undefined),
      ),
    );
    const written = await dbAll<{ id: string }>(
      deps.database,
      sql`UPDATE ${tableOf(deps.database, 'trip')} SET sealed = ${next}, color = ${color ?? current.color},
              cover_place_id = ${cover === undefined ? sql`cover_place_id` : cover},
              seq = seq + 1, updated_at = ${deps.now()}
          WHERE id = ${tripId} AND seq = ${Number(current.seq)}
            AND ${memberOf(deps.database, sql`${tripId}`, accountId, ORGANIZERS)}
            AND (${cover === undefined || cover === null ? sql`1 = 1` : sql`EXISTS (SELECT 1 FROM ${tableOf(deps.database, 'place')} p WHERE p.id = ${cover} AND p.trip_id = ${tripId})`})
          RETURNING id`,
    );
    if (written.length > 0) return (await getTrip(deps, accountId, tripId))?.trip;
  }
  return undefined;
}

/**
 * Marks a trip ready, or moves it back to planning (DESIGN.md §10.2): **Organizers only**, and the owner's decision. Marking ready **needs at least one stop with dates**; a trip that is already as asked is left as it is, said
 * nobody and unchanged (so asking twice is safe). The first statement does the change **only if the caller is an Organizer and the trip is in the other state** (and, for ready, has a dated stop), and what follows runs in the same
 * transaction: every other active member is told (`trip_ready`, also when it goes back), and the answer is the trip with its new status. Returns the trip, or `undefined` for one the caller cannot change. Throws `TripError` for a
 * trip with no dated stop.
 */
export async function setReady(
  deps: TripDeps,
  accountId: string,
  tripId: string,
  ready: boolean,
): Promise<TripView | undefined> {
  if (!TRIP_ID.test(tripId)) return undefined;
  const now = deps.now();
  const outcome = await transaction(deps.database, async (tx) => {
    const datedStop = sql`EXISTS (SELECT 1 FROM ${tableOf(tx, 'stop')} s WHERE s.trip_id = ${tripId} AND s.arrive IS NOT NULL)`;
    const changed = await dbAll<{
      sealed: Uint8Array | ArrayBuffer;
      startDate: string | null;
      endDate: string | null;
    }>(
      tx,
      ready
        ? sql`UPDATE ${tableOf(tx, 'trip')} SET ready_at = ${now}, seq = seq + 1, updated_at = ${now}
              WHERE id = ${tripId} AND ready_at IS NULL AND ${datedStop}
                AND ${memberOf(tx, sql`${tripId}`, accountId, ORGANIZERS)}
              RETURNING sealed, start_date AS "startDate", end_date AS "endDate"`
        : sql`UPDATE ${tableOf(tx, 'trip')} SET ready_at = NULL, seq = seq + 1, updated_at = ${now}
              WHERE id = ${tripId} AND ready_at IS NOT NULL
                AND ${memberOf(tx, sql`${tripId}`, accountId, ORGANIZERS)}
              RETURNING sealed, start_date AS "startDate", end_date AS "endDate"`,
    );
    const row = changed[0];
    if (row) {
      const name = deps.sealer.unseal('trip', tripId, bytes(row.sealed)).name;
      await notifyMembers(
        tx,
        { sealer: deps.sealer, now: deps.now, delivery: deps.delivery },
        tripId,
        accountId,
        'trip_ready',
        ready
          ? {
              title: `“${name}” is ready`,
              detail:
                row.startDate && row.endDate
                  ? `It runs from ${row.startDate} to ${row.endDate}.`
                  : undefined,
            }
          : {
              title: `“${name}” is back to planning`,
              detail: 'Its plan is being worked on again.',
            },
      );
      return 'changed' as const;
    }
    // Nothing changed: why? Not theirs to change (the same answer as a trip that is not there), already as asked, or it has no dated stop.
    const state = await dbGet<{ readyAt: number | string | null; dated: number | string }>(
      tx,
      sql`SELECT t.ready_at AS "readyAt", (SELECT COUNT(*) FROM ${tableOf(tx, 'stop')} s WHERE s.trip_id = t.id AND s.arrive IS NOT NULL) AS dated
          FROM ${tableOf(tx, 'trip')} t
          WHERE t.id = ${tripId} AND ${memberOf(tx, sql`t.id`, accountId, ORGANIZERS)}`,
    );
    if (!state) return 'not_found' as const;
    if (ready && state.readyAt === null && Number(state.dated) === 0) return 'no_dates' as const;
    return 'unchanged' as const;
  });
  if (outcome === 'not_found') return undefined;
  if (outcome === 'no_dates')
    throw new TripError('A trip needs a stop with dates before it is marked ready.');
  return (await getTrip(deps, accountId, tripId))?.trip;
}

/** What deleting a trip would take, for the question that is asked first (DESIGN.md §10.1): said by an Organizer's own request, and counts only. */
export interface TripDeletion {
  readonly name: string;
  readonly members: number;
  /** The trip's stops (and with them its days and its own places). */
  readonly stops: number;
  /** Check-ins, of anyone, that are linked to the trip: they stay their owners', and stop being linked. */
  readonly linkedCheckins: number;
}

export async function previewDeletion(
  deps: TripDeps,
  accountId: string,
  tripId: string,
): Promise<TripDeletion | undefined> {
  if (!TRIP_ID.test(tripId)) return undefined;
  const row = await dbGet<TripRow>(
    deps.database,
    sql`SELECT ${columnsOf(deps.database)} FROM ${tableOf(deps.database, 'trip')} t
        WHERE t.id = ${tripId} AND ${memberOf(deps.database, sql`t.id`, accountId, ORGANIZERS)}`,
  );
  if (!row) return undefined;
  const members = await dbGet<{ n: number | string }>(
    deps.database,
    sql`SELECT COUNT(*) AS n FROM ${tableOf(deps.database, 'trip_member')} WHERE trip_id = ${tripId} AND left_at IS NULL`,
  );
  const stops = await dbGet<{ n: number | string }>(
    deps.database,
    sql`SELECT COUNT(*) AS n FROM ${tableOf(deps.database, 'stop')} WHERE trip_id = ${tripId}`,
  );
  const linked = await dbGet<{ n: number | string }>(
    deps.database,
    sql`SELECT COUNT(*) AS n FROM ${tableOf(deps.database, 'checkin')} WHERE trip_id = ${tripId}`,
  );
  return {
    name: tripOf(deps, row).name,
    members: Number(members?.n ?? 0),
    stops: Number(stops?.n ?? 0),
    linkedCheckins: Number(linked?.n ?? 0),
  };
}

/**
 * Deletes a trip and everything it holds: **Organizers only**. The first statement removes the trip **only if the caller is one**, and what follows runs only if it did, in the same transaction; a person's check-ins that were
 * linked to it are theirs and stay, **unlinked in their own stream** (a new `seq`, so that their devices find out); the members and the trip's own places go (`src/trips/tables.ts` says what each table does). Safe to ask
 * twice: the second finds nothing. Returns whether it deleted.
 */
export async function deleteTrip(
  deps: TripDeps,
  accountId: string,
  tripId: string,
): Promise<boolean> {
  if (!TRIP_ID.test(tripId)) return false;
  const files = await transaction(deps.database, async (tx) => {
    const gone = await dbAll<{ id: string }>(
      tx,
      sql`DELETE FROM ${tableOf(tx, 'trip')} WHERE id = ${tripId} AND ${memberOf(tx, sql`${tripId}`, accountId, ORGANIZERS)} RETURNING id`,
    );
    if (gone.length === 0) return undefined;
    return removeTripRows(tx, tripId, deps.now());
  });
  if (!files) return false;
  // The trip's files go once its rows have: a crash between leaves files with no row, which the orphan sweep finds.
  if (deps.media) for (const id of files) await removeFile(deps.media.dir, id);
  return true;
}

/**
 * What goes with a trip once it is gone (`src/trips/tables.ts` says what each table does): its linked check-ins are unlinked in their authors' streams, and its places and members are removed. **It decides nothing**: the caller
 * has already shown, in the same transaction, that the trip may be deleted: by an Organizer (`deleteTrip`), or because its last member's account is being deleted (`endMembershipsOf`).
 */
export async function removeTripRows(tx: Database, tripId: string, now: number): Promise<string[]> {
  await unlinkCheckins(tx, tripId, now);
  // Its attachments and their files' rows; the files themselves are removed by the caller after the transaction (they are not in the database).
  const files = await dbAll<{ id: string }>(
    tx,
    sql`SELECT id FROM ${tableOf(tx, 'media')} WHERE trip_id = ${tripId}`,
  );
  await dbAll(
    tx,
    sql`DELETE FROM ${tableOf(tx, 'relink')} WHERE trip_id = ${tripId} RETURNING trip_id`,
  );
  // The copies of check-ins shared with it: the originals are their authors' and stay.
  await dbAll(
    tx,
    sql`DELETE FROM ${tableOf(tx, 'shared_checkin')} WHERE trip_id = ${tripId} RETURNING checkin_id`,
  );
  await dbAll(
    tx,
    sql`DELETE FROM ${tableOf(tx, 'trip_link')} WHERE trip_id = ${tripId} RETURNING id`,
  );
  await dbAll(
    tx,
    sql`DELETE FROM ${tableOf(tx, 'attachment')} WHERE trip_id = ${tripId} RETURNING id`,
  );
  await dbAll(tx, sql`DELETE FROM ${tableOf(tx, 'media')} WHERE trip_id = ${tripId} RETURNING id`);
  await dbAll(tx, sql`DELETE FROM ${tableOf(tx, 'item')} WHERE trip_id = ${tripId} RETURNING id`);
  await dbAll(tx, sql`DELETE FROM ${tableOf(tx, 'day')} WHERE trip_id = ${tripId} RETURNING id`);
  await dbAll(tx, sql`DELETE FROM ${tableOf(tx, 'stop')} WHERE trip_id = ${tripId} RETURNING id`);
  await dbAll(tx, sql`DELETE FROM ${tableOf(tx, 'place')} WHERE trip_id = ${tripId} RETURNING id`);
  await dbAll(
    tx,
    sql`DELETE FROM ${tableOf(tx, 'trip_member')} WHERE trip_id = ${tripId} RETURNING account_id`,
  );
  return files.map((file) => file.id);
}

/**
 * Makes each check-in that was linked to a trip its author's alone again, **in its author's stream**: the account's counter is advanced once for all of theirs and each row is stamped, as the one write path does, so
 * that their devices pull the change. The check-in itself is not touched otherwise; a manual link is as undone as an automatic one, since the trip is gone.
 */
export async function unlinkCheckins(tx: Database, tripId: string, now: number): Promise<void> {
  const rows = await dbAll<{ id: string; accountId: string; version: number | string }>(
    tx,
    sql`SELECT id, account_id AS "accountId", version FROM ${tableOf(tx, 'checkin')} WHERE trip_id = ${tripId} ORDER BY account_id, id`,
  );
  const byAccount: Record<string, { id: string; version: number }[]> = {};
  for (const row of rows)
    (byAccount[row.accountId] ??= []).push({ id: row.id, version: Number(row.version) });
  for (const [owner, checkins] of Object.entries(byAccount)) {
    const counted = await dbGet<{ seq: number | string }>(
      tx,
      sql`INSERT INTO ${tableOf(tx, 'account_stream')} AS s (account_id, seq) VALUES (${owner}, ${checkins.length})
          ON CONFLICT (account_id) DO UPDATE SET seq = s.seq + ${checkins.length}
          RETURNING seq`,
    );
    const first = Number(counted?.seq) - checkins.length + 1;
    for (const [index, checkin] of checkins.entries()) {
      await dbAll(
        tx,
        sql`UPDATE ${tableOf(tx, 'checkin')} SET trip_id = NULL, link_source = NULL, version = ${checkin.version + 1}, seq = ${first + index}, updated_at = ${now}
            WHERE id = ${checkin.id} AND account_id = ${owner} AND trip_id = ${tripId} RETURNING id`,
      );
    }
  }
}
