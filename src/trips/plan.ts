import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { placeRowOf } from '../actions/places';
import { EDITORS, MEMBERS, memberOf, tableOf } from '../access/trip';
import type { LimitSettings } from '../config';
import type { Sealer } from '../crypto/sealed';
import type { Database } from '../db/client';
import { dbAll, dbGet, transaction } from '../db/exec';
import type { Address } from '../places/clean';
import { sealedFields } from '../places/places';
import { zoneOf } from '../places/tz';
import {
  type DatedStop,
  type DatesProblem,
  checkStopDates,
  checkStops,
  datesOf,
  orderStops,
  reconcileDays,
  tripDates,
} from './dates';
import { TRIP_ID } from './format';
import { DAY_REFERENCES, type DayReference, PLACE_USERS } from './tables';

/**
 * A trip's plan: its stops, the days of each, and the trip's own places (DESIGN.md §7.1, §10.3, §10.4). **Every statement names the caller's membership and the role it needs** (`src/access/trip.ts`): a plan is read by every member
 * (Followers too) and changed by Organizers and Travelers. A change is **one transaction that begins with a guarded statement** (`UPDATE trip … WHERE id = ? AND <the caller is an Organizer or a Traveler>`), which both shows that
 * the caller may and takes the trip's row, so that what is read after it cannot change under it (two changes to one trip at the same moment are done one after the other, and each sees the other's). It advances the trip's counter
 * once, and what the change writes is stamped with it (15.3). **The trip's dates are recomputed from its stops in the same transaction** (`dates.ts`), so they are always its first arrival and its last departure.
 *
 * A stop's place is **the trip's own** (`place.trip_id`, no account): every member sees it and it goes with the trip. **A person's places are never touched from here.** What is sealed (a place's name and point, a stop's note) is
 * written and read only by `sealer`, and never in a condition.
 */
export interface PlanDeps {
  readonly database: Database;
  readonly sealer: Sealer;
  readonly now: () => number;
  readonly limits: LimitSettings;
  /** What names a day, which a stop's removal clears and a shrinking stop is refused for (items, 9.3). A parameter so that a test can name a table of its own. */
  readonly dayReferences?: readonly DayReference[] | undefined;
}

export interface StopPlace {
  readonly id: string;
  readonly name: string;
  readonly lat: number;
  readonly lng: number;
  readonly address: Address | undefined;
  readonly category: string | undefined;
  readonly tz: string | null;
  readonly countryCode: string | null;
}

export interface DayView {
  readonly id: string;
  readonly date: string;
}

export interface StopView {
  readonly id: string;
  readonly place: StopPlace;
  readonly arrive: string | null;
  readonly depart: string | null;
  readonly position: string;
  readonly note: string | undefined;
  readonly version: number;
  readonly days: DayView[];
}

export interface Plan {
  readonly stops: StopView[];
}

/** A change the plan would not take, with a sentence of its own that never repeats what was typed. `items` names the days that have items, so that a screen can offer to move or delete them first. */
export type PlanFailure =
  DatesProblem | { readonly reason: 'items'; readonly sentence: string; readonly days: string[] };

export class PlanRefused extends Error {
  override name = 'PlanRefused';
  constructor(readonly failure: PlanFailure) {
    super(failure.sentence);
  }
}

export const NOTE_MAX = 2000;
const POSITION_STEP = 1000;
const positionOf = (index: number): string => String((index + 1) * POSITION_STEP).padStart(8, '0');

function cleanNote(note: unknown): string | undefined {
  if (note === undefined || note === null) return undefined;
  if (typeof note !== 'string' || note.trim().length > NOTE_MAX)
    throw new PlanRefused({
      reason: 'invalid',
      sentence: `A note is text of at most ${NOTE_MAX} characters.`,
    });
  const trimmed = note.trim();
  return trimmed === '' ? undefined : trimmed;
}

const bytes = (value: Uint8Array | ArrayBuffer): Uint8Array =>
  value instanceof Uint8Array ? value : new Uint8Array(value);

interface StopRow {
  id: string;
  placeId: string;
  arrive: string | null;
  depart: string | null;
  position: string;
  version: number | string;
  sealed: Uint8Array | ArrayBuffer;
}

const STOP_COLUMNS = sql.raw(
  `s.id, s.place_id AS "placeId", s.arrive, s.depart, s.position, s.version, s.sealed`,
);

/** The plan as the caller may read it: every member's, and `undefined` for a trip they are not in. */
export async function readPlan(
  deps: PlanDeps,
  accountId: string,
  tripId: string,
): Promise<Plan | undefined> {
  if (!TRIP_ID.test(tripId)) return undefined;
  const { database } = deps;
  const member = await dbGet<{ id: string }>(
    database,
    sql`SELECT t.id AS id FROM ${tableOf(database, 'trip')} t WHERE t.id = ${tripId} AND ${memberOf(database, sql`t.id`, accountId, MEMBERS)}`,
  );
  if (!member) return undefined;
  return loadPlan(deps, database, tripId, accountId, MEMBERS);
}

async function loadPlan(
  deps: PlanDeps,
  database: Database,
  tripId: string,
  accountId: string,
  roles: typeof MEMBERS,
): Promise<Plan> {
  const rows = await dbAll<
    StopRow & {
      pSealed: Uint8Array | ArrayBuffer;
      pTz: string | null;
      pCountry: string | null;
    }
  >(
    database,
    sql`SELECT ${STOP_COLUMNS}, p.sealed AS "pSealed", p.tz AS "pTz", p.country_code AS "pCountry"
        FROM ${tableOf(database, 'stop')} s
        JOIN ${tableOf(database, 'place')} p ON p.id = s.place_id AND p.trip_id = s.trip_id
        WHERE s.trip_id = ${tripId} AND ${memberOf(database, sql`s.trip_id`, accountId, roles)}`,
  );
  const days = await dbAll<{ id: string; stopId: string; date: string }>(
    database,
    sql`SELECT d.id, d.stop_id AS "stopId", d.date FROM ${tableOf(database, 'day')} d
        WHERE d.trip_id = ${tripId} AND ${memberOf(database, sql`d.trip_id`, accountId, roles)}
        ORDER BY d.date, d.id`,
  );
  const stops: StopView[] = rows.map((row) => {
    const place = deps.sealer.unseal('place', row.placeId, bytes(row.pSealed));
    const fields = deps.sealer.unseal('stop', row.id, bytes(row.sealed));
    return {
      id: row.id,
      place: {
        id: row.placeId,
        name: place.name,
        lat: place.lat,
        lng: place.lng,
        address: place.address as Address | undefined,
        category: place.category,
        tz: row.pTz,
        countryCode: row.pCountry,
      },
      arrive: row.arrive,
      depart: row.depart,
      position: row.position,
      note: fields.note,
      version: Number(row.version),
      days: days.filter((day) => day.stopId === row.id).map(({ id, date }) => ({ id, date })),
    };
  });
  return { stops: orderStops(stops) };
}

/** What a change works on once the caller is shown to be allowed: the transaction, the trip's counter now, the time, and the stops as they are. */
interface Change {
  readonly tx: Database;
  readonly seq: number;
  readonly now: number;
  readonly stops: StopRow[];
}

/**
 * Does one change to a trip's plan, for an Organizer or a Traveler, and returns the plan after it, or `undefined` for a trip the caller cannot change (not theirs, or a Follower's: the same answer). A refusal by the plan itself
 * (`PlanRefused`) is thrown out of the transaction, so that nothing it did is kept, the counter included.
 */
async function change(
  deps: PlanDeps,
  accountId: string,
  tripId: string,
  work: (change: Change) => Promise<void>,
): Promise<Plan | undefined> {
  if (!TRIP_ID.test(tripId)) return undefined;
  const now = deps.now();
  const allowed = await transaction(deps.database, async (tx) => {
    const touched = await dbAll<{ seq: number | string }>(
      tx,
      sql`UPDATE ${tableOf(tx, 'trip')} SET seq = seq + 1, updated_at = ${now}
          WHERE id = ${tripId} AND ${memberOf(tx, sql`${tripId}`, accountId, EDITORS)}
          RETURNING seq`,
    );
    const seq = touched[0] ? Number(touched[0].seq) : undefined;
    if (seq === undefined) return false;
    const stops = await dbAll<StopRow>(
      tx,
      sql`SELECT ${STOP_COLUMNS} FROM ${tableOf(tx, 'stop')} s WHERE s.trip_id = ${tripId}`,
    );
    await work({ tx, seq, now, stops });
    // The trip's dates are always its stops': recomputed here, in the transaction that changed them.
    const after = await dbAll<StopRow>(
      tx,
      sql`SELECT ${STOP_COLUMNS} FROM ${tableOf(tx, 'stop')} s WHERE s.trip_id = ${tripId}`,
    );
    const { start, end } = tripDates(after);
    await dbAll(
      tx,
      sql`UPDATE ${tableOf(tx, 'trip')} SET start_date = ${start}, end_date = ${end} WHERE id = ${tripId} RETURNING id`,
    );
    return true;
  });
  return allowed ? loadPlan(deps, deps.database, tripId, accountId, EDITORS) : undefined;
}

const asDated = (row: StopRow): DatedStop => ({
  id: row.id,
  arrive: row.arrive,
  depart: row.depart,
  position: row.position,
});

function refuseIf(problem: DatesProblem | undefined): void {
  if (problem) throw new PlanRefused(problem);
}

export interface NewStop {
  /** The place, as the place search found it or a person gave it: its name and point at least. It becomes the trip's own place. */
  readonly place: {
    readonly name: unknown;
    readonly lat: unknown;
    readonly lng: unknown;
    readonly address?: unknown;
    readonly category?: unknown;
    readonly source?: unknown;
    readonly sourceId?: unknown;
    readonly tz?: unknown;
  };
  readonly arrive?: unknown;
  readonly depart?: unknown;
  readonly note?: unknown;
}

/** Adds a stop at the end of the trip, with a place of the trip's own made for it. Refused for a value that is not a stop's, past the trip's limit of stops, or for dates that overlap another stop's. */
export async function addStop(
  deps: PlanDeps,
  accountId: string,
  tripId: string,
  input: NewStop,
): Promise<Plan | undefined> {
  const place = placeRowOf(input.place as Parameters<typeof placeRowOf>[0]);
  if (!place.ok) throw new PlanRefused({ reason: 'invalid', sentence: place.sentence });
  const dates = checkStopDates(input.arrive, input.depart);
  if (!dates.ok) throw new PlanRefused(dates);
  const note = cleanNote(input.note);
  return change(deps, accountId, tripId, async ({ tx, seq, now, stops }) => {
    if (stops.length >= deps.limits.tripStops)
      throw new PlanRefused({
        reason: 'limit',
        sentence: `A trip has at most ${deps.limits.tripStops} stops on this server.`,
      });
    const id = randomUUID();
    const placeId = randomUUID();
    const position = positionOf(stops.length);
    refuseIf(
      checkStops([
        ...stops.map(asDated),
        { id, arrive: dates.arrive, depart: dates.depart, position },
      ]),
    );
    const row = place.value;
    const tz = row.tz ?? zoneOf(row.lat, row.lng) ?? null;
    await dbAll(
      tx,
      sql`INSERT INTO ${tableOf(tx, 'place')} (id, trip_id, source, tz, country_code, version, seq, unnamed, sealed, created_at, updated_at)
          VALUES (${placeId}, ${tripId}, ${row.source}, ${tz}, ${row.address?.countryCode ?? null}, 1, ${seq}, 0,
                  ${deps.sealer.seal(
                    'place',
                    placeId,
                    sealedFields({
                      name: row.name,
                      lat: row.lat,
                      lng: row.lng,
                      address: row.address,
                      category: row.category,
                      sourceId: row.sourceId,
                    }),
                  )}, ${now}, ${now})
          RETURNING id`,
    );
    await dbAll(
      tx,
      sql`INSERT INTO ${tableOf(tx, 'stop')} (id, trip_id, place_id, arrive, depart, position, version, seq, sealed, created_at, updated_at)
          VALUES (${id}, ${tripId}, ${placeId}, ${dates.arrive}, ${dates.depart}, ${position}, 1, ${seq},
                  ${deps.sealer.seal('stop', id, note ? { note } : {})}, ${now}, ${now})
          RETURNING id`,
    );
    if (dates.arrive !== null && dates.depart !== null)
      await addDays(tx, deps.sealer, tripId, id, datesOf(dates.arrive, dates.depart), seq);
  });
}

export interface StopPatch {
  readonly arrive?: unknown;
  readonly depart?: unknown;
  /** `null` or an empty text takes the note away. */
  readonly note?: unknown;
}

/**
 * Re-dates a stop and changes its note. Dates are both given (the stop moves) or both `null` (it has none); the days follow: new dates make days, dates that left remove them, and the rest keep their title, notes and items.
 * **Shrinking over a day that has items is refused, naming the days** (`items`), and nothing changes, so that a screen can offer to move or delete those items and ask again.
 */
export async function updateStop(
  deps: PlanDeps,
  accountId: string,
  tripId: string,
  stopId: string,
  patch: StopPatch,
): Promise<Plan | undefined> {
  const redate = 'arrive' in patch || 'depart' in patch;
  const dates = redate ? checkStopDates(patch.arrive, patch.depart) : undefined;
  if (dates && !dates.ok) throw new PlanRefused(dates);
  const note = 'note' in patch ? (cleanNote(patch.note) ?? null) : undefined;
  if (!redate && note === undefined)
    throw new PlanRefused({ reason: 'invalid', sentence: 'There is nothing to change.' });
  return change(deps, accountId, tripId, async ({ tx, seq, now, stops }) => {
    const stop = stops.find((each) => each.id === stopId);
    // A stop of another trip (or none) is not this trip's to change.
    if (!stop) throw new NotThisTripsStop();
    let nextNote: { note?: string } | undefined;
    if (note !== undefined) nextNote = note === null ? {} : { note };
    if (dates?.ok) {
      refuseIf(
        checkStops(
          stops.map((each) =>
            each.id === stopId
              ? { ...asDated(each), arrive: dates.arrive, depart: dates.depart }
              : asDated(each),
          ),
        ),
      );
      const current = await dbAll<{ id: string; date: string }>(
        tx,
        sql`SELECT id, date FROM ${tableOf(tx, 'day')} WHERE stop_id = ${stopId} AND trip_id = ${tripId} ORDER BY date`,
      );
      const wanted =
        dates.arrive !== null && dates.depart !== null ? datesOf(dates.arrive, dates.depart) : [];
      const { add, remove } = reconcileDays(
        current.map((day) => day.date),
        wanted,
      );
      const going = current.filter((day) => remove.includes(day.date));
      await refuseDaysWithItems(deps, tx, tripId, going);
      for (const day of going) await dropDay(tx, tripId, day.id, deps.dayReferences);
      await addDays(tx, deps.sealer, tripId, stopId, add, seq);
    }
    const sealed = deps.sealer.seal(
      'stop',
      stopId,
      nextNote ?? (await currentNote(deps, tx, stopId)),
    );
    await dbAll(
      tx,
      sql`UPDATE ${tableOf(tx, 'stop')}
          SET arrive = ${dates?.ok ? dates.arrive : stop.arrive}, depart = ${dates?.ok ? dates.depart : stop.depart},
              sealed = ${sealed}, version = version + 1, seq = ${seq}, updated_at = ${now}
          WHERE id = ${stopId} AND trip_id = ${tripId} RETURNING id`,
    );
  }).catch(notThisTrips);
}

/** Moves an undated stop to just before another (or to the end, with `before` null). **A stop with dates is in the order of its dates**, and is refused: it moves by being re-dated. */
export async function moveStop(
  deps: PlanDeps,
  accountId: string,
  tripId: string,
  stopId: string,
  before: string | null,
): Promise<Plan | undefined> {
  return change(deps, accountId, tripId, async ({ tx, seq, now, stops }) => {
    const stop = stops.find((each) => each.id === stopId);
    if (!stop) throw new NotThisTripsStop();
    if (stop.arrive !== null)
      throw new PlanRefused({
        reason: 'invalid',
        sentence: 'A stop with dates is in the order of its dates: change its dates to move it.',
      });
    const undated = stops
      .filter((each) => each.arrive === null)
      .sort((a, b) =>
        a.position < b.position ? -1 : a.position > b.position ? 1 : a.id < b.id ? -1 : 1,
      );
    const others = undated.filter((each) => each.id !== stopId);
    let index = others.length;
    if (before !== null) {
      index = others.findIndex((each) => each.id === before);
      if (index < 0) throw new NotThisTripsStop();
    }
    const ordered = [...others.slice(0, index), stop, ...others.slice(index)];
    // The dated stops come first and keep the positions they have, so the undated ones are numbered after them.
    const offset = stops.length - undated.length;
    for (const [i, each] of ordered.entries()) {
      const position = positionOf(offset + i);
      if (each.position === position) continue;
      await dbAll(
        tx,
        sql`UPDATE ${tableOf(tx, 'stop')} SET position = ${position}, version = version + 1, seq = ${seq}, updated_at = ${now}
            WHERE id = ${each.id} AND trip_id = ${tripId} RETURNING id`,
      );
    }
  }).catch(notThisTrips);
}

/** Removes a stop with its days, what hangs on its days (items cascade), and its place, unless something else of the trip uses it; a cover that was that place is cleared. */
export async function removeStop(
  deps: PlanDeps,
  accountId: string,
  tripId: string,
  stopId: string,
): Promise<Plan | undefined> {
  return change(deps, accountId, tripId, async ({ tx, stops }) => {
    const stop = stops.find((each) => each.id === stopId);
    if (!stop) throw new NotThisTripsStop();
    const days = await dbAll<{ id: string }>(
      tx,
      sql`SELECT id FROM ${tableOf(tx, 'day')} WHERE stop_id = ${stopId} AND trip_id = ${tripId}`,
    );
    for (const day of days) await dropDay(tx, tripId, day.id, deps.dayReferences);
    await dbAll(
      tx,
      sql`DELETE FROM ${tableOf(tx, 'stop')} WHERE id = ${stopId} AND trip_id = ${tripId} RETURNING id`,
    );
    let used = false;
    for (const user of PLACE_USERS) {
      const found = await dbGet<{ n: number | string }>(
        tx,
        sql`SELECT COUNT(*) AS n FROM ${tableOf(tx, user.table)} WHERE ${sql.raw(user.column)} = ${stop.placeId} AND trip_id = ${tripId}`,
      );
      if (Number(found?.n ?? 0) > 0) used = true;
    }
    if (!used) {
      await dbAll(
        tx,
        sql`UPDATE ${tableOf(tx, 'trip')} SET cover_place_id = NULL WHERE id = ${tripId} AND cover_place_id = ${stop.placeId} RETURNING id`,
      );
      await dbAll(
        tx,
        sql`DELETE FROM ${tableOf(tx, 'place')} WHERE id = ${stop.placeId} AND trip_id = ${tripId} RETURNING id`,
      );
    }
  }).catch(notThisTrips);
}

/** The stop asked for is not one of this trip's: the same answer as a trip that is not there. */
class NotThisTripsStop extends Error {}
const notThisTrips = (error: unknown): undefined => {
  if (error instanceof NotThisTripsStop) return undefined;
  throw error;
};

async function currentNote(
  deps: PlanDeps,
  tx: Database,
  stopId: string,
): Promise<{ note?: string }> {
  const row = await dbGet<{ sealed: Uint8Array | ArrayBuffer }>(
    tx,
    sql`SELECT sealed FROM ${tableOf(tx, 'stop')} WHERE id = ${stopId}`,
  );
  const fields = row ? deps.sealer.unseal('stop', stopId, bytes(row.sealed)) : {};
  return fields.note ? { note: fields.note } : {};
}

/** Makes a day for each date, **with nothing sealed in it yet** (a day's title and notes are set by an edit, 6.6). */
async function addDays(
  tx: Database,
  sealer: Sealer,
  tripId: string,
  stopId: string,
  dates: readonly string[],
  seq: number,
): Promise<void> {
  for (const date of dates) {
    const id = randomUUID();
    await dbAll(
      tx,
      sql`INSERT INTO ${tableOf(tx, 'day')} (id, trip_id, stop_id, date, version, seq, sealed)
          VALUES (${id}, ${tripId}, ${stopId}, ${date}, 1, ${seq}, ${sealer.seal('day', id, {})}) RETURNING id`,
    );
  }
}

/** Refuses the shrink when a day that would go has anything on it, naming the days (their dates, which is what a person knows them by). */
async function refuseDaysWithItems(
  deps: PlanDeps,
  tx: Database,
  tripId: string,
  going: readonly { id: string; date: string }[],
): Promise<void> {
  if (going.length === 0) return;
  const ids = going.map((day) => day.id);
  const named = new Set<string>();
  for (const reference of deps.dayReferences ?? DAY_REFERENCES) {
    const rows = await dbAll<{ dayId: string }>(
      tx,
      sql`SELECT DISTINCT ${sql.raw(reference.column)} AS "dayId" FROM ${tableOf(tx, reference.table)}
          WHERE trip_id = ${tripId} AND ${sql.raw(reference.column)} IN (${sql.join(
            ids.map((id) => sql`${id}`),
            sql`, `,
          )})`,
    );
    for (const row of rows) named.add(row.dayId);
  }
  if (named.size === 0) return;
  const days = going
    .filter((day) => named.has(day.id))
    .map((day) => day.date)
    .sort();
  throw new PlanRefused({
    reason: 'items',
    days,
    sentence: `${days.length === 1 ? 'A day' : 'Some days'} that would go ${days.length === 1 ? 'has' : 'have'} items on ${days.length === 1 ? 'it' : 'them'}. Move or delete them first.`,
  });
}

/** Removes a day, and (with `references`) what hangs on it. */
async function dropDay(
  tx: Database,
  tripId: string,
  dayId: string,
  references: readonly DayReference[] | undefined,
): Promise<void> {
  for (const reference of references ?? DAY_REFERENCES)
    await dbAll(
      tx,
      sql`DELETE FROM ${tableOf(tx, reference.table)} WHERE trip_id = ${tripId} AND ${sql.raw(reference.column)} = ${dayId} RETURNING 1 AS gone`,
    );
  await dbAll(
    tx,
    sql`DELETE FROM ${tableOf(tx, 'day')} WHERE id = ${dayId} AND trip_id = ${tripId} RETURNING id`,
  );
}
