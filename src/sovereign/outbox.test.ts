import { randomBytes } from 'node:crypto';
import { createSovereign } from '@sovereignfs/sdk';
import { createFakeCore } from '@sovereignfs/sdk/testing';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ringOf } from '../crypto/keys';
import { Sealer } from '../crypto/sealed';
import type { Database } from '../db/client';
import { dbAll, transaction } from '../db/exec';
import { makeStore, testTarget } from '../db/test-support';
import { BACKOFF_MS } from '../mail/outbox';
import { raiseNotice } from '../notices/notices';
import { setPref } from '../notices/prefs';
import { createProfile } from '../profile/profile';
import { type CoreSender, deleteCoreOf, dropStaleCore, enqueueCore, sendDueCore } from './outbox';
import { CORE_REST_MS, coreServices } from './services';

/**
 * Calls to a Sovereign core (DESIGN.md §17.2, §19.4), against the SDK's own fake core, on whichever database the leg runs on: queued with the change, made once with a key, tried again when core is down,
 * rested when it refuses, and an email that core will not send falling back to Waymark's own mail. **Every feature works the same without a core**: a refusal changes nothing but that call.
 */
const { leg } = testTarget();
const made = ringOf(randomBytes(32));
if (!made) throw new Error('no ring');
const sealer = new Sealer(made);
const ADA = 'ada-account';
const GRACE = 'grace-account';
const APP = 'https://waymark.example';
let NOW = 1_800_000_000_000;

let database: Database;
let close: () => Promise<void>;
beforeAll(async () => {
  ({ database, close } = await makeStore());
  for (const [id, name] of [
    [ADA, 'Ada'],
    [GRACE, 'Grace'],
  ] as const)
    await createProfile(database, sealer, { accountId: id, name, email: `${id}@example.com` }, NOW);
});
afterAll(async () => close());

const table = () =>
  sql.raw(database.dialect === 'postgres' ? 'waymark.core_outbox' : 'core_outbox');
beforeEach(async () => {
  NOW += 10 * 60_000;
  await dbAll(database, sql`DELETE FROM ${table()} RETURNING id`);
});
const rows = () =>
  dbAll<{
    id: string;
    kind: string;
    accountId: string | null;
    attempts: number | string;
    nextAttemptAt: number | string;
  }>(
    database,
    sql`SELECT id, kind, account_id AS "accountId", attempts, next_attempt_at AS "nextAttemptAt" FROM ${table()} ORDER BY created_at, id`,
  );

/** A core with Ada and Grace on it, a client of it, and a sender that knows who is linked. */
function world(options: { linked?: string[]; fallback?: string[] } = {}) {
  const core = createFakeCore({ now: () => NOW });
  core.addPerson({ sub: 'sub-ada', name: 'Ada' });
  core.addPerson({ sub: 'sub-grace', name: 'Grace' });
  const sovereign = createSovereign({
    appUrl: APP,
    coreUrl: core.url,
    clientId: core.credentials.clientId,
    clientSecret: core.credentials.clientSecret,
    fetch: core.fetch,
  });
  const services = coreServices({ sovereign: sovereign.app, now: () => NOW });
  const linked = new Map([
    [ADA, 'sub-ada'],
    [GRACE, 'sub-grace'],
  ]);
  for (const id of [ADA, GRACE])
    if (options.linked && !options.linked.includes(id)) linked.delete(id);
  const fellBack: string[] = [];
  const sender: CoreSender = {
    services,
    subOf: async (accountId) => linked.get(accountId),
    absolute: (path) => `${APP}${path}`,
    fallbackMail: async (accountId) => void fellBack.push(accountId),
  };
  return { core, sender, fellBack, deps: { database, sealer, now: () => NOW } };
}

const raise = (to: string, title = 'Your import has finished') =>
  transaction(database, (tx) =>
    raiseNotice(
      tx,
      sealer,
      NOW,
      {
        to,
        by: 'import',
        kind: 'import_finished',
        content: { title, detail: '60 check-ins were added.', href: '/checkins' },
      },
      { core: true },
    ),
  );

describe(`a notice that reaches a core (${leg})`, () => {
  it('queues core’s bell and core’s email with the notice, and makes each call once with its key, to the right person', async () => {
    const w = world();
    const id = await raise(ADA);
    expect((await rows()).map((r) => r.kind).sort()).toEqual(['email', 'notification']);
    expect(await sendDueCore(w.deps, w.sender)).toMatchObject({
      sent: 2,
      retry: 0,
      gaveUp: 0,
      fellBack: 0,
    });
    expect(w.core.notificationsSent).toHaveLength(1);
    expect(w.core.notificationsSent[0]).toMatchObject({
      to: 'sub-ada',
      title: 'Your import has finished',
      body: '60 check-ins were added.',
      url: `${APP}/checkins`,
    });
    // The fake does not record a notification's key (it does an email's); the call carried it, and a repeat of it is the same send at core.
    expect(w.core.emailsSent).toHaveLength(1);
    expect(w.core.emailsSent[0]).toMatchObject({
      to: 'sub-ada',
      subject: 'Your import has finished',
      key: `${id}:email`,
    });
    expect(w.core.emailsSent[0]?.body).toContain('60 check-ins were added.');
    expect(w.core.emailsSent[0]?.body).not.toContain('example.com');
    // Once: another pass makes no more.
    expect(await rows()).toEqual([]);
    expect(await sendDueCore(w.deps, w.sender)).toMatchObject({ sent: 0 });
    expect(w.core.notificationsSent).toHaveLength(1);
  });

  it('is queued only for what the person wants, and with the notice: rolled back with it, nothing is queued', async () => {
    await setPref(database, GRACE, 'import_finished', 'core', false, NOW);
    await raise(GRACE);
    expect((await rows()).map((r) => r.kind)).toEqual(['email']);
    await setPref(database, GRACE, 'import_finished', 'email', false, NOW);
    await dbAll(database, sql`DELETE FROM ${table()} RETURNING id`);
    await raise(GRACE);
    expect(await rows()).toEqual([]);
    await setPref(database, GRACE, 'import_finished', 'core', true, NOW);
    await setPref(database, GRACE, 'import_finished', 'email', true, NOW);
    await expect(
      transaction(database, async (tx) => {
        await raiseNotice(
          tx,
          sealer,
          NOW,
          { to: GRACE, by: 'x', kind: 'import_finished', content: { title: 'Never' } },
          { core: true },
        );
        throw new Error('the change failed');
      }),
    ).rejects.toThrow('the change failed');
    expect(await rows()).toEqual([]);
  });

  it('is not queued without a core: the notice is Waymark’s alone', async () => {
    await transaction(database, (tx) =>
      raiseNotice(
        tx,
        sealer,
        NOW,
        { to: ADA, by: 'x', kind: 'import_finished', content: { title: 'Plain' } },
        {},
      ),
    );
    expect(await rows()).toEqual([]);
  });
});

describe(`when core will not or cannot (${leg})`, () => {
  it('drops the bell and falls back to Waymark’s mail for the email, for a person with no sub at the core', async () => {
    const w = world({ linked: [ADA] });
    await raise(GRACE);
    expect(await sendDueCore(w.deps, w.sender)).toMatchObject({ sent: 0, fellBack: 1 });
    expect(w.fellBack).toEqual([GRACE]);
    expect(w.core.notificationsSent).toHaveLength(0);
    expect(w.core.emailsSent).toHaveLength(0);
    expect(await rows()).toEqual([]);
  });

  it('is refused (the scope is not granted): the email falls back to Waymark’s mail, the bell is dropped, and the refusal is rested, not asked again', async () => {
    const w = world();
    w.core.fail({ kind: 'status', status: 403 }, { target: 'api' });
    await raise(ADA);
    await raise(ADA, 'A second');
    const first = await sendDueCore(w.deps, w.sender);
    expect(first.sent).toBe(0);
    expect(w.fellBack).toEqual([ADA, ADA]);
    expect(await rows()).toEqual([]);
    // Resting: the second notice's calls were not even sent to core.
    const asked = w.core.seen.requests.filter(
      (r) => r.path.includes('notif') || r.path.includes('email'),
    ).length;
    await raise(ADA, 'A third');
    w.core.heal();
    await sendDueCore(w.deps, w.sender);
    expect(
      w.core.seen.requests.filter((r) => r.path.includes('notif') || r.path.includes('email'))
        .length,
    ).toBe(asked);
    expect(w.core.notificationsSent).toHaveLength(0);
    expect(w.fellBack).toHaveLength(3);
    // After the rest it is tried again.
    NOW += CORE_REST_MS + 1;
    await raise(ADA, 'A fourth');
    await sendDueCore(w.deps, w.sender);
    expect(w.core.notificationsSent).toHaveLength(1);
  });

  it('is down: nothing is lost, it is tried again after a pause, and made once when core is back, with the same key', async () => {
    const w = world();
    const id = await raise(ADA);
    w.core.fail({ kind: 'down' }, { target: 'api' });
    expect(await sendDueCore(w.deps, w.sender)).toMatchObject({ sent: 0, retry: 2 });
    const waiting = await rows();
    expect(waiting).toHaveLength(2);
    expect(
      waiting.every(
        (r) => Number(r.attempts) === 1 && Number(r.nextAttemptAt) === NOW + BACKOFF_MS[0],
      ),
    ).toBe(true);
    // Not before the pause.
    NOW += BACKOFF_MS[0] - 1;
    w.core.heal();
    expect(await sendDueCore(w.deps, w.sender)).toMatchObject({ sent: 0, retry: 0 });
    NOW += 1;
    expect(await sendDueCore(w.deps, w.sender)).toMatchObject({ sent: 2 });
    expect(w.core.notificationsSent).toHaveLength(1);
    expect(w.core.emailsSent).toHaveLength(1);
    expect(w.core.emailsSent[0]?.key).toBe(`${id}:email`);
  });

  it('is told to wait: tried again after the pause core asked for', async () => {
    const w = world();
    await raise(ADA);
    w.core.fail({ kind: 'status', status: 429, retryAfter: 7 }, { target: 'api', times: 4 });
    expect(await sendDueCore(w.deps, w.sender)).toMatchObject({ sent: 0, retry: 2 });
    expect((await rows()).every((r) => Number(r.nextAttemptAt) === NOW + 7000)).toBe(true);
  });

  it('gives up on a call that is too old to be of use', async () => {
    const w = world();
    await raise(ADA);
    NOW += 25 * 3_600_000;
    w.core.fail({ kind: 'down' }, { target: 'api' });
    expect(await sendDueCore(w.deps, w.sender)).toMatchObject({ gaveUp: 2 });
    expect(await rows()).toEqual([]);
    await raise(ADA);
    NOW += 25 * 3_600_000;
    expect(await dropStaleCore(w.deps)).toBe(2);
  });
});

describe(`many workers, and a person who is gone (${leg})`, () => {
  it('makes each of forty calls once with two workers running at the same time', async () => {
    const w = world();
    for (let i = 0; i < 20; i += 1) await raise(ADA, `Notice ${i}`);
    await Promise.all([
      (async () => {
        for (let i = 0; i < 10; i += 1) await sendDueCore(w.deps, w.sender);
      })(),
      (async () => {
        for (let i = 0; i < 10; i += 1) await sendDueCore(w.deps, w.sender);
      })(),
    ]);
    expect(w.core.notificationsSent).toHaveLength(20);
    expect(new Set(w.core.notificationsSent.map((n) => n.title)).size).toBe(20);
    expect(new Set(w.core.emailsSent.map((e) => e.key)).size).toBe(20);
    expect(w.core.emailsSent).toHaveLength(20);
    expect(await rows()).toEqual([]);
  });

  it('makes a line about a deletion, which names the sub and survives the removal of the person’s own calls', async () => {
    const w = world();
    await enqueueCore(database, sealer, NOW, {
      accountId: ADA,
      kind: 'notification',
      content: { title: 'Gone with the person', key: 'k1' },
    });
    await enqueueCore(database, sealer, NOW, {
      kind: 'activity',
      content: { title: 'Deleted your Waymark account', sub: 'sub-ada', key: 'deleted:sub-ada' },
    });
    expect(await deleteCoreOf(database, ADA)).toBe(1);
    expect(await sendDueCore(w.deps, w.sender)).toMatchObject({ sent: 1 });
    expect(w.core.activityRecorded).toHaveLength(1);
    expect(w.core.activityRecorded[0]).toMatchObject({
      to: 'sub-ada',
      summary: 'Deleted your Waymark account',
      key: 'deleted:sub-ada',
    });
  });

  it('keeps what it says sealed while it waits, and gives up on a row it cannot open', async () => {
    await enqueueCore(database, sealer, NOW, {
      accountId: ADA,
      kind: 'notification',
      content: { title: 'Zxqv secret title', key: 'k2' },
    });
    const raw = await dbAll<Record<string, unknown>>(database, sql`SELECT * FROM ${table()}`);
    expect(Buffer.from(raw[0]?.sealed as Uint8Array).includes(Buffer.from('Zxqv'))).toBe(false);
    expect(JSON.stringify({ ...raw[0], sealed: undefined })).not.toContain('Zxqv');
    await dbAll(
      database,
      sql`UPDATE ${table()} SET sealed = ${Buffer.from('not an envelope')} RETURNING id`,
    );
    const w = world();
    expect(await sendDueCore(w.deps, w.sender)).toMatchObject({ gaveUp: 1 });
  });
});
