import { getConfig } from '../config/current';
import { serverSealer } from '../crypto/server';
import { getDatabase } from '../db/boot';
import type { PushSendDeps } from './outbox';

/** What sending a push needs, as this process has it; `undefined` when this server has no Web Push key (nothing is queued either, and the job does nothing). */
export async function serverPush(now: () => number = Date.now): Promise<PushSendDeps | undefined> {
  const settings = getConfig().push;
  if (!settings) return undefined;
  return { database: await getDatabase(), sealer: serverSealer(), now, settings };
}
