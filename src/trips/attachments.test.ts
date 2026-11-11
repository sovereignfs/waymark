import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import sharp from 'sharp';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { tableOf } from '../access/trip';
import { DEFAULT_LIMITS } from '../config';
import { ringOf } from '../crypto/keys';
import { Sealer } from '../crypto/sealed';
import type { Database } from '../db/client';
import { dbAll, dbGet } from '../db/exec';
import { makeStore, testTarget } from '../db/test-support';
import { MAX_FILE_BYTES, putMedia, readMedia, usageOf } from '../media/service';
import { sweepOrphans } from '../media/service';
import { TITLE_HEADER, uploadResponse } from './attachments-http';
import {
  type AttachmentDeps,
  AttachmentRefused,
  addAttachment,
  deleteAttachment,
  listAttachments,
  readAttachmentFile,
  readFileFor,
  updateAttachment,
} from './attachments';
import { addStop, removeStop } from './plan';
import { createTrip, deleteTrip } from './trips';

/**
 * A trip's attachments (DESIGN.md §10.6, §11.1) against whichever database the leg runs on: files judged by their bytes, sealed on disk, **seen and added by Organizers and Travelers and never by Followers** (their row, their file
 * and their thumbnail are not there), deleted with their trip, and never found by a person's own file route.
 */
const { leg } = testTarget();
const ring = ringOf(randomBytes(32));
if (!ring) throw new Error('no ring');
const sealer = new Sealer(ring);
const [ADA, SAM, NOOR, STRANGER, GONE] = [
  'ada-acct',
  'sam-acct',
  'noor-acct',
  'stranger-acct',
  'gone-acct',
];
let NOW = 1_800_000_000_000;
let database: Database;
let close: () => Promise<void>;
let directory: string;
let deps: AttachmentDeps;
let tripId: string;
let otherTrip: string;
let dayId: string;

const PDF = Buffer.from(
  '%PDF-1.4\n1 0 obj<<>>endobj\nBOOKING REFERENCE ABC123\ntrailer<<>>\n%%EOF\n',
);
const t = (name: string) => tableOf(database, name);
const count = async (table: string, where = sql``): Promise<number> =>
  Number(
    (
      await dbGet<{ n: number | string }>(
        database,
        sql`SELECT COUNT(*) AS n FROM ${t(table)} ${where}`,
      )
    )?.n ?? 0,
  );
const files = () => (existsSync(deps.media.dir) ? readdirSync(deps.media.dir) : []);
const png = () =>
  sharp({ create: { width: 40, height: 30, channels: 3, background: { r: 10, g: 120, b: 30 } } })
    .png()
    .toBuffer();
const refusal = async (promise: Promise<unknown>): Promise<AttachmentRefused> => {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(AttachmentRefused);
  return error as AttachmentRefused;
};

beforeAll(async () => {
  ({ database, close } = await makeStore());
  directory = mkdtempSync(path.join(tmpdir(), 'waymark-attach-'));
  deps = {
    database,
    sealer,
    now: () => ++NOW,
    limits: DEFAULT_LIMITS,
    media: {
      database,
      ring,
      dir: path.join(directory, 'media'),
      maxAccountBytes: 1 << 30,
      now: () => NOW,
    },
  };
});
afterAll(async () => {
  await close();
  rmSync(directory, { recursive: true, force: true });
});
beforeEach(async () => {
  rmSync(deps.media.dir, { recursive: true, force: true });
  deps = { ...deps, limits: DEFAULT_LIMITS, media: { ...deps.media, now: () => NOW } };
  for (const table of [
    'attachment',
    'media',
    'item',
    'day',
    'stop',
    'place',
    'trip_member',
    'trip',
  ])
    await dbAll(database, sql`DELETE FROM ${t(table)} RETURNING 1 AS gone`);
  tripId = (await createTrip(deps, ADA, { name: 'Iberia' })).id;
  otherTrip = (await createTrip(deps, ADA, { name: 'Other' })).id;
  for (const [id, role, left] of [
    [SAM, 'traveler', false],
    [NOOR, 'follower', false],
    [GONE, 'traveler', true],
  ] as const)
    await dbAll(
      database,
      sql`INSERT INTO ${t('trip_member')} (trip_id, account_id, role, going, share_checkins, joined_at, left_at, seq) VALUES (${tripId}, ${id}, ${role}, ${role !== 'follower'}, 'ask', ${NOW}, ${left ? NOW : null}, 2) RETURNING trip_id`,
    );
  const plan = await addStop(deps, ADA, tripId, {
    place: { name: 'Lisbon', lat: 38.7, lng: -9.1 },
    arrive: '2026-05-01',
    depart: '2026-05-03',
  });
  dayId = plan?.stops[0]?.days[0]?.id ?? '';
});

describe(`adding an attachment (${leg})`, () => {
  it('keeps a PDF as it is, with the title and kind, on the trip, and the file is sealed on disk', async () => {
    const added = await addAttachment(deps, ADA, tripId, {
      bytes: PDF,
      title: '  Hotel booking  ',
      kind: 'accommodation',
    });
    expect(added).toMatchObject({
      title: 'Hotel booking',
      kind: 'accommodation',
      dayId: null,
      type: 'application/pdf',
      bytes: PDF.length,
      thumbId: null,
      createdBy: ADA,
    });
    expect((await readAttachmentFile(deps, ADA, added?.fileId ?? ''))?.bytes.equals(PDF)).toBe(
      true,
    );
    // On disk it is an envelope: the booking reference is nowhere in the file.
    expect(files()).toHaveLength(1);
    expect(
      readFileSync(path.join(deps.media.dir, files()[0] ?? '')).toString('latin1'),
    ).not.toContain('BOOKING REFERENCE');
    expect(await count('media', sql`WHERE trip_id = ${tripId} AND account_id IS NULL`)).toBe(1);
  });

  it('re-encodes an image with a thumbnail, and puts an attachment on a day', async () => {
    const added = await addAttachment(deps, ADA, tripId, {
      bytes: await png(),
      title: 'Ticket',
      kind: 'ticket',
      dayId,
    });
    expect(added).toMatchObject({ type: 'image/webp', dayId, kind: 'ticket' });
    expect(added?.thumbId).toBeTruthy();
    expect((await readAttachmentFile(deps, ADA, added?.thumbId ?? ''))?.type).toBe('image/webp');
    expect(files()).toHaveLength(2);
  });

  it('seals the title: the database holds it nowhere', async () => {
    await addAttachment(deps, ADA, tripId, { bytes: PDF, title: 'Passport scan for Ada Lovelace' });
    const rows = await dbAll<{ sealed: Uint8Array }>(
      database,
      sql`SELECT sealed FROM ${t('attachment')}`,
    );
    expect(Buffer.from(rows[0]?.sealed ?? []).toString('latin1')).not.toContain('Passport');
  });

  it('is judged by its bytes: an HTML page named .pdf, an empty file and a file that is too big are refused with the store’s own sentence, and nothing is kept', async () => {
    expect(
      (
        await refusal(
          addAttachment(deps, ADA, tripId, {
            bytes: Buffer.from('<html><script>alert(1)</script></html>'),
            title: 'booking.pdf',
          }),
        )
      ).reason,
    ).toBe('not_allowed');
    expect(
      (await refusal(addAttachment(deps, ADA, tripId, { bytes: new Uint8Array(), title: 'x' })))
        .reason,
    ).toBe('unreadable');
    expect(
      (
        await refusal(
          addAttachment(deps, ADA, tripId, {
            bytes: Buffer.concat([PDF, Buffer.alloc(MAX_FILE_BYTES)]),
            title: 'x',
          }),
        )
      ).reason,
    ).toBe('too_big');
    expect(await count('attachment')).toBe(0);
    expect(await count('media')).toBe(0);
    expect(files()).toEqual([]);
  });

  it('refuses a title, a kind and a day that are not an attachment’s, before the file is stored', async () => {
    for (const bad of [
      { title: '' },
      { title: '   ' },
      { title: 'a\nb' },
      { title: 'x'.repeat(201) },
      { title: 5 },
      { title: 'ok', kind: 'selfie' },
      { title: 'ok', dayId: 'nope' },
      { title: 'ok', dayId: randomUUID() },
    ])
      expect(
        (await refusal(addAttachment(deps, ADA, tripId, { bytes: PDF, ...bad }))).reason,
        JSON.stringify(bad),
      ).toBe('invalid');
    // A day of another trip is not this trip's.
    const foreign = (
      await addStop(deps, ADA, otherTrip, {
        place: { name: 'E', lat: 1, lng: 2 },
        arrive: '2026-09-01',
        depart: '2026-09-01',
      })
    )?.stops[0]?.days[0]?.id;
    await refusal(addAttachment(deps, ADA, tripId, { bytes: PDF, title: 'x', dayId: foreign }));
    expect(files()).toEqual([]);
    expect(await count('media')).toBe(0);
  });

  it('is refused past the trip’s limit, in a sentence, and stores nothing of the extra', async () => {
    const limited = { ...deps, limits: { ...DEFAULT_LIMITS, tripAttachments: 2 } };
    await addAttachment(limited, ADA, tripId, { bytes: PDF, title: '1' });
    await addAttachment(limited, ADA, tripId, { bytes: PDF, title: '2' });
    const refused = await refusal(addAttachment(limited, SAM, tripId, { bytes: PDF, title: '3' }));
    expect(refused).toMatchObject({ reason: 'limit' });
    expect(refused.sentence).toContain('at most 2');
    expect(files()).toHaveLength(2);
    expect(await count('attachment')).toBe(2);
    // Another trip is not held by it, and the limit is never a reason to delete what is over a lowered one.
    await addAttachment(limited, ADA, otherTrip, { bytes: PDF, title: 'elsewhere' });
    const lowered = { ...deps, limits: { ...DEFAULT_LIMITS, tripAttachments: 1 } };
    expect((await listAttachments(lowered, ADA, tripId))?.length).toBe(2);
  });

  it('is for an Organizer or a Traveler: a Follower, a former member and a stranger are told the trip is not there, and the file is not stored', async () => {
    expect(
      await addAttachment(deps, SAM, tripId, { bytes: PDF, title: 'By a Traveler' }),
    ).toBeDefined();
    for (const who of [NOOR, GONE, STRANGER])
      expect(
        await addAttachment(deps, who, tripId, { bytes: PDF, title: 'No' }),
        who,
      ).toBeUndefined();
    expect(
      await addAttachment(deps, ADA, randomUUID(), { bytes: PDF, title: 'No' }),
    ).toBeUndefined();
    expect(
      await addAttachment(deps, ADA, 'not-an-id', { bytes: PDF, title: 'No' }),
    ).toBeUndefined();
    expect(await count('attachment')).toBe(1);
    expect(files()).toHaveLength(1);
  });

  it('removes the file again when the caller was lowered to Follower while it was being stored', async () => {
    const racing = {
      ...deps,
      // The media store asks the time as it makes its row: at that moment the Organizer takes the Traveler's role away.
      media: {
        ...deps.media,
        now: () => {
          void dbAll(
            database,
            sql`UPDATE ${t('trip_member')} SET role = 'follower' WHERE trip_id = ${tripId} AND account_id = ${SAM} RETURNING 1 AS x`,
          );
          return NOW;
        },
      },
    };
    // The update above is not awaited and may land after; do it here to be certain the role is lowered before the row is written.
    await dbAll(
      database,
      sql`UPDATE ${t('trip_member')} SET role = 'follower' WHERE trip_id = ${tripId} AND account_id = ${SAM} RETURNING 1 AS x`,
    );
    expect(
      await addAttachment(racing, SAM, tripId, { bytes: PDF, title: 'Too late' }),
    ).toBeUndefined();
    expect(await count('attachment')).toBe(0);
    expect(await count('media')).toBe(0);
    expect(files()).toEqual([]);
  });
});

describe(`seeing attachments (${leg})`, () => {
  async function made() {
    const doc = await addAttachment(deps, ADA, tripId, { bytes: PDF, title: 'Receipt' });
    const image = await addAttachment(deps, ADA, tripId, {
      bytes: await png(),
      title: 'Ticket',
      dayId,
    });
    if (!doc || !image) throw new Error('attachments were not made');
    return { doc, image };
  }

  it('lists them oldest first for an Organizer and a Traveler, and says nothing of them to a Follower, a former member or a stranger', async () => {
    await made();
    for (const who of [ADA, SAM])
      expect(
        (await listAttachments(deps, who, tripId))?.map((a) => a.title),
        who,
      ).toEqual(['Receipt', 'Ticket']);
    for (const who of [NOOR, GONE, STRANGER])
      expect(await listAttachments(deps, who, tripId), who).toBeUndefined();
    expect(await listAttachments(deps, ADA, otherTrip)).toEqual([]);
    expect(await listAttachments(deps, SAM, otherTrip)).toBeUndefined();
  });

  it('serves a file and a thumbnail to an Organizer and a Traveler, and to nobody else: a Follower gets not found for the file, and for the thumbnail', async () => {
    const { doc, image } = await made();
    for (const who of [ADA, SAM]) {
      expect((await readFileFor(deps.media, who, doc.fileId))?.bytes.equals(PDF), who).toBe(true);
      expect((await readFileFor(deps.media, who, image.fileId))?.type).toBe('image/webp');
      expect((await readFileFor(deps.media, who, image.thumbId ?? ''))?.type).toBe('image/webp');
    }
    for (const who of [NOOR, GONE, STRANGER])
      for (const id of [doc.fileId, image.fileId, image.thumbId ?? ''])
        expect(await readFileFor(deps.media, who, id), `${who} ${id}`).toBeUndefined();
    expect(await readFileFor(deps.media, ADA, 'not-an-id')).toBeUndefined();
  });

  it('is never found by a person’s own file route, for the person who added it either: a trip’s file has no account', async () => {
    const { doc } = await made();
    expect(await readMedia(deps.media, { accountId: ADA, id: doc.fileId })).toBeUndefined();
    // And a person's own file is not served through a trip.
    const mine = await putMedia(deps.media, { accountId: ADA, kind: 'attachment', bytes: PDF });
    if (!mine.ok) throw new Error('could not store');
    expect((await readFileFor(deps.media, ADA, mine.id))?.type).toBe('application/pdf');
    expect(await readAttachmentFile(deps, ADA, mine.id)).toBeUndefined();
    expect(await readFileFor(deps.media, SAM, mine.id)).toBeUndefined();
  });

  it('is not counted against anyone’s room, since a trip’s file has no account', async () => {
    const before = await usageOf(database, ADA);
    await made();
    expect(await usageOf(database, ADA)).toBe(before);
  });

  it('is served by the file’s id from the attachment’s own trip only: another trip’s member does not see it', async () => {
    const { doc } = await made();
    await dbAll(
      database,
      sql`INSERT INTO ${t('trip_member')} (trip_id, account_id, role, going, share_checkins, joined_at, seq) VALUES (${otherTrip}, ${SAM}, 'traveler', ${true}, 'ask', ${NOW}, 2) RETURNING trip_id`,
    );
    // Sam is a Traveler of both, so he sees it; a Traveler of only the other trip does not.
    expect(await readFileFor(deps.media, SAM, doc.fileId)).toBeDefined();
    await dbAll(
      database,
      sql`INSERT INTO ${t('trip_member')} (trip_id, account_id, role, going, share_checkins, joined_at, seq) VALUES (${otherTrip}, ${'third-acct'}, 'traveler', ${true}, 'ask', ${NOW}, 2) RETURNING trip_id`,
    );
    expect(await readFileFor(deps.media, 'third-acct', doc.fileId)).toBeUndefined();
  });
});

describe(`changing and deleting attachments (${leg})`, () => {
  it('renames, changes the kind, and moves between a day and the trip, advancing the trip’s counter', async () => {
    const added = await addAttachment(deps, ADA, tripId, {
      bytes: PDF,
      title: 'Old',
      kind: 'other',
    });
    const seq = Number(
      (
        await dbGet<{ seq: number | string }>(
          database,
          sql`SELECT seq FROM ${t('trip')} WHERE id = ${tripId}`,
        )
      )?.seq,
    );
    const renamed = await updateAttachment(deps, SAM, tripId, added?.id ?? '', {
      title: 'New',
      kind: 'booking',
    });
    expect(renamed).toMatchObject({
      title: 'New',
      kind: 'booking',
      dayId: null,
      seq: seq + 1,
      fileId: added?.fileId,
    });
    expect((await updateAttachment(deps, ADA, tripId, added?.id ?? '', { dayId }))?.dayId).toBe(
      dayId,
    );
    expect(
      (await updateAttachment(deps, ADA, tripId, added?.id ?? '', { dayId: null }))?.dayId,
    ).toBeNull();
    await refusal(updateAttachment(deps, ADA, tripId, added?.id ?? '', { title: '' }));
    await refusal(updateAttachment(deps, ADA, tripId, added?.id ?? '', { kind: 'x' }));
    await refusal(updateAttachment(deps, ADA, tripId, added?.id ?? '', { dayId: randomUUID() }));
    await refusal(updateAttachment(deps, ADA, tripId, added?.id ?? '', {}));
    expect((await listAttachments(deps, ADA, tripId))?.[0]).toMatchObject({
      title: 'New',
      kind: 'booking',
      dayId: null,
    });
  });

  it('is for an Organizer or a Traveler, and an attachment of another trip is not found', async () => {
    const added = await addAttachment(deps, ADA, tripId, { bytes: PDF, title: 'Keep' });
    for (const who of [NOOR, GONE, STRANGER]) {
      expect(
        await updateAttachment(deps, who, tripId, added?.id ?? '', { title: 'Taken' }),
        who,
      ).toBeUndefined();
      expect(await deleteAttachment(deps, who, tripId, added?.id ?? ''), who).toBe(false);
    }
    expect(
      await updateAttachment(deps, ADA, otherTrip, added?.id ?? '', { title: 'Wrong trip' }),
    ).toBeUndefined();
    expect(await deleteAttachment(deps, ADA, otherTrip, added?.id ?? '')).toBe(false);
    expect((await listAttachments(deps, ADA, tripId))?.[0]?.title).toBe('Keep');
    expect(files()).toHaveLength(1);
  });

  it('deletes the row, its media rows and its files, once', async () => {
    const image = await addAttachment(deps, ADA, tripId, { bytes: await png(), title: 'Ticket' });
    expect(files()).toHaveLength(2);
    expect(await deleteAttachment(deps, SAM, tripId, image?.id ?? '')).toBe(true);
    expect(await count('attachment')).toBe(0);
    expect(await count('media')).toBe(0);
    expect(files()).toEqual([]);
    expect(await deleteAttachment(deps, SAM, tripId, image?.id ?? '')).toBe(false);
  });

  it('becomes the trip’s when the day it was on goes, and is not lost with it', async () => {
    const added = await addAttachment(deps, ADA, tripId, {
      bytes: PDF,
      title: 'On the day',
      dayId,
    });
    const stop =
      (
        await dbGet<{ id: string }>(
          database,
          sql`SELECT id FROM ${t('stop')} WHERE trip_id = ${tripId}`,
        )
      )?.id ?? '';
    await removeStop(deps, ADA, tripId, stop);
    expect((await listAttachments(deps, ADA, tripId))?.[0]).toMatchObject({
      id: added?.id,
      dayId: null,
    });
    expect((await readFileFor(deps.media, ADA, added?.fileId ?? ''))?.bytes.equals(PDF)).toBe(true);
  });
});

describe(`deleting the trip (${leg})`, () => {
  it('deletes its attachments, their media rows and their files, and no other trip’s', async () => {
    await addAttachment(deps, ADA, tripId, { bytes: PDF, title: 'a' });
    await addAttachment(deps, ADA, tripId, { bytes: await png(), title: 'b' });
    const keep = await addAttachment(deps, ADA, otherTrip, { bytes: PDF, title: 'keep' });
    expect(files()).toHaveLength(4);
    expect(await deleteTrip(deps, ADA, tripId)).toBe(true);
    expect(await count('attachment', sql`WHERE trip_id = ${tripId}`)).toBe(0);
    expect(await count('media', sql`WHERE trip_id = ${tripId}`)).toBe(0);
    expect(files()).toHaveLength(1);
    expect((await readFileFor(deps.media, ADA, keep?.fileId ?? ''))?.bytes.equals(PDF)).toBe(true);
  });

  it('leaves files with no row for the sweep when there is no store to remove them from, and the sweep takes them', async () => {
    await addAttachment(deps, ADA, tripId, { bytes: PDF, title: 'a' });
    const { media: _media, ...without } = deps;
    expect(await deleteTrip(without, ADA, tripId)).toBe(true);
    expect(files()).toHaveLength(1);
    const later = { ...deps.media, now: () => NOW + 2 * 60 * 60 * 1000 };
    // Aged past the grace, the file has no row and goes.
    const { utimesSync } = await import('node:fs');
    const old = new Date(NOW - 3 * 60 * 60 * 1000);
    utimesSync(path.join(deps.media.dir, files()[0] ?? ''), old, old);
    expect((await sweepOrphans(later)).files).toBe(1);
    expect(files()).toEqual([]);
  });
});

describe(`the upload route (${leg})`, () => {
  const upload = (
    who: string,
    body: Uint8Array,
    headers: Record<string, string> = {},
    query = '',
    allowed = true,
  ) =>
    uploadResponse(
      new Request(`https://waymark.test/api/trips/${tripId}/attachments${query}`, {
        method: 'POST',
        // A request's body is a stream of bytes; a Buffer is one, and TypeScript's `BodyInit` has not caught up.
        body: Buffer.from(body) as unknown as BodyInit,
        headers,
      }),
      who,
      tripId,
      { ...deps, takeUpload: async () => allowed },
    );
  const title = (text: string) => ({ [TITLE_HEADER]: encodeURIComponent(text) });

  it('makes the attachment with the title from the header, and says so with 201, and the title is never in the address', async () => {
    const response = await upload(SAM, PDF, title('Flight — TAP 123'), '?kind=ticket');
    expect(response.status).toBe(201);
    expect((await response.json()).attachment).toMatchObject({
      title: 'Flight — TAP 123',
      kind: 'ticket',
      type: 'application/pdf',
    });
  });

  it('answers 404 with nothing for a Follower, a former member and a stranger, and stores no file', async () => {
    for (const who of [NOOR, GONE, STRANGER]) {
      const response = await upload(who, PDF, title('No'));
      expect(response.status, who).toBe(404);
      expect(await response.text()).toBe('');
    }
    expect(files()).toEqual([]);
  });

  it('answers 400 for a title that is missing or not one, 415 for a file that is not a PDF or an image, 413 for one too big, and 429 past the allowance', async () => {
    expect((await upload(ADA, PDF)).status).toBe(400);
    expect((await upload(ADA, PDF, { [TITLE_HEADER]: '%E0%A4%A' })).status).toBe(400);
    expect((await upload(ADA, PDF, title('x'), '?kind=selfie')).status).toBe(400);
    const html = await upload(ADA, Buffer.from('<html></html>'), title('page.pdf'));
    expect(html.status).toBe(415);
    expect(JSON.stringify(await html.json())).not.toContain('page.pdf');
    expect(
      (await upload(ADA, PDF, { ...title('big'), 'content-length': String(MAX_FILE_BYTES + 1) }))
        .status,
    ).toBe(413);
    expect((await upload(ADA, PDF, title('limited'), '', false)).status).toBe(429);
    expect(await count('attachment')).toBe(0);
    expect(files()).toEqual([]);
  });

  it('answers 413 in a sentence when the trip has as many as the server allows', async () => {
    const limited = { ...deps, limits: { ...DEFAULT_LIMITS, tripAttachments: 1 } };
    await addAttachment(limited, ADA, tripId, { bytes: PDF, title: '1' });
    const response = await uploadResponse(
      new Request('https://waymark.test/x', {
        method: 'POST',
        body: new Blob([PDF]),
        headers: title('2'),
      }),
      ADA,
      tripId,
      { ...limited, takeUpload: async () => true },
    );
    expect(response.status).toBe(413);
    expect((await response.json()).message).toContain('at most 1');
  });
});
