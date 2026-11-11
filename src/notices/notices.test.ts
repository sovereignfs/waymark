import { randomBytes } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ringOf } from '../crypto/keys';
import { Sealer } from '../crypto/sealed';
import type { Database } from '../db/client';
import { dbAll, transaction } from '../db/exec';
import { makeStore, testTarget } from '../db/test-support';
import {
  KEEP_DAYS,
  KEEP_MAX,
  cleanContent,
  deleteNoticesOf,
  isAppPath,
  listNotices,
  markAllRead,
  markRead,
  pruneNotices,
  raiseNotice,
  unreadCount,
} from './notices';

/** Notices (DESIGN.md §17.1), on whichever database the leg runs on: raised once, never for the actor, sealed, read, and kept 90 days and 500. */
const { leg } = testTarget();
const ring = ringOf(randomBytes(32));
if (!ring) throw new Error('no ring');
const sealer = new Sealer(ring);
const DAY = 86_400_000;
let NOW = 1_800_000_000_000;

let database: Database;
let close: () => Promise<void>;
beforeAll(async () => {
  ({ database, close } = await makeStore());
});
afterAll(async () => close());

const tbl = () => sql.raw(database.dialect === 'postgres' ? 'waymark.notice' : 'notice');
let n = 0;
const person = () => `person-${++n}`;
const deps = () => ({ database, sealer, now: () => NOW });
const raise = (to: string, by: string, over: { title?: string; at?: number } = {}) =>
  raiseNotice(database, sealer, over.at ?? NOW, {
    to,
    by,
    kind: 'import_finished',
    content: { title: over.title ?? 'Your import finished', href: '/checkins' },
  });

describe(`raising a notice (${leg})`, () => {
  it('is for the person told, sealed, and not for the person who acted', async () => {
    const [ada, grace] = [person(), person()];
    const id = await raise(ada, grace, { title: 'Zxqv imported 2,001 check-ins' });
    expect(id).toBeDefined();
    // Nothing for the actor: the same person is both.
    expect(await raise(ada, ada)).toBeUndefined();
    expect((await listNotices(deps(), ada)).map((each) => each.id)).toEqual([id]);
    expect(await listNotices(deps(), grace)).toEqual([]);
    expect(await listNotices(deps(), ada)).toMatchObject([
      {
        kind: 'import_finished',
        read: false,
        title: 'Zxqv imported 2,001 check-ins',
        href: '/checkins',
        at: NOW,
      },
    ]);
    // What it says is in no column and not readable in the envelope.
    const raw = await dbAll<Record<string, unknown>>(
      database,
      sql`SELECT * FROM ${tbl()} WHERE id = ${id ?? ''}`,
    );
    expect(Buffer.from(raw[0]?.sealed as Uint8Array).includes(Buffer.from('Zxqv'))).toBe(false);
    expect(JSON.stringify({ ...raw[0], sealed: undefined })).not.toContain('Zxqv');
  });

  it('exists only if the change does: raised in a transaction that is rolled back, it is not there', async () => {
    const ada = person();
    await expect(
      transaction(database, async (tx) => {
        await raiseNotice(tx, sealer, NOW, {
          to: ada,
          by: 'someone-else',
          kind: 'import_finished',
          content: { title: 'Never told' },
        });
        // Inside the change the notice is there; the change then fails.
        expect(await listNotices({ database: tx, sealer }, ada)).toHaveLength(1);
        throw new Error('the change failed');
      }),
    ).rejects.toThrow('the change failed');
    expect(await listNotices(deps(), ada)).toEqual([]);
  });

  it('says only Waymark’s words and sends a person only somewhere in the app', () => {
    expect(isAppPath('/checkins')).toBe(true);
    for (const bad of ['https://evil.example', '//evil.example', 'javascript:alert(1)', ''])
      expect(isAppPath(bad)).toBe(false);
    expect(cleanContent({ title: 'x', href: 'https://evil.example' })).toEqual({ title: 'x' });
    expect(cleanContent({ title: '  a \n b  ' }).title).toBe('a b');
    expect(cleanContent({ title: 'x'.repeat(500) }).title).toHaveLength(200);
    expect(cleanContent({ title: ' ' }).title).toBe('Waymark');
  });
});

describe(`reading and marking (${leg})`, () => {
  it('lists newest first, counts the unread, marks some and all read, once, for the person alone', async () => {
    const [ada, grace] = [person(), person()];
    const a = await raise(ada, 'x', { title: 'one', at: NOW - 3000 });
    const b = await raise(ada, 'x', { title: 'two', at: NOW - 2000 });
    const c = await raise(ada, 'x', { title: 'three', at: NOW - 1000 });
    const g = await raise(grace, 'x', { title: 'grace one' });
    expect((await listNotices(deps(), ada)).map((each) => each.title)).toEqual([
      'three',
      'two',
      'one',
    ]);
    expect(await unreadCount(deps(), ada)).toBe(3);

    // Marking is once, and another person's notice is not there to mark.
    expect(await markRead(deps(), grace, [a ?? '', b ?? ''])).toBe(0);
    expect(await markRead(deps(), ada, [a ?? ''])).toBe(1);
    expect(await markRead(deps(), ada, [a ?? ''])).toBe(0);
    expect(await unreadCount(deps(), ada)).toBe(2);
    expect(await markRead(deps(), ada, [])).toBe(0);
    expect(await markAllRead(deps(), ada)).toBe(2);
    expect(await unreadCount(deps(), ada)).toBe(0);
    expect((await listNotices(deps(), ada)).every((each) => each.read)).toBe(true);
    expect(await unreadCount(deps(), grace)).toBe(1);
    expect(await markAllRead(deps(), grace)).toBe(1);
    void c;
    void g;
  });

  it('keeps the time it was read when marked again', async () => {
    const ada = person();
    const id = await raise(ada, 'x');
    await markRead(deps(), ada, [id ?? '']);
    const first = await dbAll<{ readAt: number | string }>(
      database,
      sql`SELECT read_at AS "readAt" FROM ${tbl()} WHERE id = ${id ?? ''}`,
    );
    NOW += 5000;
    await markRead(deps(), ada, [id ?? '']);
    const second = await dbAll<{ readAt: number | string }>(
      database,
      sql`SELECT read_at AS "readAt" FROM ${tbl()} WHERE id = ${id ?? ''}`,
    );
    expect(Number(second[0]?.readAt)).toBe(Number(first[0]?.readAt));
  });

  it('does not show a notice of a kind this version does not know', async () => {
    const ada = person();
    const id = await raise(ada, 'x');
    await dbAll(
      database,
      sql`UPDATE ${tbl()} SET kind = 'from_a_later_version' WHERE id = ${id ?? ''} RETURNING id`,
    );
    expect(await listNotices(deps(), ada)).toEqual([]);
    // It is still counted as the database holds it; the page it would be on is the later version's.
    expect(await unreadCount(deps(), ada)).toBe(1);
  });
});

describe(`keeping notices (${leg})`, () => {
  it('removes those older than ninety days and, for a person with more than 500, all but the newest 500; and again changes nothing', async () => {
    const [ada, grace] = [person(), person()];
    NOW += DAY;
    await raise(ada, 'x', { title: 'ancient', at: NOW - (KEEP_DAYS + 1) * DAY });
    await raise(ada, 'x', { title: 'fresh', at: NOW - (KEEP_DAYS - 1) * DAY });
    await raise(grace, 'x', { title: 'grace ancient', at: NOW - (KEEP_DAYS + 5) * DAY });
    // 503 for grace: the newest 500 stay.
    for (let i = 0; i < KEEP_MAX + 3; i += 1)
      await raise(grace, 'x', { title: `g${i}`, at: NOW - 60_000 + i });
    const first = await pruneNotices(deps());
    expect(first.old).toBeGreaterThanOrEqual(2);
    expect(first.over).toBeGreaterThanOrEqual(3);
    expect((await listNotices(deps(), ada)).map((each) => each.title)).toEqual(['fresh']);
    const kept = await dbAll<{ title: string }>(
      database,
      sql`SELECT COUNT(*) AS title FROM ${tbl()} WHERE account_id = ${grace}`,
    );
    expect(Number(kept[0]?.title)).toBe(KEEP_MAX);
    // The oldest three of the 503 went, the newest stayed.
    const newest = await listNotices(deps(), grace, 500);
    expect(newest[0]?.title).toBe(`g${KEEP_MAX + 2}`);
    expect(newest.some((each) => each.title === 'g0')).toBe(false);
    expect(await pruneNotices(deps())).toMatchObject({ old: 0, over: 0 });
  });

  it('removes every notice of a person, and no one else’s', async () => {
    const [ada, grace] = [person(), person()];
    await raise(ada, 'x');
    await raise(ada, 'x');
    await raise(grace, 'x');
    expect(await deleteNoticesOf(database, ada)).toBe(2);
    expect(await deleteNoticesOf(database, ada)).toBe(0);
    expect(await listNotices(deps(), grace)).toHaveLength(1);
  });
});
