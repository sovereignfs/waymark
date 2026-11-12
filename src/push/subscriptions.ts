import { createHash, randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { tableOf } from '../access/trip';
import type { Sealer } from '../crypto/sealed';
import type { Database } from '../db/client';
import { dbAll, dbGet } from '../db/exec';
import { type HostRule, ruleFor } from '../security/outbound';

/**
 * **A device that can be told by Web Push** (DESIGN.md §17.3): a browser's subscription, kept for the person who turned push on in it. What it holds is a push service's address and the keys that encrypt a message to that browser, so
 * **both are sealed** (`SEALED.push_subscription`); the database knows the owner and a hash of the address, which makes turning it on again in the same browser one row.
 *
 * **A subscription is only ever for a browser's own push service**: the address must be `https` on the port of a service that browsers use (`PUSH_HOSTS`), with no name or password in it, because the server will POST to it (`outbound`, and only to that
 * host): an address a person could make point somewhere else would make the server send to it. The keys are what a browser makes (an uncompressed P-256 point and a 16-byte secret).
 */
export const PUSH_HOSTS: readonly string[] = [
  // Chrome, Edge and Chromium browsers (Firebase Cloud Messaging), and its older address.
  'fcm.googleapis.com',
  'android.googleapis.com',
  // Firefox.
  'updates.push.services.mozilla.com',
  '*.push.services.mozilla.com',
  // Safari and every browser on iPhone and iPad.
  'web.push.apple.com',
  '*.push.apple.com',
  // Edge on Windows.
  '*.notify.windows.com',
];

/** The most devices a person can have push on in. */
export const MAX_DEVICES = 10;
export const ENDPOINT_MAX = 2000;

export interface PushDeps {
  readonly database: Database;
  readonly sealer: Sealer;
  readonly now: () => number;
}

export interface PushKeys {
  readonly p256dh: string;
  readonly auth: string;
}

/** The hash a subscription is known by in the database. */
export const endpointHash = (endpoint: string): string =>
  createHash('sha256').update(endpoint).digest('hex');

/** The rule for sending to a subscription: its own host, exactly, if it is one of a push service's. `undefined` for anything else. */
export function hostRuleFor(endpoint: string): HostRule | undefined {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return undefined;
  }
  if (
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    (url.port !== '' && url.port !== '443') ||
    url.hostname === ''
  )
    return undefined;
  const host = url.hostname.toLowerCase();
  if (
    !ruleFor(
      host,
      PUSH_HOSTS.map((each) => ({ host: each })),
    )
  )
    return undefined;
  return { host };
}

const base64url = (text: unknown, bytes: number, first?: number): boolean => {
  if (typeof text !== 'string' || !/^[A-Za-z0-9_-]+$/.test(text)) return false;
  const raw = Buffer.from(text, 'base64url');
  return raw.length === bytes && (first === undefined || raw[0] === first);
};

export type SubscribeResult =
  | { readonly ok: true; readonly id: string }
  | { readonly ok: false; readonly reason: 'invalid' | 'host' | 'too_many' };

export async function subscribe(
  deps: PushDeps,
  accountId: string,
  input: { endpoint: unknown; keys: unknown },
): Promise<SubscribeResult> {
  const { endpoint } = input;
  if (typeof endpoint !== 'string' || endpoint.length < 1 || endpoint.length > ENDPOINT_MAX)
    return { ok: false, reason: 'invalid' };
  const keys = input.keys as Partial<PushKeys> | null | undefined;
  if (
    typeof keys !== 'object' ||
    keys === null ||
    !base64url(keys.p256dh, 65, 0x04) ||
    !base64url(keys.auth, 16)
  )
    return { ok: false, reason: 'invalid' };
  if (!hostRuleFor(endpoint)) return { ok: false, reason: 'host' };
  const t = (name: string) => tableOf(deps.database, name);
  const hash = endpointHash(endpoint);
  const now = deps.now();
  const existing = await dbGet<{ id: string }>(
    deps.database,
    sql`SELECT id FROM ${t('push_subscription')} WHERE account_id = ${accountId} AND endpoint_hash = ${hash}`,
  );
  if (existing) {
    // The same browser again: its keys may have been renewed.
    await dbAll(
      deps.database,
      sql`UPDATE ${t('push_subscription')} SET sealed = ${deps.sealer.seal('push_subscription', existing.id, { endpoint, keys: keys as PushKeys })}, updated_at = ${now}
          WHERE id = ${existing.id} AND account_id = ${accountId} RETURNING id`,
    );
    return { ok: true, id: existing.id };
  }
  const held = await dbGet<{ n: number | string }>(
    deps.database,
    sql`SELECT COUNT(*) AS n FROM ${t('push_subscription')} WHERE account_id = ${accountId}`,
  );
  if (Number(held?.n ?? 0) >= MAX_DEVICES) return { ok: false, reason: 'too_many' };
  const id = randomUUID();
  await dbAll(
    deps.database,
    sql`INSERT INTO ${t('push_subscription')} (id, account_id, endpoint_hash, last_ok_at, sealed, created_at, updated_at)
        VALUES (${id}, ${accountId}, ${hash}, NULL, ${deps.sealer.seal('push_subscription', id, { endpoint, keys: keys as PushKeys })}, ${now}, ${now})
        RETURNING id`,
  );
  return { ok: true, id };
}

/** Turns push off for the browser with this address, for this person. Returns whether there was one. Its waiting pushes go with it. */
export async function unsubscribe(
  deps: PushDeps,
  accountId: string,
  endpoint: unknown,
): Promise<boolean> {
  if (typeof endpoint !== 'string' || endpoint.length > ENDPOINT_MAX) return false;
  const t = (name: string) => tableOf(deps.database, name);
  const gone = await dbAll<{ id: string }>(
    deps.database,
    sql`DELETE FROM ${t('push_subscription')} WHERE account_id = ${accountId} AND endpoint_hash = ${endpointHash(endpoint)} RETURNING id`,
  );
  for (const row of gone)
    await dbAll(
      deps.database,
      sql`DELETE FROM ${t('push_outbox')} WHERE subscription_id = ${row.id} AND account_id = ${accountId} RETURNING id`,
    );
  return gone.length > 0;
}

/** How many devices a person has push on in (not where, or what they are). */
export async function countDevices(database: Database, accountId: string): Promise<number> {
  const row = await dbGet<{ n: number | string }>(
    database,
    sql`SELECT COUNT(*) AS n FROM ${tableOf(database, 'push_subscription')} WHERE account_id = ${accountId}`,
  );
  return Number(row?.n ?? 0);
}

/** Removes everything push holds of a person: their devices and what is waiting for them. Called by `People.deletePerson`. */
export async function deletePushOf(database: Database, accountId: string): Promise<void> {
  const t = (name: string) => tableOf(database, name);
  await dbAll(
    database,
    sql`DELETE FROM ${t('push_outbox')} WHERE account_id = ${accountId} RETURNING id`,
  );
  await dbAll(
    database,
    sql`DELETE FROM ${t('push_subscription')} WHERE account_id = ${accountId} RETURNING id`,
  );
}
