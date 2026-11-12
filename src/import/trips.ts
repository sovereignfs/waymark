import { sql } from 'drizzle-orm';
import { tableOf } from '../access/trip';
import { enqueueRelink } from '../autolink/queue';
import type { Sealer } from '../crypto/sealed';
import type { Database } from '../db/client';
import { dbAll, dbGet, transaction } from '../db/exec';
import { type MediaDeps, putTripMedia } from '../media/service';
import { sealedFields } from '../places/places';
import { getProfile } from '../profile/profile';
import type { ExportedTrip } from '../portability/trips-format';
import { datesOf, tripDates } from '../trips/dates';
import { TRIP_DESCRIPTION_MAX } from '../trips/format';
import { idFor } from './ids';

/**
 * **Trips from a Waymark file** (DESIGN.md §22), made by the import job after its check-ins. Each is a **new trip with the importer as its only Organizer**: the other members are not brought (they are other people, with accounts of their own),
 * and their names and parts are kept in the trip's description. Its places, stops, days (with their words), items, links and attachments are made from the file's, with ids made from the importer and the file's own (`idFor`), so that
 * **importing the same file again makes nothing** (a trip the importer deleted is made again, as a file asked for twice is asked for).
 *
 * A trip is made **whole or not at all**: its rows go in one transaction, with the importer's membership, and its files are stored first (a file stored for a trip that then is not made is found by the orphan sweep). Nothing is checked
 * again that `parseExport` has checked. The importer's check-ins are linked to it by the same auto-link as ever, asked for in the same transaction, so the ones the file brought fall into it by their dates; a link a person made by hand is
 * not carried (the importer's links are the app's to decide). What other members shared with the trip is theirs and is not brought.
 */
export interface TripImportDeps {
  readonly database: Database;
  readonly sealer: Sealer;
  readonly now: () => number;
  /** The media store, for the attachments; without it a trip is made without them. */
  readonly media?: MediaDeps | undefined;
}

export interface TripSource {
  readonly trips: readonly ExportedTrip[];
  /** The bytes of a file of the ZIP. */
  load(file: string): Promise<Buffer>;
}

export interface TripsDone {
  readonly made: number;
  readonly skipped: number;
  /** Attachments that could not be kept (not a file this server will store). */
  readonly attachmentsFailed: number;
}

const ROLE_LABEL = { organizer: 'Organizer', traveler: 'Traveler', follower: 'Follower' } as const;

/** The description with the other members' names after it, within the description's limit. */
export function describe(trip: ExportedTrip, importerName: string | undefined): string | undefined {
  const others = trip.members.filter(
    (member) => member.name.toLowerCase() !== (importerName ?? '').toLowerCase(),
  );
  const base = trip.description ?? '';
  if (others.length === 0) return base || undefined;
  let line = 'On this trip: ';
  const parts = others.map((member) => `${member.name} (${ROLE_LABEL[member.role]})`);
  const room = TRIP_DESCRIPTION_MAX - base.length - (base ? 2 : 0) - line.length - 1;
  let list = parts.join(', ');
  if (list.length > room) {
    list = list.slice(0, Math.max(0, room - 1)).replace(/[,\s]+[^,]*$/, '') + '…';
    if (room < 2) return base || undefined;
  }
  line += `${list}.`;
  return base ? `${base}\n\n${line}` : line;
}

export async function importTrips(
  deps: TripImportDeps,
  accountId: string,
  source: TripSource,
): Promise<TripsDone> {
  const profile = await getProfile(deps.database, deps.sealer, accountId);
  let made = 0;
  let skipped = 0;
  let attachmentsFailed = 0;
  for (const trip of source.trips) {
    const tripId = idFor('trip', accountId, trip.id);
    const there = await dbGet<{ id: string }>(
      deps.database,
      sql`SELECT id FROM ${tableOf(deps.database, 'trip')} WHERE id = ${tripId}`,
    );
    if (there) {
      skipped += 1;
      continue;
    }
    // The files first: a file with no trip is found by the sweep, and a trip never names a file that is not there.
    const stored = new Map<string, { id: string; thumbId: string | undefined }>();
    for (const attachment of trip.attachments) {
      if (!deps.media) {
        attachmentsFailed += 1;
        continue;
      }
      try {
        const result = await putTripMedia(deps.media, {
          tripId,
          bytes: await source.load(attachment.file),
          id: idFor('attachmentfile', accountId, `${trip.id}:${attachment.id}`),
        });
        if (result.ok) stored.set(attachment.id, { id: result.id, thumbId: result.thumbId });
        else attachmentsFailed += 1;
      } catch {
        attachmentsFailed += 1;
      }
    }
    const created = await transaction(deps.database, (tx) =>
      makeTrip(tx, deps, accountId, tripId, trip, stored, describe(trip, profile?.name)),
    );
    if (created) made += 1;
    else skipped += 1;
  }
  return { made, skipped, attachmentsFailed };
}

async function makeTrip(
  tx: Database,
  deps: TripImportDeps,
  accountId: string,
  tripId: string,
  trip: ExportedTrip,
  stored: ReadonlyMap<string, { id: string; thumbId: string | undefined }>,
  description: string | undefined,
): Promise<boolean> {
  const t = (name: string) => tableOf(tx, name);
  const now = deps.now();
  const key = (row: string) => `${trip.id}:${row}`;
  // Another worker, or a restart, may have made it since: one trip, once.
  const there = await dbGet<{ id: string }>(
    tx,
    sql`SELECT id FROM ${t('trip')} WHERE id = ${tripId}`,
  );
  if (there) return false;

  const dated = trip.stops
    .filter((stop) => stop.arrive !== null)
    .map((stop) => ({
      id: stop.id,
      arrive: stop.arrive,
      depart: stop.depart,
      position: stop.position,
    }));
  const { start, end } = tripDates(dated);
  await dbAll(
    tx,
    sql`INSERT INTO ${t('trip')} (id, color, start_date, end_date, ready_at, seq, created_by, sealed, created_at, updated_at)
        VALUES (${tripId}, ${trip.color}, ${start}, ${end}, ${trip.ready && start !== null ? now : null}, 1, ${accountId},
                ${deps.sealer.seal('trip', tripId, { name: trip.name, ...(description ? { description } : {}) })}, ${now}, ${now})
        RETURNING id`,
  );
  await dbAll(
    tx,
    sql`INSERT INTO ${t('trip_member')} (trip_id, account_id, role, going, share_checkins, added_by, joined_at, seq)
        VALUES (${tripId}, ${accountId}, 'organizer', ${true}, 'ask', ${accountId}, ${now}, 1) RETURNING trip_id`,
  );

  const placeIds = new Map<string, string>();
  for (const place of trip.places) {
    const id = idFor('tripplace', accountId, key(place.id));
    placeIds.set(place.id, id);
    await dbAll(
      tx,
      sql`INSERT INTO ${t('place')} (id, trip_id, source, tz, country_code, version, seq, unnamed, sealed, created_at, updated_at)
          VALUES (${id}, ${tripId}, ${place.source}, ${place.tz ?? null}, ${place.address?.countryCode ?? null}, 1, 1, 0,
                  ${deps.sealer.seal('place', id, sealedFields({ name: place.name, lat: place.lat, lng: place.lng, address: place.address, category: place.category, sourceId: place.sourceId }))}, ${now}, ${now})
          RETURNING id`,
    );
  }

  const words = new Map(trip.days.map((day) => [`${day.stopId}/${day.date}`, day]));
  /** The file's day id, to the day made for it (its stop and date). */
  const dayIds = new Map<string, string>();
  for (const stop of trip.stops) {
    const id = idFor('stop', accountId, key(stop.id));
    await dbAll(
      tx,
      sql`INSERT INTO ${t('stop')} (id, trip_id, place_id, arrive, depart, position, version, seq, sealed, created_at, updated_at)
          VALUES (${id}, ${tripId}, ${placeIds.get(stop.placeId) ?? ''}, ${stop.arrive}, ${stop.depart}, ${stop.position}, 1, 1,
                  ${deps.sealer.seal('stop', id, stop.note ? { note: stop.note } : {})}, ${now}, ${now})
          RETURNING id`,
    );
    if (stop.arrive === null || stop.depart === null) continue;
    for (const date of datesOf(stop.arrive, stop.depart)) {
      const own = words.get(`${stop.id}/${date}`);
      const dayId = idFor('day', accountId, key(`${stop.id}/${date}`));
      if (own) dayIds.set(own.id, dayId);
      await dbAll(
        tx,
        sql`INSERT INTO ${t('day')} (id, trip_id, stop_id, date, version, seq, sealed)
            VALUES (${dayId}, ${tripId}, ${id}, ${date}, 1, 1,
                    ${deps.sealer.seal('day', dayId, { ...(own?.title ? { title: own.title } : {}), ...(own?.notes ? { notes: own.notes } : {}) })})
            RETURNING id`,
      );
    }
  }

  for (const item of trip.items) {
    const dayId = dayIds.get(item.dayId);
    // A day the file does not hold a stop's date for cannot be (`parseExport` checked it); an item with no day is not made.
    if (!dayId) continue;
    const id = idFor('item', accountId, key(item.id));
    await dbAll(
      tx,
      sql`INSERT INTO ${t('item')} (id, trip_id, day_id, place_id, kind, start_time, end_time, fixed, position, version, seq, created_by, updated_by, sealed, created_at, updated_at)
          VALUES (${id}, ${tripId}, ${dayId}, ${item.placeId ? (placeIds.get(item.placeId) ?? null) : null}, ${item.kind}, ${item.start}, ${item.end}, ${item.fixed}, ${item.position}, 1, 1,
                  ${accountId}, ${accountId},
                  ${deps.sealer.seal('item', id, { ...(item.title ? { title: item.title } : {}), ...(item.notes ? { notes: item.notes } : {}) })}, ${now}, ${now})
          RETURNING id`,
    );
  }

  for (const link of trip.links) {
    const id = idFor('link', accountId, key(link.id));
    await dbAll(
      tx,
      sql`INSERT INTO ${t('trip_link')} (id, trip_id, kind, position, seq, sealed)
          VALUES (${id}, ${tripId}, ${link.kind}, ${link.position}, 1, ${deps.sealer.seal('trip_link', id, { title: link.title, url: link.url })})
          RETURNING id`,
    );
  }

  for (const attachment of trip.attachments) {
    const file = stored.get(attachment.id);
    if (!file) continue;
    const id = idFor('attachment', accountId, key(attachment.id));
    await dbAll(
      tx,
      sql`INSERT INTO ${t('attachment')} (id, trip_id, day_id, kind, media_id, thumb_id, seq, created_by, sealed, created_at)
          VALUES (${id}, ${tripId}, ${attachment.dayId ? (dayIds.get(attachment.dayId) ?? null) : null}, ${attachment.kind}, ${file.id}, ${file.thumbId ?? null}, 1, ${accountId},
                  ${deps.sealer.seal('attachment', id, { title: attachment.title })}, ${now})
          RETURNING id`,
    );
  }

  // The importer's check-ins that fall within its dates are linked to it, in the background, as for any trip whose dates were set.
  await enqueueRelink(tx, tripId, now);
  return true;
}
