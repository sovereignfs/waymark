import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { placeRowOf } from '../actions/places';
import { EDITORS, MEMBERS, memberOf, tableOf } from '../access/trip';
import type { LimitSettings } from '../config';
import type { Sealer } from '../crypto/sealed';
import type { Database } from '../db/client';
import { dbAll, dbGet, transaction } from '../db/exec';
import type { Address } from '../places/clean';
import type { Delivery } from '../notices/notices';
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
import { notifyMembers } from './notify';
import { type ItemKind, checkItem } from './item-format';
import { after, between, first, many } from '../position';
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
  /** How notices also reach people on this server; absent, the bell alone. */
  readonly delivery?: (() => Delivery) | undefined;
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

/** An item as the plan shows it (DESIGN.md §10.5). Its place, when it has one, is the trip's own. */
export interface ItemView {
  readonly id: string;
  readonly dayId: string;
  readonly title: string | undefined;
  readonly notes: string | undefined;
  readonly kind: ItemKind;
  readonly start: string | null;
  readonly end: string | null;
  readonly fixed: boolean;
  readonly position: string;
  readonly place: StopPlace | undefined;
  readonly createdBy: string | null;
  readonly updatedBy: string | null;
  readonly version: number;
}

export interface DayView {
  readonly id: string;
  readonly date: string;
  /** In the day's order, as dragged. */
  readonly items: ItemView[];
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
  const itemRows = await dbAll<{
    id: string;
    dayId: string;
    placeId: string | null;
    kind: string;
    startTime: string | null;
    endTime: string | null;
    fixed: boolean | number;
    position: string;
    version: number | string;
    createdBy: string | null;
    updatedBy: string | null;
    sealed: Uint8Array | ArrayBuffer;
    pSealed: Uint8Array | ArrayBuffer | null;
    pTz: string | null;
    pCountry: string | null;
  }>(
    database,
    sql`SELECT i.id, i.day_id AS "dayId", i.place_id AS "placeId", i.kind, i.start_time AS "startTime", i.end_time AS "endTime", i.fixed,
               i.position, i.version, i.created_by AS "createdBy", i.updated_by AS "updatedBy", i.sealed,
               p.sealed AS "pSealed", p.tz AS "pTz", p.country_code AS "pCountry"
        FROM ${tableOf(database, 'item')} i
        LEFT JOIN ${tableOf(database, 'place')} p ON p.id = i.place_id AND p.trip_id = i.trip_id
        WHERE i.trip_id = ${tripId} AND ${memberOf(database, sql`i.trip_id`, accountId, roles)}
        ORDER BY i.position, i.id`,
  );
  const items: ItemView[] = itemRows.map((row) => {
    const fields = deps.sealer.unseal('item', row.id, bytes(row.sealed));
    let place: StopPlace | undefined;
    if (row.placeId && row.pSealed) {
      const opened = deps.sealer.unseal('place', row.placeId, bytes(row.pSealed));
      place = {
        id: row.placeId,
        name: opened.name,
        lat: opened.lat,
        lng: opened.lng,
        address: opened.address as Address | undefined,
        category: opened.category,
        tz: row.pTz,
        countryCode: row.pCountry,
      };
    }
    return {
      id: row.id,
      dayId: row.dayId,
      title: fields.title,
      notes: fields.notes,
      kind: row.kind as ItemKind,
      start: row.startTime,
      end: row.endTime,
      fixed: Boolean(row.fixed),
      position: row.position,
      place,
      createdBy: row.createdBy,
      updatedBy: row.updatedBy,
      version: Number(row.version),
    };
  });
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
      days: days
        .filter((day) => day.stopId === row.id)
        .map(({ id, date }) => ({ id, date, items: items.filter((item) => item.dayId === id) })),
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
    const touched = await dbAll<{
      seq: number | string;
      readyAt: number | string | null;
      startDate: string | null;
      endDate: string | null;
      sealed: Uint8Array | ArrayBuffer;
    }>(
      tx,
      sql`UPDATE ${tableOf(tx, 'trip')} SET seq = seq + 1, updated_at = ${now}
          WHERE id = ${tripId} AND ${memberOf(tx, sql`${tripId}`, accountId, EDITORS)}
          RETURNING seq, ready_at AS "readyAt", start_date AS "startDate", end_date AS "endDate", sealed`,
    );
    const touchedRow = touched[0];
    if (!touchedRow) return false;
    const seq = Number(touchedRow.seq);
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
    // The members of a ready trip are told when its dates change (DESIGN.md §17.1), in this transaction. While it is being planned the dates change with every stop, and nobody is told.
    if (
      touchedRow.readyAt !== null &&
      (start !== touchedRow.startDate || end !== touchedRow.endDate)
    ) {
      const name = deps.sealer.unseal('trip', tripId, bytes(touchedRow.sealed)).name;
      await notifyMembers(
        tx,
        { sealer: deps.sealer, now: deps.now, delivery: deps.delivery },
        tripId,
        accountId,
        'trip_dates',
        {
          title: `The dates of “${name}” changed`,
          detail: start && end ? `It now runs from ${start} to ${end}.` : 'It has no dates now.',
        },
      );
    }
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
      if (going.length > 0) await sweepPlaces(tx, tripId);
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
    await sweepPlaces(tx, tripId);
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

/**
 * Removes the trip's own places that nothing names any more (`PLACE_USERS`: a stop, an item) and clears a cover that was one of them. Run after anything that can leave a place unnamed: a stop removed, an item changed or deleted,
 * a day's items cleared. The trip's own places are the trip's alone, so nothing of a person's is ever in reach of this.
 */
async function sweepPlaces(tx: Database, tripId: string): Promise<void> {
  const unused = PLACE_USERS.map(
    (user) =>
      sql`NOT EXISTS (SELECT 1 FROM ${tableOf(tx, user.table)} u WHERE u.${sql.raw(user.column)} = ${tableOf(tx, 'place')}.id AND u.trip_id = ${tripId})`,
  );
  await dbAll(
    tx,
    sql`DELETE FROM ${tableOf(tx, 'place')} WHERE trip_id = ${tripId} AND ${sql.join(unused, sql` AND `)} RETURNING id`,
  );
  await dbAll(
    tx,
    sql`UPDATE ${tableOf(tx, 'trip')} SET cover_place_id = NULL
        WHERE id = ${tripId} AND cover_place_id IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM ${tableOf(tx, 'place')} p WHERE p.id = ${tableOf(tx, 'trip')}.cover_place_id AND p.trip_id = ${tripId})
        RETURNING id`,
  );
}

interface ItemRow {
  id: string;
  dayId: string;
  placeId: string | null;
  kind: string;
  startTime: string | null;
  endTime: string | null;
  fixed: boolean | number;
  position: string;
  version: number | string;
  sealed: Uint8Array | ArrayBuffer;
}

const ITEM_COLUMNS = sql.raw(
  `i.id, i.day_id AS "dayId", i.place_id AS "placeId", i.kind, i.start_time AS "startTime", i.end_time AS "endTime", i.fixed, i.position, i.version, i.sealed`,
);

/** A day of this trip, or the answer for none (the same as a trip that is not there). */
async function dayOfTrip(tx: Database, tripId: string, dayId: string): Promise<void> {
  const found = await dbGet<{ id: string }>(
    tx,
    sql`SELECT id FROM ${tableOf(tx, 'day')} WHERE id = ${dayId} AND trip_id = ${tripId}`,
  );
  if (!found) throw new NotThisTripsStop();
}

/** The positions of a day's items in order (without `except`, the one being moved), for putting another between two of them. */
async function positionsOf(
  tx: Database,
  tripId: string,
  dayId: string,
  except?: string,
): Promise<{ id: string; position: string }[]> {
  const rows = await dbAll<{ id: string; position: string }>(
    tx,
    sql`SELECT id, position FROM ${tableOf(tx, 'item')} WHERE day_id = ${dayId} AND trip_id = ${tripId} ORDER BY position, id`,
  );
  return except ? rows.filter((row) => row.id !== except) : rows;
}

/** A position for an item put just before `beforeId` in the list (or at the end, with none). A `beforeId` that is not in the day is not the trip's to name. */
function positionBefore(
  list: readonly { id: string; position: string }[],
  beforeId: string | null | undefined,
): string {
  if (beforeId === null || beforeId === undefined)
    return list.length === 0 ? first() : after(list.at(-1)?.position ?? '');
  const index = list.findIndex((row) => row.id === beforeId);
  if (index < 0) throw new NotThisTripsStop();
  return between(
    index === 0 ? null : (list[index - 1]?.position ?? null),
    list[index]?.position ?? null,
  );
}

function tooMany(deps: PlanDeps): PlanRefused {
  return new PlanRefused({
    reason: 'limit',
    sentence: `A day has at most ${deps.limits.dayItems} items on this server.`,
  });
}

/** The place an item names: made from the fields given (a new place of the trip's own), or one of the trip's places by id. At most one of the two. */
async function itemPlace(
  deps: PlanDeps,
  tx: Database,
  tripId: string,
  seq: number,
  now: number,
  input: { place?: unknown; placeId?: unknown },
): Promise<string | null | undefined> {
  if (
    input.place !== undefined &&
    input.place !== null &&
    input.placeId !== undefined &&
    input.placeId !== null
  )
    throw new PlanRefused({
      reason: 'invalid',
      sentence: 'An item names a place by its fields or by an id of the trip, not both.',
    });
  if (input.place !== undefined && input.place !== null) {
    const place = placeRowOf(input.place as Parameters<typeof placeRowOf>[0]);
    if (!place.ok) throw new PlanRefused({ reason: 'invalid', sentence: place.sentence });
    const row = place.value;
    const id = randomUUID();
    await dbAll(
      tx,
      sql`INSERT INTO ${tableOf(tx, 'place')} (id, trip_id, source, tz, country_code, version, seq, unnamed, sealed, created_at, updated_at)
          VALUES (${id}, ${tripId}, ${row.source}, ${row.tz ?? zoneOf(row.lat, row.lng) ?? null}, ${row.address?.countryCode ?? null}, 1, ${seq}, 0,
                  ${deps.sealer.seal('place', id, sealedFields({ name: row.name, lat: row.lat, lng: row.lng, address: row.address, category: row.category, sourceId: row.sourceId }))}, ${now}, ${now})
          RETURNING id`,
    );
    return id;
  }
  if ('placeId' in input) {
    if (input.placeId === null || input.placeId === undefined) return null;
    if (typeof input.placeId !== 'string') throw new NotThisTripsStop();
    const found = await dbGet<{ id: string }>(
      tx,
      sql`SELECT id FROM ${tableOf(tx, 'place')} WHERE id = ${input.placeId} AND trip_id = ${tripId}`,
    );
    if (!found) throw new NotThisTripsStop();
    return found.id;
  }
  return undefined;
}

export interface NewItem {
  readonly dayId: string;
  readonly title?: unknown;
  readonly notes?: unknown;
  readonly kind?: unknown;
  readonly start?: unknown;
  readonly end?: unknown;
  readonly fixed?: unknown;
  /** A new place of the trip's own, from its fields; or `placeId`, one the trip has. */
  readonly place?: unknown;
  readonly placeId?: unknown;
  /** The item it is put before; at the end of the day with none. */
  readonly before?: string | null;
}

/** Adds an item to a day (any stop's day of the trip), at the end or before another. Refused for a value that is not an item's, and past the day's limit. */
export async function addItem(
  deps: PlanDeps,
  accountId: string,
  tripId: string,
  input: NewItem,
): Promise<Plan | undefined> {
  const hasPlace =
    (input.place !== undefined && input.place !== null) ||
    (input.placeId !== undefined && input.placeId !== null);
  const checked = checkItem(input, hasPlace);
  if (!checked.ok) throw new PlanRefused({ reason: 'invalid', sentence: checked.sentence });
  const fields = checked.value;
  return change(deps, accountId, tripId, async ({ tx, seq, now }) => {
    await dayOfTrip(tx, tripId, input.dayId);
    const placeId = (await itemPlace(deps, tx, tripId, seq, now, input)) ?? null;
    const list = await positionsOf(tx, tripId, input.dayId);
    if (list.length >= deps.limits.dayItems) throw tooMany(deps);
    const id = randomUUID();
    await dbAll(
      tx,
      sql`INSERT INTO ${tableOf(tx, 'item')} (id, trip_id, day_id, place_id, kind, start_time, end_time, fixed, position, version, seq, created_by, updated_by, sealed, created_at, updated_at)
          VALUES (${id}, ${tripId}, ${input.dayId}, ${placeId}, ${fields.kind}, ${fields.start}, ${fields.end}, ${fields.fixed}, ${positionBefore(list, input.before)}, 1, ${seq},
                  ${accountId}, ${accountId}, ${deps.sealer.seal('item', id, itemSealed(fields))}, ${now}, ${now})
          RETURNING id`,
    );
  }).catch(notThisTrips);
}

const itemSealed = (fields: { title: string | undefined; notes: string | undefined }) => ({
  ...(fields.title ? { title: fields.title } : {}),
  ...(fields.notes ? { notes: fields.notes } : {}),
});

export interface ItemPatch {
  readonly title?: unknown;
  readonly notes?: unknown;
  readonly kind?: unknown;
  readonly start?: unknown;
  readonly end?: unknown;
  readonly fixed?: unknown;
  readonly place?: unknown;
  /** A place of the trip's, or `null` to take the place away. */
  readonly placeId?: unknown;
}

const PATCH_KEYS = ['title', 'notes', 'kind', 'start', 'end', 'fixed', 'place', 'placeId'] as const;

/**
 * Changes an item: each field given is changed and the rest are kept; **the whole is checked as it will be** (an item still has a place or a title, a fixed one a start), so that no change can leave an item that could not
 * have been made. A place that nothing names any more is removed with it.
 */
export async function updateItem(
  deps: PlanDeps,
  accountId: string,
  tripId: string,
  itemId: string,
  patch: ItemPatch,
): Promise<Plan | undefined> {
  if (!PATCH_KEYS.some((key) => key in patch))
    throw new PlanRefused({ reason: 'invalid', sentence: 'There is nothing to change.' });
  return change(deps, accountId, tripId, async ({ tx, seq, now }) => {
    const row = await dbGet<ItemRow>(
      tx,
      sql`SELECT ${ITEM_COLUMNS} FROM ${tableOf(tx, 'item')} i WHERE i.id = ${itemId} AND i.trip_id = ${tripId}`,
    );
    if (!row) throw new NotThisTripsStop();
    const current = deps.sealer.unseal('item', itemId, bytes(row.sealed));
    const newPlace = await itemPlace(deps, tx, tripId, seq, now, patch);
    const placeId = newPlace === undefined ? row.placeId : newPlace;
    const merged = checkItem(
      {
        title: 'title' in patch ? patch.title : current.title,
        notes: 'notes' in patch ? patch.notes : current.notes,
        kind: 'kind' in patch ? patch.kind : row.kind,
        start: 'start' in patch ? patch.start : row.startTime,
        end: 'end' in patch ? patch.end : row.endTime,
        fixed: 'fixed' in patch ? patch.fixed : Boolean(row.fixed),
      },
      placeId !== null,
    );
    if (!merged.ok) throw new PlanRefused({ reason: 'invalid', sentence: merged.sentence });
    const fields = merged.value;
    await dbAll(
      tx,
      sql`UPDATE ${tableOf(tx, 'item')}
          SET place_id = ${placeId}, kind = ${fields.kind}, start_time = ${fields.start}, end_time = ${fields.end}, fixed = ${fields.fixed},
              sealed = ${deps.sealer.seal('item', itemId, itemSealed(fields))}, updated_by = ${accountId},
              version = version + 1, seq = ${seq}, updated_at = ${now}
          WHERE id = ${itemId} AND trip_id = ${tripId} RETURNING id`,
    );
    await sweepPlaces(tx, tripId);
  }).catch(notThisTrips);
}

/**
 * Moves an item within its day, or to another day (of any stop of the trip), **with all its fields**: just before another item, or at the end. Into another day it is refused past that day's limit. A `before` that is not an
 * item of the day it is going to is not found.
 */
export async function moveItem(
  deps: PlanDeps,
  accountId: string,
  tripId: string,
  itemId: string,
  dayId: string,
  before: string | null,
): Promise<Plan | undefined> {
  return change(deps, accountId, tripId, async ({ tx, seq, now }) => {
    const row = await dbGet<ItemRow>(
      tx,
      sql`SELECT ${ITEM_COLUMNS} FROM ${tableOf(tx, 'item')} i WHERE i.id = ${itemId} AND i.trip_id = ${tripId}`,
    );
    if (!row) throw new NotThisTripsStop();
    await dayOfTrip(tx, tripId, dayId);
    const list = await positionsOf(tx, tripId, dayId, itemId);
    if (dayId !== row.dayId && list.length >= deps.limits.dayItems) throw tooMany(deps);
    await dbAll(
      tx,
      sql`UPDATE ${tableOf(tx, 'item')} SET day_id = ${dayId}, position = ${positionBefore(list, before)}, updated_by = ${accountId},
              version = version + 1, seq = ${seq}, updated_at = ${now}
          WHERE id = ${itemId} AND trip_id = ${tripId} RETURNING id`,
    );
  }).catch(notThisTrips);
}

/** Deletes an item, and its place if nothing else names it. */
export async function deleteItem(
  deps: PlanDeps,
  accountId: string,
  tripId: string,
  itemId: string,
): Promise<Plan | undefined> {
  return change(deps, accountId, tripId, async ({ tx }) => {
    const gone = await dbAll<{ id: string }>(
      tx,
      sql`DELETE FROM ${tableOf(tx, 'item')} WHERE id = ${itemId} AND trip_id = ${tripId} RETURNING id`,
    );
    if (gone.length === 0) throw new NotThisTripsStop();
    await sweepPlaces(tx, tripId);
  }).catch(notThisTrips);
}

/** Moves every item of one day to the end of another (the way out of a refused shrink: the days that would go are emptied first), in their order, with all their fields. The two days are different days of this trip. */
export async function moveDayItems(
  deps: PlanDeps,
  accountId: string,
  tripId: string,
  fromDayId: string,
  toDayId: string,
): Promise<Plan | undefined> {
  if (fromDayId === toDayId)
    throw new PlanRefused({
      reason: 'invalid',
      sentence: 'Choose another day to move the items to.',
    });
  return change(deps, accountId, tripId, async ({ tx, seq, now }) => {
    await dayOfTrip(tx, tripId, fromDayId);
    await dayOfTrip(tx, tripId, toDayId);
    const moving = await positionsOf(tx, tripId, fromDayId);
    const there = await positionsOf(tx, tripId, toDayId);
    if (there.length + moving.length > deps.limits.dayItems) throw tooMany(deps);
    const positions = many(there.at(-1)?.position ?? null, null, moving.length);
    for (const [index, item] of moving.entries())
      await dbAll(
        tx,
        sql`UPDATE ${tableOf(tx, 'item')} SET day_id = ${toDayId}, position = ${positions[index] ?? ''}, updated_by = ${accountId},
                version = version + 1, seq = ${seq}, updated_at = ${now}
            WHERE id = ${item.id} AND trip_id = ${tripId} RETURNING id`,
      );
  }).catch(notThisTrips);
}

/** Deletes every item of a day (the other way out of a refused shrink), and the places nothing names any more. */
export async function clearDayItems(
  deps: PlanDeps,
  accountId: string,
  tripId: string,
  dayId: string,
): Promise<Plan | undefined> {
  return change(deps, accountId, tripId, async ({ tx }) => {
    await dayOfTrip(tx, tripId, dayId);
    await dbAll(
      tx,
      sql`DELETE FROM ${tableOf(tx, 'item')} WHERE day_id = ${dayId} AND trip_id = ${tripId} RETURNING id`,
    );
    await sweepPlaces(tx, tripId);
  }).catch(notThisTrips);
}
