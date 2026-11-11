import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
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
import { dbAll, dbGet, transaction } from '../db/exec';
import { makeStore, testTarget } from '../db/test-support';
import { thumbIdOf } from '../media/files';
import { putMedia } from '../media/service';
import { listNotices } from '../notices/notices';
import { setPref } from '../notices/prefs';
import { createProfile, updateProfile } from '../profile/profile';
import { applyMutation } from '../sync/apply';
import { workOnRelinks } from '../autolink/queue';
import { addStop, removeStop } from '../trips/plan';
import { setRole } from '../trips/members';
import { TripError } from '../trips/format';
import { readFileFor } from '../trips/attachments';
import { createTrip, deleteTrip } from '../trips/trips';
import { dropCopiesOf } from './copies';
import { setShareChoice } from './choice';
import { listShared } from './read';

/**
 * Sharing check-ins with a trip (DESIGN.md §11.3, §15.3), against whichever database the leg runs on: **a check-in is private to its author, even when linked to a trip**, and reaches the other members only when shared, as a
 * copy in the trip's stream; unsharing, unlinking, a change of role, leaving and deleting remove it at once; and nothing unshared is ever in an answer to another member.
 */
const { leg } = testTarget();
const ring = ringOf(randomBytes(32));
if (!ring) throw new Error('no ring');
const sealer = new Sealer(ring);
const [ADA, SAM, NOOR, GRACE, STRANGER] = ['ada', 'sam', 'noor', 'grace', 'stranger'];
const NOW = Date.parse('2026-09-01T12:00:00Z');
let database: Database;
let close: () => Promise<void>;
let directory: string;
let deps: Parameters<typeof createTrip>[0] & { media: Parameters<typeof putMedia>[0] };
const t = (name: string) => tableOf(database, name);
const LISBON = { name: 'Lisbon', lat: 38.7223, lng: -9.1393 };
const PORTO = { name: 'Porto', lat: 41.1579, lng: -8.6291 };
const picture = () =>
  sharp({ create: { width: 40, height: 30, channels: 3, background: { r: 10, g: 120, b: 30 } } })
    .png()
    .toBuffer();

/** A trip of Ada's (Organizer) with Sam and Grace as Travelers and Noor as a Follower, and a stop that makes 12 May fall into it. */
async function trip(name = 'Iberia', stop = '2026-05-10') {
  const made = await createTrip(deps, ADA, { name });
  for (const [who, role] of [
    [SAM, 'traveler'],
    [GRACE, 'traveler'],
    [NOOR, 'follower'],
  ] as const)
    await dbAll(
      database,
      sql`INSERT INTO ${t('trip_member')} (trip_id, account_id, role, going, share_checkins, joined_at, seq) VALUES (${made.id}, ${who}, ${role}, ${role === 'traveler'}, 'ask', ${NOW}, 2) RETURNING trip_id`,
    );
  await addStop(deps, ADA, made.id, {
    place: LISBON,
    arrive: stop,
    depart: stop.replace('-10', '-14'),
  });
  return made.id;
}

interface Made {
  readonly id: string;
  readonly placeId: string;
}
/** A check-in through the one write path, as a device would send it. */
async function checkIn(
  who: string,
  options: {
    at?: string;
    share?: 'trip' | 'on' | 'off';
    note?: string;
    companions?: string[];
    photos?: string[];
    link?: { tripId: string | null; linkSource: 'manual' } | undefined;
    ids?: { place?: string; checkin?: string };
    where?: { name: string; lat: number; lng: number };
  } = {},
): Promise<Made> {
  const placeId = options.ids?.place ?? randomUUID();
  const id = options.ids?.checkin ?? randomUUID();
  const where = options.where ?? LISBON;
  const result = await applyMutation({ database, sealer, now: () => NOW }, who, {
    mutationId: randomUUID(),
    stream: 'account',
    changes: [
      {
        table: 'place',
        op: 'put',
        id: placeId,
        row: {
          name: where.name,
          lat: where.lat,
          lng: where.lng,
          source: 'manual',
          tz: 'Europe/Lisbon',
          countryCode: null,
        },
      },
      {
        table: 'checkin',
        op: 'put',
        id,
        row: {
          placeId,
          at: Date.parse(options.at ?? '2026-05-12T12:00:00+01:00'),
          tz: 'Europe/Lisbon',
          offsetMin: 60,
          ...(options.note ? { note: options.note } : {}),
          companions: options.companions ?? [],
          tripId: options.link ? options.link.tripId : null,
          linkSource: options.link ? options.link.linkSource : null,
          share: options.share ?? 'trip',
          source: 'live',
          ...(options.photos ? { photos: options.photos } : {}),
        },
      },
    ],
  });
  if (result.status !== 'applied') throw new Error(`not applied: ${JSON.stringify(result)}`);
  return { id, placeId };
}
const seen = async (who: string, tripId: string) =>
  ((await listShared(database, sealer, who, tripId)) ?? []).map((copy) => copy.id).sort();
const copies = async () =>
  Number(
    (
      await dbGet<{ n: number | string }>(
        database,
        sql`SELECT COUNT(*) AS n FROM ${t('shared_checkin')}`,
      )
    )?.n ?? 0,
  );
const tripSeq = async (tripId: string) =>
  Number(
    (
      await dbGet<{ seq: number | string }>(
        database,
        sql`SELECT seq FROM ${t('trip')} WHERE id = ${tripId}`,
      )
    )?.seq,
  );
const linked = async (id: string) =>
  (
    await dbGet<{ tripId: string | null }>(
      database,
      sql`SELECT trip_id AS "tripId" FROM ${t('checkin')} WHERE id = ${id}`,
    )
  )?.tripId;

beforeAll(async () => {
  ({ database, close } = await makeStore());
  directory = mkdtempSync(path.join(tmpdir(), 'waymark-sharing-'));
  deps = {
    database,
    sealer,
    now: () => NOW,
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
  for (const table of [
    'shared_checkin',
    'notice',
    'notice_pref',
    'checkin_photo',
    'media',
    'checkin',
    'account_stream',
    'applied_mutation',
    'tombstone',
    'relink',
    'item',
    'day',
    'stop',
    'place',
    'trip_member',
    'trip',
    'profile',
  ])
    await dbAll(database, sql`DELETE FROM ${t(table)} RETURNING 1 AS gone`);
});

describe(`a check-in linked to a trip (${leg})`, () => {
  it('is private to its author, whatever the trip: nobody else is given it, and no copy exists', async () => {
    const tripId = await trip();
    const mine = await checkIn(SAM, { note: 'a secret note', companions: ['Kim'] });
    expect(await linked(mine.id)).toBe(tripId);
    expect(await copies()).toBe(0);
    for (const who of [ADA, GRACE, NOOR, SAM]) expect(await seen(who, tripId)).toEqual([]);
    // The same when the person has answered "no".
    await setShareChoice(deps, SAM, tripId, 'off');
    await checkIn(SAM);
    expect(await copies()).toBe(0);
  });

  it('is given to every member once it is shared, Followers too, with its place, moment, note, companions and photos, and nothing of the author', async () => {
    const tripId = await trip();
    const photo = randomUUID();
    const stored = await putMedia(deps.media, {
      accountId: SAM,
      kind: 'photo',
      bytes: await picture(),
      id: photo,
    });
    expect(stored.ok).toBe(true);
    const shared = await checkIn(SAM, {
      share: 'on',
      note: 'the tram was full',
      companions: ['Kim'],
      photos: [photo],
    });
    for (const who of [ADA, GRACE, NOOR]) {
      const copy = (await listShared(database, sealer, who, tripId))?.[0];
      expect(copy, who).toMatchObject({
        id: shared.id,
        authorId: SAM,
        place: { name: 'Lisbon', lat: 38.7223, lng: -9.1393 },
        at: Date.parse('2026-05-12T12:00:00+01:00'),
        tz: 'Europe/Lisbon',
        note: 'the tram was full',
        companions: ['Kim'],
        photos: [photo],
      });
      expect(JSON.stringify(copy)).not.toContain('email');
    }
    // The author has it in their own stream, not among the copies.
    expect(await seen(SAM, tripId)).toEqual([]);
  });

  it('is not given to a stranger, a former member, or for a trip that is not there: all the same answer', async () => {
    const tripId = await trip();
    await checkIn(SAM, { share: 'on' });
    expect(await listShared(database, sealer, STRANGER, tripId)).toBeUndefined();
    expect(await listShared(database, sealer, ADA, randomUUID())).toBeUndefined();
    expect(await listShared(database, sealer, ADA, 'not an id')).toBeUndefined();
    await dbAll(
      database,
      sql`UPDATE ${t('trip_member')} SET left_at = ${NOW} WHERE trip_id = ${tripId} AND account_id = ${NOOR} RETURNING trip_id`,
    );
    expect(await listShared(database, sealer, NOOR, tripId)).toBeUndefined();
  });

  it('is removed at once when it is unshared, unlinked by hand, linked to another trip, or deleted, and each takes a number in the trip’s stream', async () => {
    const tripId = await trip();
    const other = await trip('Elsewhere', '2026-06-10');
    const base = await tripSeq(tripId);
    const made = await checkIn(SAM, { share: 'on', ids: {} });
    expect(await seen(ADA, tripId)).toEqual([made.id]);
    expect(await tripSeq(tripId)).toBeGreaterThan(base);
    const again = (change: Record<string, unknown>) =>
      applyMutation({ database, sealer, now: () => NOW }, SAM, {
        mutationId: randomUUID(),
        stream: 'account',
        changes: [
          {
            table: 'checkin',
            op: 'put',
            id: made.id,
            row: {
              placeId: made.placeId,
              at: Date.parse('2026-05-12T12:00:00+01:00'),
              tz: 'Europe/Lisbon',
              offsetMin: 60,
              companions: [],
              tripId: null,
              linkSource: null,
              share: 'on',
              source: 'live',
              ...change,
            },
          },
        ],
      });
    // Unshared: the check-in says off.
    const before = await tripSeq(tripId);
    expect((await again({ share: 'off' })).status).toBe('applied');
    expect(await seen(ADA, tripId)).toEqual([]);
    expect(await tripSeq(tripId)).toBeGreaterThan(before);
    expect(await linked(made.id)).toBe(tripId);
    // Shared again, then unlinked by hand.
    await again({ share: 'on' });
    expect(await seen(NOOR, tripId)).toEqual([made.id]);
    await again({ tripId: null, linkSource: 'manual' });
    expect(await seen(NOOR, tripId)).toEqual([]);
    expect(await linked(made.id)).toBeNull();
    // Linked by hand to another trip: shared there, not in the first.
    await again({ tripId: other, linkSource: 'manual' });
    expect(await seen(NOOR, tripId)).toEqual([]);
    expect(await seen(NOOR, other)).toEqual([made.id]);
    // Deleted.
    await applyMutation({ database, sealer, now: () => NOW }, SAM, {
      mutationId: randomUUID(),
      stream: 'account',
      changes: [{ table: 'checkin', op: 'delete', id: made.id }],
    });
    expect(await seen(NOOR, other)).toEqual([]);
    expect(await copies()).toBe(0);
  });

  it('follows an edit of the check-in and of its place, so a reader never holds the old note or name', async () => {
    const tripId = await trip();
    const ids = { place: randomUUID(), checkin: randomUUID() };
    await checkIn(SAM, { share: 'on', note: 'first', ids });
    expect((await listShared(database, sealer, NOOR, tripId))?.[0]?.note).toBe('first');
    await checkIn(SAM, { share: 'on', note: 'second', ids });
    expect(await copies()).toBe(1);
    expect((await listShared(database, sealer, NOOR, tripId))?.[0]?.note).toBe('second');
    // The place renamed on its own.
    await checkIn(SAM, { share: 'on', note: 'second', ids, where: { ...PORTO, name: 'Porto' } });
    expect((await listShared(database, sealer, NOOR, tripId))?.[0]?.place.name).toBe('Porto');
    const renamed = await applyMutation({ database, sealer, now: () => NOW }, SAM, {
      mutationId: randomUUID(),
      stream: 'account',
      changes: [
        {
          table: 'place',
          op: 'put',
          id: ids.place,
          row: {
            name: 'Oporto',
            lat: 41.15,
            lng: -8.62,
            source: 'manual',
            tz: 'Europe/Lisbon',
            countryCode: null,
          },
        },
      ],
    });
    expect(renamed.status).toBe('applied');
    expect((await listShared(database, sealer, NOOR, tripId))?.[0]?.place.name).toBe('Oporto');
  });

  it('reads "after" a number: only what changed in the trip since', async () => {
    const tripId = await trip();
    const one = await checkIn(SAM, { share: 'on' });
    const [first] = (await listShared(database, sealer, ADA, tripId)) ?? [];
    const two = await checkIn(GRACE, { share: 'on' });
    const later = await listShared(database, sealer, ADA, tripId, first?.seq ?? 0);
    expect(later?.map((copy) => copy.id)).toEqual([two.id]);
    expect(one.id).not.toBe(two.id);
  });

  it('never has two copies of one check-in, and a copy is the author’s: another account’s mutation cannot replace it', async () => {
    const tripId = await trip();
    const made = await checkIn(SAM, { share: 'on' });
    const intruder = await applyMutation({ database, sealer, now: () => NOW }, GRACE, {
      mutationId: randomUUID(),
      stream: 'account',
      changes: [{ table: 'checkin', op: 'delete', id: made.id }],
    });
    expect(intruder.status).toBe('applied');
    expect(await seen(ADA, tripId)).toEqual([made.id]);
    expect(await copies()).toBe(1);
  });
});

describe(`a person's choice for a trip (${leg})`, () => {
  it('shares the check-ins that follow the trip when it is "on", and takes them back when it is "off"', async () => {
    const tripId = await trip();
    const follows = await checkIn(SAM);
    const private_ = await checkIn(SAM, { share: 'off' });
    const own = await checkIn(SAM, { share: 'on' });
    expect(await seen(ADA, tripId)).toEqual([own.id]);
    expect(await setShareChoice(deps, SAM, tripId, 'on')).toBe('on');
    expect(await seen(ADA, tripId)).toEqual([follows.id, own.id].sort());
    expect(private_.id).not.toBe(follows.id);
    expect(await setShareChoice(deps, SAM, tripId, 'off')).toBe('off');
    expect(await seen(ADA, tripId)).toEqual([own.id]);
    // Only the person's own check-ins: Grace's were never touched.
    const graces = await checkIn(GRACE);
    expect(await seen(ADA, tripId)).toEqual([own.id]);
    expect(graces.id).not.toBe(own.id);
  });

  it('is answered by the default in Settings when the person has not answered for the trip', async () => {
    const tripId = await trip();
    await createProfile(
      database,
      sealer,
      { accountId: SAM, name: 'Sam', email: 'sam@example.org' },
      NOW,
    );
    await updateProfile(database, sealer, SAM, { shareDefault: 'on' }, NOW);
    const made = await checkIn(SAM);
    expect(await seen(ADA, tripId)).toEqual([made.id]);
    // An answer for the trip beats the default.
    await setShareChoice(deps, SAM, tripId, 'off');
    expect(await seen(ADA, tripId)).toEqual([]);
  });

  it('is the person’s own, for Organizers and Travelers only: a Follower, a stranger and a trip that is not there are told it is not there', async () => {
    const tripId = await trip();
    expect(await setShareChoice(deps, NOOR, tripId, 'on')).toBeUndefined();
    expect(await setShareChoice(deps, STRANGER, tripId, 'on')).toBeUndefined();
    expect(await setShareChoice(deps, SAM, randomUUID(), 'on')).toBeUndefined();
    expect(await setShareChoice(deps, SAM, 'nope', 'on')).toBeUndefined();
    await expect(setShareChoice(deps, SAM, tripId, 'maybe')).rejects.toBeInstanceOf(TripError);
    expect(
      await dbGet<{ c: string }>(
        database,
        sql`SELECT share_checkins AS c FROM ${t('trip_member')} WHERE trip_id = ${tripId} AND account_id = ${NOOR}`,
      ),
    ).toMatchObject({ c: 'ask' });
    // An Organizer who goes has one too, and it is only ever their own row.
    expect(await setShareChoice(deps, ADA, tripId, 'on')).toBe('on');
    expect(
      await dbGet<{ c: string }>(
        database,
        sql`SELECT share_checkins AS c FROM ${t('trip_member')} WHERE trip_id = ${tripId} AND account_id = ${SAM}`,
      ),
    ).toMatchObject({ c: 'ask' });
  });

  it('writes no copy when the same answer is given again: only the guard’s own number is taken', async () => {
    const tripId = await trip();
    await setShareChoice(deps, SAM, tripId, 'on');
    const after = await tripSeq(tripId);
    expect(await setShareChoice(deps, SAM, tripId, 'on')).toBe('on');
    // Asking the same again writes no copy, so only the guard’s own number is taken.
    expect(await tripSeq(tripId)).toBe(after + 1);
    expect(await copies()).toBe(0);
  });
});

describe(`when a person’s part in a trip changes (${leg})`, () => {
  it('a Traveler made a Follower has nothing shared with the trip any more, and made a Traveler again must share again', async () => {
    const tripId = await trip();
    const made = await checkIn(SAM, { share: 'on' });
    expect(await seen(NOOR, tripId)).toEqual([made.id]);
    await setRole(deps, ADA, tripId, SAM, 'follower');
    expect(await seen(NOOR, tripId)).toEqual([]);
    expect(await linked(made.id)).toBe(tripId);
    await setRole(deps, ADA, tripId, SAM, 'traveler');
    expect(await seen(NOOR, tripId)).toEqual([made.id]);
  });

  it('leaving removes every copy of the person’s from the trip and from every trip, and keeps the check-ins theirs', async () => {
    const one = await trip();
    const two = await trip('Second', '2026-06-10');
    const mine = await checkIn(SAM, { share: 'on' });
    const june = await checkIn(SAM, { share: 'on', at: '2026-06-12T12:00:00+01:00' });
    expect(await copies()).toBe(2);
    const gone = await transaction(database, (tx) => dropCopiesOf(tx, SAM, one));
    expect(gone).toBe(1);
    expect(await seen(ADA, one)).toEqual([]);
    expect(await seen(ADA, two)).toEqual([june.id]);
    expect(await linked(mine.id)).toBe(one);
  });

  it('re-dating the trip so that the check-in no longer falls into it takes the copy away, when the job has linked it again', async () => {
    const tripId = await trip();
    const made = await checkIn(SAM, { share: 'on' });
    expect(await linked(made.id)).toBe(tripId);
    expect(await seen(NOOR, tripId)).toEqual([made.id]);
    const stop = await dbGet<{ id: string }>(
      database,
      sql`SELECT id FROM ${t('stop')} WHERE trip_id = ${tripId}`,
    );
    await removeStop(deps, ADA, tripId, stop?.id ?? '');
    // Not yet: the link is the job's to change.
    expect(await seen(NOOR, tripId)).toEqual([made.id]);
    await workOnRelinks({ database, sealer, now: () => NOW }, { budgetMs: 5_000 });
    expect(await linked(made.id)).toBeNull();
    expect(await seen(NOOR, tripId)).toEqual([]);
  });

  it('deleting the trip removes the copies and leaves the originals with their authors, unlinked', async () => {
    const tripId = await trip();
    const made = await checkIn(SAM, { share: 'on' });
    expect(await copies()).toBe(1);
    expect(await deleteTrip(deps, ADA, tripId)).toBe(true);
    expect(await copies()).toBe(0);
    expect(await linked(made.id)).toBeNull();
    expect(
      await dbGet<{ id: string }>(
        database,
        sql`SELECT id FROM ${t('checkin')} WHERE id = ${made.id}`,
      ),
    ).toBeDefined();
  });
});

describe(`the photos of a shared check-in (${leg})`, () => {
  it('are served to every member of the trip, Followers too, with their thumbnails, and to nobody else; unsharing stops it', async () => {
    await trip();
    const photo = randomUUID();
    const stored = await putMedia(deps.media, {
      accountId: SAM,
      kind: 'photo',
      bytes: await picture(),
      id: photo,
    });
    if (!stored.ok) throw new Error('not stored');
    const made = await checkIn(SAM, { share: 'on', photos: [photo] });
    const thumb = thumbIdOf(photo);
    for (const who of [SAM, ADA, GRACE, NOOR])
      for (const id of [photo, thumb])
        expect((await readFileFor(deps.media, who, id))?.type, `${who} ${id}`).toBe('image/webp');
    for (const id of [photo, thumb]) {
      expect(await readFileFor(deps.media, STRANGER, id)).toBeUndefined();
    }
    // Not shared: only the author.
    await checkIn(SAM, {
      share: 'off',
      photos: [photo],
      ids: { checkin: made.id, place: made.placeId },
    });
    for (const who of [ADA, GRACE, NOOR])
      for (const id of [photo, thumb])
        expect(await readFileFor(deps.media, who, id), `${who} ${id}`).toBeUndefined();
    expect(await readFileFor(deps.media, SAM, photo)).toBeDefined();
  });

  it('are not served from a trip the reader is not in, even if another of their trips has a shared check-in', async () => {
    const mine = await trip('Mine');
    const photo = randomUUID();
    const stored = await putMedia(deps.media, {
      accountId: SAM,
      kind: 'photo',
      bytes: await picture(),
      id: photo,
    });
    if (!stored.ok) throw new Error('not stored');
    await checkIn(SAM, { share: 'on', photos: [photo] });
    const lonely = await createTrip(deps, STRANGER, { name: 'Elsewhere' });
    expect(lonely.id).not.toBe(mine);
    expect(await readFileFor(deps.media, STRANGER, photo)).toBeUndefined();
    expect(await readFileFor(deps.media, STRANGER, thumbIdOf(photo))).toBeUndefined();
  });
});

describe(`telling the members (${leg})`, () => {
  it('tells only the members who chose to hear of it, once, naming the trip and nothing of the check-in or its author', async () => {
    await trip();
    await setPref(database, ADA, 'checkin_shared', 'email', true, NOW);
    const notify = { delivery: () => ({}) };
    const ids = { place: randomUUID(), checkin: randomUUID() };
    const send = (note: string) =>
      applyMutation({ database, sealer, now: () => NOW, notify }, SAM, {
        mutationId: randomUUID(),
        stream: 'account',
        changes: [
          {
            table: 'place',
            op: 'put',
            id: ids.place,
            row: {
              name: 'Secret Cafe',
              lat: 38.7,
              lng: -9.1,
              source: 'manual',
              tz: 'Europe/Lisbon',
              countryCode: null,
            },
          },
          {
            table: 'checkin',
            op: 'put',
            id: ids.checkin,
            row: {
              placeId: ids.place,
              at: Date.parse('2026-05-12T12:00:00+01:00'),
              tz: 'Europe/Lisbon',
              offsetMin: 60,
              note,
              companions: [],
              tripId: null,
              linkSource: null,
              share: 'on',
              source: 'live',
            },
          },
        ],
      });
    await send('one');
    await send('two');
    const ada = await listNotices({ database, sealer }, ADA, 10);
    expect(ada.filter((notice) => notice.kind === 'checkin_shared')).toHaveLength(1);
    const text = JSON.stringify(ada);
    expect(text).toContain('Iberia');
    expect(text).not.toContain('Secret Cafe');
    expect(text).not.toContain('Sam');
    for (const who of [GRACE, NOOR, SAM])
      expect(
        (await listNotices({ database, sealer }, who, 10)).filter(
          (n) => n.kind === 'checkin_shared',
        ),
      ).toHaveLength(0);
  });
});
