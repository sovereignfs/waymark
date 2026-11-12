import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { unzipSync } from 'fflate';
import { sql } from 'drizzle-orm';
import sharp from 'sharp';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { tableOf } from '../access/trip';
import { enqueueRelink, workOnRelinks } from '../autolink/queue';
import { DEFAULT_LIMITS } from '../config';
import { type KeyRing, ringOf } from '../crypto/keys';
import { Sealer } from '../crypto/sealed';
import type { Database } from '../db/client';
import { dbAll, dbGet } from '../db/exec';
import { makeStore, testTarget } from '../db/test-support';
import { type ImportDeps, idFor, workOnImports } from '../import/job';
import { cancelImport, createImport, listImportsOf } from '../import/service';
import { importTrips } from '../import/trips';
import { listNotices } from '../notices/notices';
import { createProfile } from '../profile/profile';
import { applyMutation } from '../sync/apply';
import { readSealed } from '../media/files';
import { addAttachment, type AttachmentDeps } from '../trips/attachments';
import { addLink } from '../trips/links';
import { addItem, addStop } from '../trips/plan';
import { applyTripMutation } from '../trips/sync';
import { createTrip, getTrip } from '../trips/trips';
import { type ExportDeps, openExport, requestExport, workOnExports } from './export';
import { JSON_NAME, VERSION, parseExport } from './format';
import { waymarkReader } from './reader';

/**
 * Trips in a file (DESIGN.md §22), on whichever database the leg runs on: every trip where the person is an Organizer or a Traveler, whole, with its files, **members by name only**, and nothing that is not theirs to take (an unshared
 * check-in, an address, a trip they follow or are not in); and an import that makes each a new trip with the importer as its only Organizer, once, whole or not at all.
 */
const { leg } = testTarget();
const made = ringOf(randomBytes(32));
if (!made) throw new Error('no ring');
const ring: KeyRing = made;
const sealer = new Sealer(ring);
const [ADA, GRACE, NOOR, HAL, ZED] = [
  'ada-acct',
  'grace-acct',
  'noor-acct',
  'hal-acct',
  'zed-acct',
];
let NOW = Date.parse('2026-09-01T12:00:00Z');
const LISBON = { name: 'Lisbon', lat: 38.7223, lng: -9.1393 };
const PORTO = { name: 'Porto', lat: 41.1579, lng: -8.6291 };
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');

let database: Database;
let close: () => Promise<void>;
let directory: string;
let exportDeps: ExportDeps;
let importDeps: ImportDeps;
let tripDeps: AttachmentDeps;
const t = (name: string) => tableOf(database, name);
const png = () =>
  sharp({ create: { width: 40, height: 30, channels: 3, background: { r: 10, g: 120, b: 30 } } })
    .png()
    .toBuffer();

beforeAll(async () => {
  ({ database, close } = await makeStore());
  directory = mkdtempSync(path.join(tmpdir(), 'waymark-trips-file-'));
  const media = {
    database,
    ring,
    dir: path.join(directory, 'media'),
    maxAccountBytes: 1 << 30,
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
  tripDeps = { database, sealer, now: () => ++NOW, limits: DEFAULT_LIMITS, media };
  for (const [id, name] of [
    [ADA, 'Ada Lovelace'],
    [GRACE, 'Grace Hopper'],
    [NOOR, 'Noor Khan'],
    [HAL, 'Hal Smith'],
    [ZED, 'Zed Stranger'],
  ] as const)
    await createProfile(database, sealer, { accountId: id, name, email: `${id}@example.com` }, NOW);
});
afterAll(async () => {
  await close();
  rmSync(directory, { recursive: true, force: true });
});
beforeEach(async () => {
  NOW += 1000;
  for (const table of [
    'import_job',
    'export_job',
    'relink',
    'trip_tombstone',
    'shared_checkin',
    'attachment',
    'media',
    'trip_link',
    'item',
    'day',
    'stop',
    'place',
    'trip_member',
    'trip',
    'checkin_photo',
    'checkin',
    'notice',
    'account_stream',
    'applied_mutation',
    'tombstone',
  ])
    await dbAll(database, sql`DELETE FROM ${t(table)} RETURNING 1 AS gone`);
});

async function checkIn(
  who: string,
  note: string,
  share: 'trip' | 'on' | 'off',
  at: string,
  where = LISBON,
) {
  const placeId = randomUUID();
  const id = randomUUID();
  const result = await applyMutation(exportDeps, who, {
    mutationId: randomUUID(),
    stream: 'account',
    changes: [
      {
        table: 'place',
        op: 'put',
        id: placeId,
        row: { ...where, source: 'manual', tz: 'Europe/Lisbon', countryCode: 'PT' },
      },
      {
        table: 'checkin',
        op: 'put',
        id,
        row: {
          placeId,
          at: Date.parse(at),
          tz: 'Europe/Lisbon',
          offsetMin: 60,
          note,
          companions: [],
          tripId: null,
          linkSource: null,
          share,
          source: 'live',
        },
      },
    ],
  });
  expect(result.status).toBe('applied');
  return id;
}

/** Ada organizes "Iberia" (Lisbon then Porto) with Grace a Traveler and Noor a Follower; plan, words, a link, two attachments; check-ins of Ada's, Grace's shared and Grace's private. */
async function seed() {
  const trip = await createTrip(tripDeps, ADA, {
    name: 'Iberia',
    description: 'Spring',
    color: 'info',
  });
  for (const [who, role] of [
    [GRACE, 'traveler'],
    [NOOR, 'follower'],
  ] as const)
    await dbAll(
      database,
      sql`INSERT INTO ${t('trip_member')} (trip_id, account_id, role, going, share_checkins, joined_at, seq) VALUES (${trip.id}, ${who}, ${role}, ${role === 'traveler'}, 'ask', ${NOW}, 2) RETURNING trip_id`,
    );
  await addStop(tripDeps, ADA, trip.id, {
    place: LISBON,
    arrive: '2026-05-10',
    depart: '2026-05-12',
    note: 'Hotel Baixa',
  });
  const plan = await addStop(tripDeps, ADA, trip.id, {
    place: PORTO,
    arrive: '2026-05-12',
    depart: '2026-05-14',
  });
  const day = plan?.stops[0]?.days[1];
  if (!day) throw new Error('no day');
  await addItem(tripDeps, ADA, trip.id, {
    dayId: day.id,
    title: 'Dinner',
    kind: 'food',
    start: '20:00',
    fixed: true,
    place: { name: 'Cervejaria', lat: 38.71, lng: -9.14 },
  });
  await addItem(tripDeps, ADA, trip.id, {
    dayId: day.id,
    title: 'Walk',
    kind: 'activity',
    notes: 'along the river',
  });
  await applyTripMutation(tripDeps, ADA, {
    mutationId: randomUUID(),
    stream: `trip:${trip.id}`,
    changes: [
      { table: 'day', op: 'put', id: day.id, row: { title: 'Arrival', notes: 'check in early' } },
    ],
  });
  await addLink(tripDeps, ADA, trip.id, { url: 'https://example.org/plan', title: 'Plan' });
  await addAttachment(tripDeps, ADA, trip.id, {
    bytes: PDF,
    title: 'Booking',
    kind: 'booking',
    dayId: day.id,
  });
  await addAttachment(tripDeps, ADA, trip.id, {
    bytes: await png(),
    title: 'Ticket',
    kind: 'ticket',
  });
  // Check-ins: Ada's own, Grace's shared, Grace's private; a trip Ada only follows, and one she is not in.
  const mine = await checkIn(ADA, 'Ada was here', 'trip', '2026-05-11T12:00:00+01:00');
  await checkIn(GRACE, 'Grace shares this', 'on', '2026-05-11T13:00:00+01:00');
  await checkIn(GRACE, 'PRIVATE-PLANTED-NOTE', 'off', '2026-05-11T14:00:00+01:00');
  const followed = await createTrip(tripDeps, GRACE, { name: 'Followed trip' });
  await dbAll(
    database,
    sql`INSERT INTO ${t('trip_member')} (trip_id, account_id, role, going, share_checkins, joined_at, seq) VALUES (${followed.id}, ${ADA}, 'follower', ${false}, 'ask', ${NOW}, 2) RETURNING trip_id`,
  );
  await createTrip(tripDeps, ZED, { name: 'Zed’s trip' });
  return { tripId: trip.id, mine };
}

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
const documentOf = (zip: Buffer) => {
  const files = unzipSync(new Uint8Array(zip));
  return { json: JSON.parse(Buffer.from(files[JSON_NAME] as Uint8Array).toString('utf8')), files };
};
async function importFile(who: string, bytes: Uint8Array) {
  const created = await createImport(importDeps, {
    accountId: who,
    source: 'waymark',
    body: (async function* () {
      yield bytes;
    })(),
  });
  if (!created.ok) throw new Error(`refused: ${created.reason}`);
  await workOnImports(importDeps);
  return (await listImportsOf(importDeps, who, 50)).find((each) => each.id === created.id);
}
const tripsOf = async (who: string) =>
  dbAll<{ id: string }>(
    database,
    sql`SELECT trip_id AS id FROM ${t('trip_member')} WHERE account_id = ${who} AND left_at IS NULL`,
  );

describe(`the trips in an export (${leg})`, () => {
  it('holds every trip the person organizes or travels on, whole, with its files; and passes the format’s own check', async () => {
    const { tripId, mine } = await seed();
    const zip = await exportOf(ADA);
    const { json, files } = documentOf(zip);
    expect(json.version).toBe(VERSION);
    expect(json.trips).toHaveLength(1);
    const trip = json.trips[0];
    expect(trip).toMatchObject({
      id: tripId,
      name: 'Iberia',
      description: 'Spring',
      color: 'info',
      ready: false,
    });
    expect(trip.stops.map((s: { arrive: string; note?: string }) => [s.arrive, s.note])).toEqual([
      ['2026-05-10', 'Hotel Baixa'],
      ['2026-05-12', undefined],
    ]);
    expect(trip.places.map((p: { name: string }) => p.name).sort()).toEqual([
      'Cervejaria',
      'Lisbon',
      'Porto',
    ]);
    expect(trip.days).toHaveLength(6);
    expect(trip.days.find((d: { title?: string }) => d.title)).toMatchObject({
      title: 'Arrival',
      notes: 'check in early',
    });
    expect(trip.items.map((i: { title: string }) => i.title).sort()).toEqual(['Dinner', 'Walk']);
    expect(trip.items.find((i: { title: string }) => i.title === 'Dinner')).toMatchObject({
      kind: 'food',
      start: '20:00',
      fixed: true,
    });
    expect(trip.links).toEqual([
      expect.objectContaining({ title: 'Plan', url: 'https://example.org/plan' }),
    ]);
    // The attachments are files beside it, byte for byte (a PDF is kept as it is).
    const booking = trip.attachments.find((a: { title: string }) => a.title === 'Booking');
    expect(booking.dayId).toBe(trip.days.find((d: { title?: string }) => d.title).id);
    expect(Buffer.from(files[booking.file] as Uint8Array).equals(PDF)).toBe(true);
    expect(trip.attachments).toHaveLength(2);
    // The person’s own check-in is linked to it in the file, and the trip names it.
    expect(json.checkins.find((c: { id: string }) => c.id === mine)?.tripId).toBe(tripId);
    expect(trip.checkins).toEqual([mine]);
    expect(parseExport(json, NOW).ok).toBe(true);
  });

  it('holds the members by name and part only, what others shared as text, and nothing that is not the person’s to take', async () => {
    await seed();
    const { json } = documentOf(await exportOf(ADA));
    const text = JSON.stringify(json);
    const trip = json.trips[0];
    expect(trip.members).toEqual(
      expect.arrayContaining([
        { name: 'Ada Lovelace', role: 'organizer' },
        { name: 'Grace Hopper', role: 'traveler' },
        { name: 'Noor Khan', role: 'follower' },
      ]),
    );
    expect(trip.members).toHaveLength(3);
    // Grace shared one check-in with the trip: it is there as text, by her name; her private one is not.
    expect(trip.shared).toEqual([
      expect.objectContaining({ author: 'Grace Hopper', note: 'Grace shares this' }),
    ]);
    expect(text).not.toContain('PRIVATE-PLANTED-NOTE');
    expect(Object.keys(trip.shared[0])).not.toContain('photos');
    // No address of anyone’s, and nothing of a trip she follows or is not in.
    expect(text).not.toContain('@example.com');
    expect(text).not.toContain('Followed trip');
    expect(text).not.toContain('Zed');
    // The Follower’s own export has none of the trip: it is not hers to take.
    expect(documentOf(await exportOf(NOOR)).json.trips).toEqual([]);
    // Grace, a Traveler, takes it too, and her private check-in is hers to take with her own.
    const grace = documentOf(await exportOf(GRACE)).json;
    expect(grace.trips.map((x: { name: string }) => x.name).sort()).toEqual([
      'Followed trip',
      'Iberia',
    ]);
    expect(JSON.stringify(grace)).toContain('PRIVATE-PLANTED-NOTE');
  });
});

describe(`importing the trips of a file (${leg})`, () => {
  it('makes each a new trip with the importer as its only Organizer, the other members’ names in its description, and the plan and files whole', async () => {
    const { tripId } = await seed();
    const first = await exportOf(ADA);
    const view = await importFile(HAL, first);
    expect(view).toMatchObject({ status: 'done', tripsMade: 1 });
    const mineHal = await tripsOf(HAL);
    expect(mineHal).toHaveLength(1);
    expect(mineHal[0]?.id).toBe(idFor('trip', HAL, tripId));
    const got = await getTrip(tripDeps, HAL, mineHal[0]?.id ?? '');
    expect(got?.trip).toMatchObject({
      name: 'Iberia',
      role: 'organizer',
      color: 'info',
      startDate: '2026-05-10',
      endDate: '2026-05-14',
    });
    expect(got?.members.map((m) => [m.name, m.role])).toEqual([['Hal Smith', 'organizer']]);
    expect(got?.trip.description).toContain('Spring');
    expect(got?.trip.description).toContain('Ada Lovelace (Organizer)');
    expect(got?.trip.description).toContain('Grace Hopper (Traveler)');
    expect(got?.trip.description).toContain('Noor Khan (Follower)');
    expect(got?.trip.description).not.toContain('Hal Smith');
    // The second export holds the same plan but for ids, members, and what others shared.
    const second = documentOf(await exportOf(HAL)).json.trips[0];
    const firstTrip = documentOf(first).json.trips[0];
    const plan = (trip: typeof firstTrip) => ({
      name: trip.name,
      color: trip.color,
      stops: trip.stops.map((s: Record<string, unknown>) => [s.arrive, s.depart, s.note]),
      days: trip.days.map((d: Record<string, unknown>) => [d.date, d.title, d.notes]).sort(),
      items: trip.items
        .map((i: Record<string, unknown>) => [i.title, i.notes, i.kind, i.start, i.end, i.fixed])
        .sort(),
      links: trip.links.map((l: Record<string, unknown>) => [l.kind, l.title, l.url]),
      attachments: trip.attachments
        .map((a: Record<string, unknown>) => [a.kind, a.title, a.type])
        .sort(),
      places: trip.places.map((p: Record<string, unknown>) => p.name).sort(),
    });
    expect(plan(second)).toEqual(plan(firstTrip));
    expect(second.members).toEqual([{ name: 'Hal Smith', role: 'organizer' }]);
    expect(second.shared).toEqual([]);
    // The item sits on the right day, and the attachment on its day, and the files are Hal’s trip’s.
    const dayWords = second.days.find((d: { title?: string }) => d.title);
    expect(second.items.find((i: { title: string }) => i.title === 'Dinner').dayId).toBe(
      dayWords.id,
    );
    expect(second.attachments.find((a: { title: string }) => a.title === 'Booking').dayId).toBe(
      dayWords.id,
    );
    const file = await dbGet<{ id: string }>(
      database,
      sql`SELECT media_id AS id FROM ${t('attachment')} WHERE trip_id = ${mineHal[0]?.id ?? ''} AND kind = 'booking'`,
    );
    expect((await readSealed(exportDeps.media.dir, file?.id ?? '', ring))?.equals(PDF)).toBe(true);
    // Told once, with the trip counted.
    const told = (await listNotices(importDeps, HAL)).filter(
      (n) => n.title === 'Your import has finished',
    );
    expect(told).toHaveLength(1);
    expect(told[0]?.detail).toContain('1 trip');
    // Ada's own trip is untouched.
    expect((await getTrip(tripDeps, ADA, tripId))?.members).toHaveLength(3);
  });

  it('does not list the importer among the others when they import their own file', async () => {
    await seed();
    const view = await importFile(ADA, await exportOf(ADA));
    expect(view).toMatchObject({ status: 'done', tripsMade: 1 });
    const copy = (await tripsOf(ADA)).find(
      (each) => each.id !== undefined && each.id.startsWith('') && true,
    );
    const copies = await dbAll<{ id: string }>(
      database,
      sql`SELECT trip_id AS id FROM ${t('trip_member')} WHERE account_id = ${ADA} AND role = 'organizer'`,
    );
    expect(copies).toHaveLength(2);
    expect(copy).toBeDefined();
    const imported = (
      await Promise.all(copies.map((each) => getTrip(tripDeps, ADA, each.id)))
    ).find((got) => got?.trip.description?.includes('On this trip'));
    expect(imported?.trip.description).toContain('Grace Hopper (Traveler)');
    expect(imported?.trip.description).not.toContain('Ada Lovelace');
  });

  it('links the importer’s check-ins that fall within the trip’s dates, once the job has run', async () => {
    await seed();
    await importFile(HAL, await exportOf(ADA));
    await workOnRelinks({ database, sealer, now: () => NOW }, { budgetMs: 5_000 });
    const linked = await dbAll<{ n: number | string }>(
      database,
      sql`SELECT COUNT(*) AS n FROM ${t('checkin')} WHERE account_id = ${HAL} AND trip_id IS NOT NULL`,
    );
    expect(Number(linked[0]?.n)).toBe(1);
  });

  it('makes nothing the second time, and a file with no trips (version 1) imports as before', async () => {
    await seed();
    const file = await exportOf(ADA);
    await importFile(HAL, file);
    const again = await importFile(HAL, file);
    expect(again).toMatchObject({ status: 'done', tripsMade: 0 });
    expect(await tripsOf(HAL)).toHaveLength(1);
    // A version 1 file: no `trips`.
    const { json } = documentOf(file);
    const { trips: _trips, ...old } = json;
    expect(parseExport({ ...old, version: 1 }, NOW)).toMatchObject({ ok: true });
    const parsedOld = parseExport({ ...old, version: 1 }, NOW);
    expect(parsedOld.ok && parsedOld.value.trips).toEqual([]);
    expect(parseExport({ ...old, version: VERSION + 1 }, NOW).ok).toBe(false);
  });

  it('is whole or not at all: a trip that cannot be made leaves no row of it', async () => {
    const { tripId } = await seed();
    const { json } = documentOf(await exportOf(ADA));
    const parsed = parseExport(json, NOW);
    if (!parsed.ok) throw new Error('not parsed');
    const trip = parsed.value.trips[0];
    if (!trip) throw new Error('no trip');
    // An item of another trip already holds the id this trip’s item would have.
    const clash = idFor('item', HAL, `${tripId}:${trip.items[0]?.id}`);
    await dbAll(
      database,
      sql`INSERT INTO ${t('item')} (id, trip_id, day_id, kind, fixed, position, version, seq, sealed, created_at, updated_at) VALUES (${clash}, ${randomUUID()}, ${randomUUID()}, 'other', ${false}, 'a0', 1, 1, ${sealer.seal('item', clash, {})}, ${NOW}, ${NOW}) RETURNING id`,
    );
    await expect(
      importTrips({ database, sealer, now: () => NOW, media: exportDeps.media }, HAL, {
        trips: parsed.value.trips,
        load: async () => PDF,
      }),
    ).rejects.toThrow();
    expect(await tripsOf(HAL)).toEqual([]);
    for (const table of ['stop', 'day', 'place', 'trip_link', 'attachment'])
      expect(
        Number(
          (
            await dbGet<{ n: number | string }>(
              database,
              sql`SELECT COUNT(*) AS n FROM ${t(table)} WHERE trip_id = ${idFor('trip', HAL, tripId)}`,
            )
          )?.n,
        ),
        table,
      ).toBe(0);
  });

  it('can be stopped and carried on: a cancelled import makes no trip, and a restart after the trips were made makes none twice', async () => {
    await seed();
    const file = await exportOf(ADA);
    const created = await createImport(importDeps, {
      accountId: HAL,
      source: 'waymark',
      body: (async function* () {
        yield file;
      })(),
    });
    if (!created.ok) throw new Error('refused');
    await cancelImport(importDeps, HAL, created.id);
    await workOnImports(importDeps);
    expect(await tripsOf(HAL)).toEqual([]);
    // Made by hand twice over: the second finds it there.
    const parsed = parseExport(documentOf(file).json, NOW);
    if (!parsed.ok) throw new Error('not parsed');
    const source = { trips: parsed.value.trips, load: async () => PDF };
    const deps = { database, sealer, now: () => NOW, media: exportDeps.media };
    expect(await importTrips(deps, HAL, source)).toMatchObject({ made: 1, skipped: 0 });
    expect(await importTrips(deps, HAL, source)).toMatchObject({ made: 0, skipped: 1 });
    await enqueueRelink(database, idFor('trip', HAL, parsed.value.trips[0]?.id ?? ''), NOW);
  });
});

describe('a file’s trips', () => {
  const base = async () => {
    await seed();
    return documentOf(await exportOf(ADA)).json;
  };
  it('are refused, whole, when anything in them is not valid or does not hang together', async () => {
    const json = await base();
    /** Sets the value at a path of the first trip, in a copy of the file, and says whether the file is still accepted. */
    const accepted = (path: (string | number)[], value: unknown) => {
      const copy = JSON.parse(JSON.stringify(json));
      let at = copy.trips[0] as Record<string | number, unknown>;
      for (const key of path.slice(0, -1)) at = at[key] as Record<string | number, unknown>;
      const last = path.at(-1) as string | number;
      // `undefined` is not JSON: the key is simply not there in the file.
      at[last] = value;
      return parseExport(copy, NOW).ok;
    };
    expect(accepted(['name'], 'Iberia')).toBe(true);
    const id = randomUUID();
    const first = json.trips[0];
    for (const [label, path, value] of [
      ['a stop at an unknown place', ['stops', 0, 'placeId'], id],
      ['overlapping stops', ['stops', 1, 'arrive'], '2026-05-11'],
      ['a day at an unknown stop', ['days', 0, 'stopId'], id],
      ['a day outside its stop', ['days', 0, 'date'], '2030-01-01'],
      ['an item on an unknown day', ['items', 0, 'dayId'], id],
      ['an item with a kind that is not one', ['items', 0, 'kind'], 'party'],
      ['a link that is not https', ['links', 0, 'url'], 'http://example.org'],
      ['an attachment in a folder', ['attachments', 0, 'file'], '../x.pdf'],
      ['two attachments in one file', ['attachments', 1, 'file'], first.attachments[0].file],
      ['an unknown colour', ['color'], 'plaid'],
      ['an unknown role', ['members', 0, 'role'], 'boss'],
      ['a check-in the file does not hold', ['checkins', 5], id],
      ['a name that is many lines', ['name'], 'a\nb'],
      ['a missing list', ['items'], undefined],
    ] as [string, (string | number)[], unknown][])
      expect(accepted(path, value), label).toBe(false);
  });

  it('are refused at the door when an attachment’s file is not in the ZIP, before anything is made', async () => {
    await seed();
    const { json, files } = documentOf(await exportOf(ADA));
    const { ZipWriter } = await import('./zip');
    const zip = new ZipWriter(new Date(NOW));
    const chunks: Uint8Array[] = [];
    for (const [name, bytes] of Object.entries(files)) {
      if (name === json.trips[0].attachments[0].file) continue;
      for await (const chunk of zip.add(name, Buffer.from(bytes as Uint8Array))) chunks.push(chunk);
    }
    for await (const chunk of zip.finish()) chunks.push(chunk);
    const view = await importFile(HAL, Buffer.concat(chunks));
    expect(view?.status).toBe('failed');
    expect(await tripsOf(HAL)).toEqual([]);
  });
});
