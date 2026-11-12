import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import webpush from 'web-push';
import { tableOf } from '../access/trip';
import type { Database } from '../db/client';
import { dbAll, dbGet } from '../db/exec';
import { OutboundError, type HostRule, outbound } from '../security/outbound';
import type { PushSettings } from './config';
import { type PushDeps, type PushKeys, hostRuleFor } from './subscriptions';

/**
 * **Web Push, sent** (DESIGN.md §17.3), by the shape of the mail outbox (`src/mail/outbox.ts`): a push is a row in `push_outbox`, **written in the transaction of the change that raised the notice** (so a change that is rolled back sends none),
 * for each device the person has push on in, and a job claims a row by a lease in the database, so **two workers or two processes never send one**. It is sent to the device's own push service and nowhere else (`outbound`, with the one host the
 * subscription names, which `subscribe` has already held to the push services browsers use), encrypted to the device by the library's code (RFC 8291) and signed with the instance's key (VAPID, RFC 8292).
 *
 * **What a push says is a kind and a path** (`{ "k": "trip_ready", "p": "/trips/…" }`): the push service carries it, so no place, note, title or name is in it, and the service worker writes the words from the kind. A push not delivered is tried
 * again after a pause that grows, and given up on when it is out of tries or too old (`expires_at`): a reminder an hour late is no reminder. A device the push service says is gone (404, 410) is removed, and its waiting pushes with it.
 * Nothing here logs an address, a key or a payload: a pass says only how many it sent, will try again and gave up on.
 */
export const MAX_ATTEMPTS = 4;
export const BACKOFF_MS = [60_000, 5 * 60_000, 30 * 60_000] as const;
/** How long a worker holds a push it is sending: longer than a send can take. */
export const LEASE_MS = 60_000;
/** How long a push is worth sending. */
export const TTL_MS = 4 * 3_600_000;
export const BATCH = 20;
const TIMEOUT_MS = 10_000;

export interface PushSendDeps extends PushDeps {
  readonly settings: PushSettings;
  /** For a test: the rule for the host a subscription names, which is the push services' list in production. */
  readonly ruleFor?: ((endpoint: string) => HostRule | undefined) | undefined;
}

/** Queues a push for each of a person's devices **in the transaction `tx` of the change that raised the notice**. Returns how many. */
export async function enqueuePush(
  tx: Database,
  now: number,
  push: { accountId: string; kind: string; path: string },
): Promise<number> {
  const devices = await dbAll<{ id: string }>(
    tx,
    sql`SELECT id FROM ${tableOf(tx, 'push_subscription')} WHERE account_id = ${push.accountId} ORDER BY id`,
  );
  for (const device of devices)
    await dbAll(
      tx,
      sql`INSERT INTO ${tableOf(tx, 'push_outbox')} (id, subscription_id, account_id, kind, path, attempts, next_attempt_at, claimed_until, expires_at, created_at)
          VALUES (${randomUUID()}, ${device.id}, ${push.accountId}, ${push.kind}, ${push.path}, 0, ${now}, 0, ${now + TTL_MS}, ${now})
          RETURNING id`,
    );
  return devices.length;
}

interface Claimed {
  id: string;
  subscriptionId: string;
  accountId: string;
  kind: string;
  path: string;
  attempts: number | string;
  expiresAt: number | string;
}
const CLAIMED = sql.raw(
  `id, subscription_id AS "subscriptionId", account_id AS "accountId", kind, path, attempts, expires_at AS "expiresAt"`,
);

export async function claimPush(deps: PushDeps, limit = BATCH): Promise<Claimed[]> {
  const now = deps.now();
  const t = tableOf(deps.database, 'push_outbox');
  return dbAll<Claimed>(
    deps.database,
    sql`UPDATE ${t}
        SET attempts = attempts + 1, claimed_until = ${now + LEASE_MS}
        WHERE id IN (
          SELECT id FROM ${t}
          WHERE next_attempt_at <= ${now} AND claimed_until <= ${now}
          ORDER BY next_attempt_at, id LIMIT ${limit}
        ) AND next_attempt_at <= ${now} AND claimed_until <= ${now}
        RETURNING ${CLAIMED}`,
  );
}

export interface Pass {
  readonly sent: number;
  readonly retry: number;
  readonly gaveUp: number;
  /** Devices the push service said are gone, removed. */
  readonly removed: number;
}

/** The text of a push, which the service worker turns into words by its kind. */
export const payloadOf = (kind: string, path: string): string =>
  JSON.stringify({ k: kind, p: path });

export async function sendDue(deps: PushSendDeps): Promise<Pass> {
  const claimed = await claimPush(deps);
  const t = (name: string) => tableOf(deps.database, name);
  let sent = 0;
  let retry = 0;
  let gaveUp = 0;
  let removed = 0;
  const done = (id: string) =>
    dbAll(deps.database, sql`DELETE FROM ${t('push_outbox')} WHERE id = ${id} RETURNING id`);
  const dropDevice = async (subscriptionId: string) => {
    await dbAll(
      deps.database,
      sql`DELETE FROM ${t('push_outbox')} WHERE subscription_id = ${subscriptionId} RETURNING id`,
    );
    await dbAll(
      deps.database,
      sql`DELETE FROM ${t('push_subscription')} WHERE id = ${subscriptionId} RETURNING id`,
    );
  };
  for (const row of claimed) {
    const attempts = Number(row.attempts);
    const now = deps.now();
    const later = async () => {
      if (attempts >= MAX_ATTEMPTS || now >= Number(row.expiresAt)) {
        await done(row.id);
        gaveUp += 1;
        return;
      }
      const pause = BACKOFF_MS[Math.min(attempts - 1, BACKOFF_MS.length - 1)] ?? BACKOFF_MS[0];
      await dbAll(
        deps.database,
        sql`UPDATE ${t('push_outbox')} SET next_attempt_at = ${now + pause}, claimed_until = 0 WHERE id = ${row.id} RETURNING id`,
      );
      retry += 1;
    };
    if (now >= Number(row.expiresAt)) {
      await done(row.id);
      gaveUp += 1;
      continue;
    }
    const device = await dbGet<{ id: string; sealed: Uint8Array | ArrayBuffer }>(
      deps.database,
      sql`SELECT id, sealed FROM ${t('push_subscription')} WHERE id = ${row.subscriptionId} AND account_id = ${row.accountId}`,
    );
    if (!device) {
      // The device was turned off since: nothing to send to.
      await done(row.id);
      gaveUp += 1;
      continue;
    }
    let target: { endpoint: string; keys: PushKeys };
    try {
      const fields = deps.sealer.unseal(
        'push_subscription',
        device.id,
        device.sealed instanceof Uint8Array ? device.sealed : new Uint8Array(device.sealed),
      );
      target = { endpoint: fields.endpoint, keys: fields.keys as PushKeys };
    } catch {
      // Written under a key that is gone: no try would open it, and no push can be sent to it.
      await dropDevice(device.id);
      removed += 1;
      continue;
    }
    const rule = (deps.ruleFor ?? hostRuleFor)(target.endpoint);
    if (!rule) {
      await dropDevice(device.id);
      removed += 1;
      continue;
    }
    try {
      const request = webpush.generateRequestDetails(
        { endpoint: target.endpoint, keys: target.keys },
        payloadOf(row.kind, row.path),
        {
          vapidDetails: {
            subject: deps.settings.subject,
            publicKey: deps.settings.publicKey,
            privateKey: deps.settings.privateKey,
          },
          TTL: Math.max(1, Math.floor((Number(row.expiresAt) - now) / 1000)),
          urgency: 'normal',
        },
      );
      const reply = await outbound(target.endpoint, {
        allow: [rule],
        method: 'POST',
        headers: request.headers as Record<string, string>,
        body: request.body as Buffer,
        timeoutMs: TIMEOUT_MS,
        maxBytes: 64 * 1024,
        maxRedirects: 0,
      });
      if (reply.status >= 200 && reply.status < 300) {
        await done(row.id);
        await dbAll(
          deps.database,
          sql`UPDATE ${t('push_subscription')} SET last_ok_at = ${now} WHERE id = ${device.id} RETURNING id`,
        );
        sent += 1;
      } else if (reply.status === 404 || reply.status === 410) {
        await dropDevice(device.id);
        removed += 1;
      } else if (reply.status === 429 || reply.status >= 500) await later();
      else {
        // Refused for a reason no try will change (a key the service does not take, a message too large).
        await done(row.id);
        gaveUp += 1;
      }
    } catch (error) {
      // No network, a timeout, a service that did not answer in time: tried again. A host that is not allowed is not one to try.
      if (error instanceof OutboundError && error.kind === 'host_not_allowed') {
        await dropDevice(device.id);
        removed += 1;
      } else await later();
    }
  }
  return { sent, retry, gaveUp, removed };
}

/** Removes pushes that no worker claimed and that are out of date (the job runs this after a pass). */
export async function dropStale(deps: PushDeps): Promise<number> {
  const now = deps.now();
  const gone = await dbAll<{ id: string }>(
    deps.database,
    sql`DELETE FROM ${tableOf(deps.database, 'push_outbox')} WHERE expires_at < ${now} AND claimed_until <= ${now} RETURNING id`,
  );
  return gone.length;
}
