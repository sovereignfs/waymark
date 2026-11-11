import { randomBytes } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { accountRoute } from '../access/route';
import { type TwoAccounts, twoAccounts } from '../access/two-accounts';
import { ringOf } from '../crypto/keys';
import { Sealer } from '../crypto/sealed';
import type { Database } from '../db/client';
import { dbAll, transaction } from '../db/exec';
import { openAppBesideAuth, testTarget } from '../db/test-support';
import { MemoryMailer } from '../mail/memory';
import { sendDue } from '../mail/outbox';
import { createProfile } from '../profile/profile';
import { type Delivery, raiseNotice } from './notices';
import { DEFAULTS, deletePrefsOf, listPrefs, setPref, wants } from './prefs';
import { type PrefsDeps, changePref, readPrefs } from './prefs-http';

/** Choosing what is emailed (DESIGN.md §17.2, §21), on whichever database the leg runs on and over real sessions: defaults, a person’s own choices, and the mail a notice then does or does not queue. */
const { leg } = testTarget();
const ring = ringOf(randomBytes(32));
if (!ring) throw new Error('no ring');
const sealer = new Sealer(ring);
const NOW = 1_800_000_000_000;
const MAIL: Delivery = { mail: { app: 'Waymark', url: 'https://waymark.example/' } };

let t: TwoAccounts;
let database: Database;
let close: () => Promise<void>;
let deps: PrefsDeps;
beforeAll(async () => {
  t = await twoAccounts();
  ({ database, close } = await openAppBesideAuth());
  deps = { database, mail: true, now: () => NOW };
  for (const who of [t.ada, t.grace])
    await createProfile(
      database,
      sealer,
      { accountId: who.id, name: who === t.ada ? 'Ada' : 'Grace', email: who.email },
      NOW,
    );
});
afterAll(async () => {
  await t.close();
  await close();
});

const outbox = () =>
  dbAll<{ id: string; accountId: string | null }>(
    database,
    sql.raw(
      `SELECT id, account_id AS "accountId" FROM ${database.dialect === 'postgres' ? 'waymark.mail_outbox' : 'mail_outbox'}`,
    ),
  );
const raise = (to: string, by: string, delivery: Delivery = MAIL) =>
  transaction(database, (tx) =>
    raiseNotice(
      tx,
      sealer,
      NOW,
      {
        to,
        by,
        kind: 'import_finished',
        content: { title: 'Your import finished', detail: '2,001 check-ins.', href: '/checkins' },
      },
      delivery,
    ),
  );
/** What was queued, as a mail server would receive it. */
async function delivered() {
  const out = new MemoryMailer();
  await sendDue({ database, sealer, now: () => NOW }, out);
  return out.sent;
}

describe(`what is emailed (${leg})`, () => {
  it('is at its default for a kind nobody has chosen, and a choice replaces it, for the person alone', async () => {
    expect(DEFAULTS.import_finished.email).toBe(true);
    expect(await wants(database, t.ada.id, 'import_finished', 'email')).toBe(true);
    await setPref(database, t.ada.id, 'import_finished', 'email', false, NOW);
    expect(await wants(database, t.ada.id, 'import_finished', 'email')).toBe(false);
    expect(await wants(database, t.grace.id, 'import_finished', 'email')).toBe(true);
    expect((await listPrefs(database, t.ada.id)).import_finished.email).toBe(false);
    // Choosing again replaces the row, and a choice equal to the default is still a choice.
    await setPref(database, t.ada.id, 'import_finished', 'email', true, NOW + 1);
    await setPref(database, t.ada.id, 'import_finished', 'email', true, NOW + 2);
    expect(await wants(database, t.ada.id, 'import_finished', 'email')).toBe(true);
    const rows = await dbAll(
      database,
      sql.raw(
        `SELECT 1 AS n FROM ${database.dialect === 'postgres' ? 'waymark.notice_pref' : 'notice_pref'} WHERE account_id = '${t.ada.id}'`,
      ),
    );
    expect(rows).toHaveLength(1);
  });

  it('is removed with the person and no one else’s', async () => {
    await setPref(database, t.grace.id, 'import_finished', 'email', false, NOW);
    expect(await deletePrefsOf(database, 'someone-else-entirely')).toBe(0);
    expect(await wants(database, t.grace.id, 'import_finished', 'email')).toBe(false);
    await setPref(database, t.grace.id, 'import_finished', 'email', true, NOW);
  });
});

describe(`a notice that is also emailed (${leg})`, () => {
  it('queues one email to the person’s own address, in the same transaction, with Waymark’s words and a link into the app and one to Settings', async () => {
    await setPref(database, t.ada.id, 'import_finished', 'email', true, NOW);
    await raise(t.ada.id, 'someone-else');
    const sent = await delivered();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.to).toBe(t.ada.email);
    expect(sent[0]?.subject).toBe('Your import finished');
    expect(sent[0]?.text).toContain('2,001 check-ins.');
    expect(sent[0]?.text).toContain('https://waymark.example/checkins');
    expect(sent[0]?.text).toContain('https://waymark.example/settings?section=notifications');
    expect(sent[0]?.html).toContain('<a href="https://waymark.example/checkins">');
  });

  it('is not queued for a person who turned email off for the kind, and the bell notice is still raised', async () => {
    await setPref(database, t.ada.id, 'import_finished', 'email', false, NOW);
    const id = await raise(t.ada.id, 'someone-else');
    expect(id).toBeDefined();
    expect(await outbox()).toEqual([]);
  });

  it('is not queued when this server cannot send mail, or for the person who acted, or for a person with no profile', async () => {
    await setPref(database, t.ada.id, 'import_finished', 'email', true, NOW);
    await raise(t.ada.id, 'someone-else', {});
    await raise(t.ada.id, t.ada.id);
    await raise('nobody-with-a-profile', 'someone-else');
    expect(await outbox()).toEqual([]);
  });

  it('is rolled back with the change: no notice and no mail', async () => {
    await expect(
      transaction(database, async (tx) => {
        await raiseNotice(
          tx,
          sealer,
          NOW,
          { to: t.ada.id, by: 'x', kind: 'import_finished', content: { title: 'Never' } },
          MAIL,
        );
        throw new Error('the change failed');
      }),
    ).rejects.toThrow('the change failed');
    expect(await outbox()).toEqual([]);
  });
});

const wrapped = {
  origin: () => t.deps.origin(),
  accountOf: (headers: Headers) => t.deps.accountOf(headers),
};
const routes = {
  GET: accountRoute(({ accountId }) => readPrefs(accountId, deps), wrapped),
  PUT: accountRoute(({ request, accountId }) => changePref(request, accountId, deps), wrapped),
};
const get = (who: typeof t.ada | null) => routes.GET(t.request(who, '/api/notices/prefs'));
const put = (who: typeof t.ada | null, body: unknown, headers = {}) =>
  routes.PUT(t.request(who, '/api/notices/prefs', { method: 'PUT', body, headers }));

describe(`the choices over HTTP (${leg})`, () => {
  it('is for someone signed in and from the app', async () => {
    expect((await get(null)).status).toBe(401);
    expect((await put(null, { kind: 'import_finished', channel: 'email', on: false })).status).toBe(
      401,
    );
    expect(
      (
        await put(
          t.ada,
          { kind: 'import_finished', channel: 'email', on: false },
          { origin: 'https://evil.example' },
        )
      ).status,
    ).toBe(403);
  });

  it('reads and changes the person’s own choice and not another’s, and says whether mail is set up', async () => {
    await setPref(database, t.grace.id, 'import_finished', 'email', true, NOW);
    await setPref(database, t.ada.id, 'import_finished', 'email', true, NOW);
    const changed = await (
      await put(t.ada, { kind: 'import_finished', channel: 'email', on: false })
    ).json();
    expect(changed).toMatchObject({
      mail: true,
      kinds: [
        expect.objectContaining({ kind: 'import_finished', email: false }),
        expect.objectContaining({ kind: 'organizer_passed' }),
        expect.objectContaining({ kind: 'trip_ready' }),
        expect.objectContaining({ kind: 'trip_dates' }),
        expect.objectContaining({ kind: 'role_changed' }),
        expect.objectContaining({ kind: 'checkin_shared', email: false }),
        expect.objectContaining({ kind: 'edit_replaced' }),
      ],
    });
    expect((await (await get(t.grace)).json()).kinds[0].email).toBe(true);
    expect((await (await get(t.ada)).json()).kinds[0].email).toBe(false);
    deps = { ...deps, mail: false };
    expect((await (await get(t.ada)).json()).mail).toBe(false);
    deps = { ...deps, mail: true };
  });

  it('refuses a kind or channel that is not one, a choice that is not yes or no, and a field it does not know, naming nothing of it', async () => {
    for (const body of [
      { kind: 'trip_starts', channel: 'email', on: true },
      { kind: 'import_finished', channel: 'sms', on: true },
      { kind: 'import_finished', channel: 'email', on: 'yes' },
      { kind: 'import_finished', channel: 'email' },
      { kind: 'import_finished', channel: 'email', on: true, accountId: t.grace.id },
      ['x'],
      'text',
      null,
    ]) {
      const reply = await put(t.ada, body);
      expect(reply.status, JSON.stringify(body)).toBe(400);
      expect(await reply.json()).toEqual({ code: 'BAD_REQUEST' });
    }
    expect((await put(t.ada, { kind: 'x'.repeat(2000) })).status).toBe(413);
  });
});
