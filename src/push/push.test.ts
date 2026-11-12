import {
  createDecipheriv,
  createECDH,
  createHash,
  hkdfSync,
  randomBytes,
  randomUUID,
} from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { tableOf } from '../access/trip';
import { ringOf } from '../crypto/keys';
import { Sealer } from '../crypto/sealed';
import type { Database } from '../db/client';
import { dbAll, dbGet, transaction } from '../db/exec';
import { makeStore, testTarget } from '../db/test-support';
import { raiseNotice } from '../notices/notices';
import { setPref } from '../notices/prefs';
import { deriveVapid, resolvePush } from './config';
import { readPush, turnOff, turnOn } from './http';
import {
  BACKOFF_MS,
  MAX_ATTEMPTS,
  TTL_MS,
  dropStale,
  enqueuePush,
  payloadOf,
  sendDue,
  type PushSendDeps,
} from './outbox';
import {
  MAX_DEVICES,
  countDevices,
  deletePushOf,
  endpointHash,
  hostRuleFor,
  subscribe,
  unsubscribe,
} from './subscriptions';

/**
 * Web Push (DESIGN.md §17.3), on whichever database the leg runs on: a key derived from a secret; a device only ever subscribed to a browser's own push service; a push queued with the notice, claimed by a lease, sent once with two workers, encrypted so
 * that the **receiver (written here from the RFC, not the library) reads exactly a kind and a path**; a device the service says is gone removed; and nothing of an address, key or payload logged.
 */
const { leg } = testTarget();
const ring = ringOf(randomBytes(32));
if (!ring) throw new Error('no ring');
const sealer = new Sealer(ring);
const [ADA, GRACE] = ['ada-acct', 'grace-acct'];
let NOW = Date.parse('2026-09-01T12:00:00Z');
let database: Database;
let close: () => Promise<void>;
const t = (name: string) => tableOf(database, name);
const SETTINGS = (() => {
  const keys = deriveVapid('a-secret-that-is-long-enough-for-waymark-0123456789');
  return { ...keys, subject: 'https://waymark.example' };
})();

/** A browser: the keys a subscription has, and the means to read what was encrypted to them. */
function browser() {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  const auth = randomBytes(16);
  return {
    keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: auth.toString('base64url') },
    /** RFC 8291 (aes128gcm): what a push service delivers to the browser. */
    decrypt(body: Buffer): string {
      const salt = body.subarray(0, 16);
      const idlen = body[20] ?? 0;
      const serverKey = body.subarray(21, 21 + idlen);
      const ciphertext = body.subarray(21 + idlen);
      const shared = ecdh.computeSecret(serverKey);
      const info = Buffer.concat([Buffer.from('WebPush: info\0'), ecdh.getPublicKey(), serverKey]);
      const ikm = Buffer.from(hkdfSync('sha256', shared, auth, info, 32));
      const cek = Buffer.from(
        hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16),
      );
      const nonce = Buffer.from(
        hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12),
      );
      const decipher = createDecipheriv('aes-128-gcm', cek, nonce);
      decipher.setAuthTag(ciphertext.subarray(ciphertext.length - 16));
      const plain = Buffer.concat([
        decipher.update(ciphertext.subarray(0, ciphertext.length - 16)),
        decipher.final(),
      ]);
      let end = plain.length;
      while (end > 0 && plain[end - 1] === 0) end -= 1;
      if (plain[end - 1] !== 2) throw new Error('no delimiter');
      return plain.subarray(0, end - 1).toString('utf8');
    },
  };
}

/** A push service of the test's own: records what it is sent and answers as it is told. */
function service() {
  const received: { path: string; headers: http.IncomingHttpHeaders; body: Buffer }[] = [];
  const state = { status: 201, hold: 0 };
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      received.push({
        path: request.url ?? '',
        headers: request.headers,
        body: Buffer.concat(chunks),
      });
      const answer = () => response.writeHead(state.status).end();
      if (state.hold > 0) setTimeout(answer, state.hold);
      else answer();
    });
  });
  return {
    received,
    state,
    start: () =>
      new Promise<number>((resolve) =>
        server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)),
      ),
    stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

let push: ReturnType<typeof service>;
let port = 0;
const deps = (): PushSendDeps => ({
  database,
  sealer,
  now: () => NOW,
  settings: SETTINGS,
  // The test's push service is on this machine, over http: the one thing production never allows.
  ruleFor: () => ({ host: '127.0.0.1', allowHttp: true, allowPrivate: true }),
});
const base = () => ({ database, sealer, now: () => NOW });

/** A device of a person's at the test's push service, made as `subscribe` would have (which refuses a host that is not a real push service). */
async function device(who: string, name: string = randomUUID()) {
  const b = browser();
  const id = randomUUID();
  const endpoint = `http://127.0.0.1:${port}/push/${name}`;
  await dbAll(
    database,
    sql`INSERT INTO ${t('push_subscription')} (id, account_id, endpoint_hash, last_ok_at, sealed, created_at, updated_at)
        VALUES (${id}, ${who}, ${endpointHash(endpoint)}, NULL, ${sealer.seal('push_subscription', id, { endpoint, keys: b.keys })}, ${NOW}, ${NOW}) RETURNING id`,
  );
  return { id, endpoint, browser: b };
}
const queue = (who: string, kind = 'trip_ready', path = '/trips/abc') =>
  transaction(database, (tx) => enqueuePush(tx, NOW, { accountId: who, kind, path }));
const count = async (table: string) =>
  Number(
    (await dbGet<{ n: number | string }>(database, sql`SELECT COUNT(*) AS n FROM ${t(table)}`))?.n,
  );

beforeAll(async () => {
  ({ database, close } = await makeStore());
  push = service();
  port = await push.start();
});
afterAll(async () => {
  await push.stop();
  await close();
});
beforeEach(async () => {
  NOW += 1000;
  push.received.length = 0;
  push.state.status = 201;
  push.state.hold = 0;
  for (const table of ['push_outbox', 'push_subscription', 'notice_pref', 'notice'])
    await dbAll(database, sql`DELETE FROM ${t(table)} RETURNING 1 AS gone`);
});
afterEach(() => vi.restoreAllMocks());

describe('the key', () => {
  it('is derived from the secret, the same every time, a real P-256 key, and different for another secret', () => {
    const a = deriveVapid('a-secret-that-is-long-enough-for-waymark-0123456789');
    expect(deriveVapid('a-secret-that-is-long-enough-for-waymark-0123456789')).toEqual(a);
    expect(deriveVapid('another-secret-that-is-long-enough-0123456789abcdef')).not.toEqual(a);
    const point = Buffer.from(a.publicKey, 'base64url');
    expect(point).toHaveLength(65);
    expect(point[0]).toBe(4);
    // The public key is the private key’s: a Diffie-Hellman with it works both ways.
    const mine = createECDH('prime256v1');
    mine.setPrivateKey(Buffer.from(a.privateKey, 'base64url'));
    expect(mine.getPublicKey().toString('base64url')).toBe(a.publicKey);
    const other = createECDH('prime256v1');
    other.generateKeys();
    expect(
      mine.computeSecret(other.getPublicKey()).equals(other.computeSecret(mine.getPublicKey())),
    ).toBe(true);
  });

  it('is optional, wants a secret of enough length and an address for the app, and says nothing of the value', () => {
    const read = (value: string | undefined) => (name: string) =>
      name === 'WAYMARK_VAPID_PRIVATE_KEY' ? value : undefined;
    const problems: { toString(): string }[] = [];
    expect(
      resolvePush(read(undefined), 'https://waymark.example', problems as never),
    ).toBeUndefined();
    expect(problems).toEqual([]);
    expect(resolvePush(read('x'.repeat(40)), undefined, problems as never)).toBeUndefined();
    expect(problems).toEqual([]);
    const ok = resolvePush(read('x'.repeat(40)), 'https://waymark.example', problems as never);
    expect(ok).toMatchObject({ subject: 'https://waymark.example' });
    for (const bad of ['short', `${'x'.repeat(20)} ${'y'.repeat(20)}`]) {
      const found: string[] = [];
      expect(resolvePush(read(bad), 'https://waymark.example', found as never)).toBeUndefined();
      expect(found).toHaveLength(1);
      expect(found[0]).not.toContain(bad);
    }
  });
});

describe(`a device (${leg})`, () => {
  const keys = () => browser().keys;
  const good = 'https://fcm.googleapis.com/fcm/send/abc:123';

  it('is subscribed only to a browser’s own push service: https, no name or port, a host that browsers use', () => {
    for (const ok of [
      good,
      'https://updates.push.services.mozilla.com/wpush/v2/abc',
      'https://web.push.apple.com/abc',
      'https://wns2-par02p.notify.windows.com/w/?token=x',
      'https://fcm.googleapis.com:443/x',
    ])
      expect(hostRuleFor(ok), ok).toBeDefined();
    for (const bad of [
      'http://fcm.googleapis.com/x',
      'https://evil.example/x',
      'https://fcm.googleapis.com.evil.example/x',
      'https://user:pass@fcm.googleapis.com/x',
      'https://fcm.googleapis.com:8443/x',
      'https://127.0.0.1/x',
      'https://169.254.169.254/latest',
      'https://localhost/x',
      'https://notify.windows.com/x',
      'ftp://fcm.googleapis.com/x',
      'not an address',
      '',
    ])
      expect(hostRuleFor(bad), bad).toBeUndefined();
  });

  it('is kept sealed and once, and turning it on again in the same browser is one row with the new keys', async () => {
    const first = keys();
    const made = await subscribe(base(), ADA, { endpoint: good, keys: first });
    if (!made.ok) throw new Error('refused');
    const row = await dbGet<{ hash: string; sealed: Uint8Array }>(
      database,
      sql`SELECT endpoint_hash AS hash, sealed FROM ${t('push_subscription')} WHERE id = ${made.id}`,
    );
    expect(row?.hash).toBe(createHash('sha256').update(good).digest('hex'));
    // The address and the keys are in no column and not readable in the envelope.
    const raw = Buffer.from(row?.sealed as Uint8Array).toString('latin1');
    expect(raw).not.toContain('googleapis');
    expect(raw).not.toContain(first.p256dh);
    const second = keys();
    const again = await subscribe(base(), ADA, { endpoint: good, keys: second });
    expect(again).toEqual({ ok: true, id: made.id });
    expect(await countDevices(database, ADA)).toBe(1);
    const stored = sealer.unseal(
      'push_subscription',
      made.id,
      new Uint8Array(
        (
          await dbGet<{ sealed: Uint8Array }>(
            database,
            sql`SELECT sealed FROM ${t('push_subscription')} WHERE id = ${made.id}`,
          )
        )?.sealed as Uint8Array,
      ),
    );
    expect(stored.keys).toEqual(second);
    // The same address for another person is that person’s own device.
    expect((await subscribe(base(), GRACE, { endpoint: good, keys: first })).ok).toBe(true);
    expect(await count('push_subscription')).toBe(2);
  });

  it('is refused for a host that is not a push service, keys that are not a browser’s, and past the most devices', async () => {
    expect(
      await subscribe(base(), ADA, { endpoint: 'https://evil.example/x', keys: keys() }),
    ).toEqual({ ok: false, reason: 'host' });
    for (const bad of [
      { endpoint: good, keys: { p256dh: 'AAAA', auth: browser().keys.auth } },
      { endpoint: good, keys: { p256dh: browser().keys.p256dh, auth: 'AAAA' } },
      { endpoint: good, keys: null },
      { endpoint: good, keys: { p256dh: 5, auth: 6 } },
      { endpoint: 5, keys: keys() },
      { endpoint: `https://fcm.googleapis.com/${'x'.repeat(2000)}`, keys: keys() },
    ])
      expect(await subscribe(base(), ADA, bad), JSON.stringify(bad).slice(0, 60)).toEqual({
        ok: false,
        reason: 'invalid',
      });
    for (let n = 0; n < MAX_DEVICES; n++)
      expect((await subscribe(base(), ADA, { endpoint: `${good}${n}`, keys: keys() })).ok).toBe(
        true,
      );
    expect(await subscribe(base(), ADA, { endpoint: `${good}more`, keys: keys() })).toEqual({
      ok: false,
      reason: 'too_many',
    });
    expect(await count('push_subscription')).toBe(MAX_DEVICES);
  });

  it('is turned off by its owner alone, with what was waiting for it; and goes with the person', async () => {
    const mine = await device(ADA);
    const theirs = await device(GRACE);
    await queue(ADA);
    await queue(GRACE);
    expect(await unsubscribe(base(), GRACE, mine.endpoint)).toBe(false);
    expect(await count('push_subscription')).toBe(2);
    expect(await unsubscribe(base(), ADA, mine.endpoint)).toBe(true);
    expect(await unsubscribe(base(), ADA, mine.endpoint)).toBe(false);
    expect(await count('push_subscription')).toBe(1);
    expect(await count('push_outbox')).toBe(1);
    await deletePushOf(database, GRACE);
    expect(await count('push_subscription')).toBe(0);
    expect(await count('push_outbox')).toBe(0);
    expect(theirs.id).toBeDefined();
  });
});

describe(`queuing a push with the notice (${leg})`, () => {
  const raise = (tx: Database, to: string, by: string, delivery: { push?: true }) =>
    raiseNotice(
      tx,
      sealer,
      NOW,
      {
        to,
        by,
        kind: 'trip_ready',
        tripId: undefined,
        content: {
          title: 'SECRET-TRIP-NAME is ready',
          detail: 'Lisbon, with Ada',
          href: '/trips/abc',
        },
      },
      delivery,
    );

  it('is one for each of the person’s devices, only if they want the kind by push, and the sender is never told', async () => {
    await device(ADA);
    await device(ADA);
    await device(GRACE);
    // Default: not by push.
    await transaction(database, (tx) => raise(tx, ADA, GRACE, { push: true }));
    expect(await count('push_outbox')).toBe(0);
    await setPref(database, ADA, 'trip_ready', 'push', true, NOW);
    await transaction(database, (tx) => raise(tx, ADA, GRACE, { push: true }));
    expect(await count('push_outbox')).toBe(2);
    // This server has no key: nothing is queued whatever the person chose.
    await transaction(database, (tx) => raise(tx, ADA, GRACE, {}));
    expect(await count('push_outbox')).toBe(2);
    // Never for the person who acted.
    await setPref(database, GRACE, 'trip_ready', 'push', true, NOW);
    await transaction(database, (tx) => raise(tx, GRACE, GRACE, { push: true }));
    expect(await count('push_outbox')).toBe(2);
    const rows = await dbAll<{ kind: string; path: string }>(
      database,
      sql`SELECT kind, path FROM ${t('push_outbox')}`,
    );
    expect(rows).toEqual([
      { kind: 'trip_ready', path: '/trips/abc' },
      { kind: 'trip_ready', path: '/trips/abc' },
    ]);
  });

  it('stands or falls with the change: rolled back, no push is queued', async () => {
    await device(ADA);
    await setPref(database, ADA, 'trip_ready', 'push', true, NOW);
    await transaction(database, async (tx) => {
      await raise(tx, ADA, GRACE, { push: true });
      throw new Error('rolled back');
    }).catch(() => undefined);
    expect(await count('push_outbox')).toBe(0);
  });
});

describe(`sending (${leg})`, () => {
  it('delivers an encrypted push to the device’s own push service, and the browser reads exactly a kind and a path', async () => {
    const mine = await device(ADA, 'a');
    await queue(ADA, 'trip_ready', '/trips/abc');
    const pass = await sendDue(deps());
    expect(pass).toMatchObject({ sent: 1, retry: 0, gaveUp: 0, removed: 0 });
    expect(push.received).toHaveLength(1);
    const got = push.received[0];
    expect(got?.path).toBe('/push/a');
    expect(got?.headers['content-encoding']).toBe('aes128gcm');
    expect(got?.headers.ttl).toBeDefined();
    // Signed with the instance’s key (VAPID): `vapid t=<jwt>, k=<public key>`.
    expect(String(got?.headers.authorization)).toContain(`k=${SETTINGS.publicKey}`);
    expect(String(got?.headers.authorization)).toMatch(/^vapid t=/);
    // What the browser reads: a kind and a path, and nothing else.
    expect(JSON.parse(mine.browser.decrypt(got?.body as Buffer))).toEqual({
      k: 'trip_ready',
      p: '/trips/abc',
    });
    expect(mine.browser.decrypt(got?.body as Buffer)).toBe(payloadOf('trip_ready', '/trips/abc'));
    // The body is encrypted: neither the kind nor the path is readable in it.
    expect(got?.body.toString('latin1')).not.toContain('trip_ready');
    expect(got?.body.toString('latin1')).not.toContain('/trips/abc');
    expect(await count('push_outbox')).toBe(0);
  });

  it('is sent once with two workers running at the same moment, and a push another worker holds is not taken', async () => {
    for (let n = 0; n < 6; n++) await device(ADA, `d${n}`);
    await queue(ADA);
    expect(await count('push_outbox')).toBe(6);
    const [one, two] = await Promise.all([sendDue(deps()), sendDue(deps())]);
    expect(one.sent + two.sent).toBe(6);
    expect(push.received).toHaveLength(6);
    expect(new Set(push.received.map((r) => r.path)).size).toBe(6);
    expect(await count('push_outbox')).toBe(0);
  });

  it('removes a device the push service says is gone (404 or 410), with its waiting pushes, and keeps the others', async () => {
    const gone = await device(ADA, 'gone');
    const kept = await device(GRACE, 'kept');
    await queue(ADA);
    await queue(ADA);
    await queue(GRACE);
    push.state.status = 410;
    const pass = await sendDue(deps());
    expect(pass.removed).toBe(2);
    expect(await count('push_subscription')).toBe(0);
    expect(await count('push_outbox')).toBe(0);
    expect(gone.id).not.toBe(kept.id);
    push.state.status = 404;
    await device(ADA, 'again');
    await queue(ADA);
    expect((await sendDue(deps())).removed).toBe(1);
  });

  it('tries again after a pause that grows when the service is busy or fails, and gives up after the most tries', async () => {
    await device(ADA, 'slow');
    await queue(ADA);
    push.state.status = 503;
    let pass = await sendDue(deps());
    expect(pass).toMatchObject({ sent: 0, retry: 1, gaveUp: 0 });
    // Not before its pause.
    expect(await sendDue(deps())).toMatchObject({ sent: 0, retry: 0 });
    NOW += (BACKOFF_MS[0] ?? 0) - 1;
    expect(await sendDue(deps())).toMatchObject({ sent: 0, retry: 0 });
    NOW += 1;
    push.state.status = 429;
    pass = await sendDue(deps());
    expect(pass.retry).toBe(1);
    NOW += BACKOFF_MS[1] ?? 0;
    push.state.status = 201;
    expect((await sendDue(deps())).sent).toBe(1);
    // Out of tries.
    await queue(ADA);
    push.state.status = 500;
    for (let n = 0; n < MAX_ATTEMPTS - 1; n++) {
      expect((await sendDue(deps())).retry).toBe(1);
      NOW += BACKOFF_MS.at(-1) ?? 0;
    }
    expect(await sendDue(deps())).toMatchObject({ retry: 0, gaveUp: 1 });
    expect(await count('push_outbox')).toBe(0);
    expect(await count('push_subscription')).toBe(1);
  });

  it('gives up on a push that is too old to be of use, and one the service refuses for good, and sends nothing for a device turned off', async () => {
    const mine = await device(ADA, 'old');
    await queue(ADA);
    NOW += TTL_MS + 1;
    const stale = await sendDue(deps());
    expect(stale).toMatchObject({ sent: 0, gaveUp: 1 });
    expect(push.received).toHaveLength(0);
    await queue(ADA);
    push.state.status = 400;
    expect(await sendDue(deps())).toMatchObject({ gaveUp: 1, removed: 0 });
    expect(await count('push_subscription')).toBe(1);
    // Turned off between the notice and the send.
    push.state.status = 201;
    await queue(ADA);
    await dbAll(
      database,
      sql`DELETE FROM ${t('push_subscription')} WHERE id = ${mine.id} RETURNING id`,
    );
    expect(await sendDue(deps())).toMatchObject({ sent: 0, gaveUp: 1 });
    // Left unclaimed and out of date, the job’s sweep removes it.
    await device(ADA, 'x');
    await queue(ADA);
    NOW += TTL_MS + 1;
    expect(await dropStale(base())).toBe(1);
  });

  it('never sends to an address that is not a push service’s: the device is removed, and nothing is sent', async () => {
    const mine = await device(ADA, 'fine');
    await queue(ADA);
    const strict: PushSendDeps = { ...deps(), ruleFor: hostRuleFor };
    const pass = await sendDue(strict);
    expect(pass.removed).toBe(1);
    expect(push.received).toHaveLength(0);
    expect(await count('push_subscription')).toBe(0);
    expect(mine.id).toBeDefined();
  });

  it('removes a device whose subscription cannot be opened, since no try would open it', async () => {
    const id = randomUUID();
    await dbAll(
      database,
      sql`INSERT INTO ${t('push_subscription')} (id, account_id, endpoint_hash, last_ok_at, sealed, created_at, updated_at) VALUES (${id}, ${ADA}, 'x', NULL, ${new Uint8Array([1, 2, 3])}, ${NOW}, ${NOW}) RETURNING id`,
    );
    await queue(ADA);
    expect((await sendDue(deps())).removed).toBe(1);
    expect(await count('push_subscription')).toBe(0);
  });

  it('writes nothing to any log: not an address, a key or a payload', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation(() => undefined),
    );
    await device(ADA, 'quiet');
    await queue(ADA);
    push.state.status = 500;
    await sendDue(deps());
    push.state.status = 410;
    NOW += BACKOFF_MS[0] ?? 0;
    await sendDue(deps());
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });
});

describe(`/api/push (${leg})`, () => {
  const http = () => ({ ...base(), settings: SETTINGS });
  const post = (method: string, body: unknown) =>
    new Request('http://localhost/api/push', {
      method,
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
  const good = 'https://fcm.googleapis.com/fcm/send/xyz';

  it('says whether this server can push, the key a browser subscribes with, and how many devices the account has', async () => {
    expect(await (await readPush(ADA, http())).json()).toEqual({
      available: true,
      publicKey: SETTINGS.publicKey,
      devices: 0,
    });
    expect(await (await readPush(ADA, { ...http(), settings: undefined })).json()).toEqual({
      available: false,
    });
    expect((await readPush(ADA, http())).headers.get('cache-control')).toBe('no-store');
  });

  it('turns it on for a browser and off again, for the account alone', async () => {
    const keys = browser().keys;
    const on = await turnOn(post('POST', { endpoint: good, keys }), ADA, http());
    expect(on.status).toBe(200);
    expect(await on.json()).toMatchObject({ devices: 1 });
    expect(await (await readPush(GRACE, http())).json()).toMatchObject({ devices: 0 });
    // Another person turning off the same address changes nothing of Ada’s.
    expect((await turnOff(post('DELETE', { endpoint: good }), GRACE, http())).status).toBe(404);
    expect(await countDevices(database, ADA)).toBe(1);
    expect((await turnOff(post('DELETE', { endpoint: good }), ADA, http())).status).toBe(200);
    expect(await countDevices(database, ADA)).toBe(0);
  });

  it('refuses what is not a subscription, a host that is not a push service, a server with no key, and says so in words that repeat nothing', async () => {
    const keys = browser().keys;
    const evil = await turnOn(
      post('POST', { endpoint: 'https://evil.example/x', keys }),
      ADA,
      http(),
    );
    expect(evil.status).toBe(400);
    expect(JSON.stringify(await evil.json())).not.toContain('evil.example');
    for (const body of [
      'not json',
      '[]',
      '"x"',
      { endpoint: good },
      { endpoint: good, keys, extra: 1 },
      { keys },
    ])
      expect((await turnOn(post('POST', body), ADA, http())).status, JSON.stringify(body)).toBe(
        400,
      );
    expect(
      (
        await turnOn(post('POST', { endpoint: good, keys }), ADA, {
          ...http(),
          settings: undefined,
        })
      ).status,
    ).toBe(404);
    for (const body of ['nope', { endpoint: good, keys }, {}])
      expect((await turnOff(post('DELETE', body), ADA, http())).status, JSON.stringify(body)).toBe(
        400,
      );
    expect((await turnOn(post('POST', 'x'.repeat(5000)), ADA, http())).status).toBe(400);
  });
});
