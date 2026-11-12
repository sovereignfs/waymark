import { createSovereign } from '@sovereignfs/sdk';
import { getConfig } from '../config/current';
import { serverSealer } from '../crypto/server';
import { getAuthDatabase, getDatabase } from '../db/boot';
import { transaction } from '../db/exec';
import { queueNoticeMail } from '../notices/notices';
import { site } from '../site';
import { subOfAccount } from './identity';
import type { CoreOutboxDeps, CoreSender } from './outbox';
import { type CoreServices, coreServices } from './services';

/**
 * Core's services as this server has them (DESIGN.md §19.4): present only where the people sign in through a core **and** the server knows its own address (a link back to a notice needs it). The SDK's client is
 * the app as itself and needs neither a token store nor a session store. Made once per process, so that a core that refused a service is rested across calls.
 */
const KEY = Symbol.for('waymark.core-services');
type Holder = { [KEY]?: CoreServices | null };

export function serverCoreServices(): CoreServices | undefined {
  const holder = globalThis as Holder;
  if (holder[KEY] === undefined) {
    const { auth, url } = getConfig();
    const core = auth?.sovereign;
    holder[KEY] =
      core && url
        ? coreServices({
            sovereign: createSovereign({
              appUrl: url,
              coreUrl: new URL(core.issuer).origin,
              clientId: core.clientId,
              clientSecret: core.clientSecret,
            }).app,
            now: Date.now,
            log: (line) => console.warn(`[waymark] ${line}`),
          })
        : null;
  }
  return holder[KEY] ?? undefined;
}

/** What the job that makes the calls needs, or undefined where there is no core to call. */
export async function serverCoreOutbox(
  now: () => number = Date.now,
): Promise<{ deps: CoreOutboxDeps; sender: CoreSender } | undefined> {
  const services = serverCoreServices();
  const { url, mail } = getConfig();
  if (!services || !url) return undefined;
  const database = await getDatabase();
  const authDatabase = await getAuthDatabase();
  const sealer = serverSealer();
  return {
    deps: { database, sealer, now },
    sender: {
      services,
      subOf: async (accountId) => (await subOfAccount(authDatabase, accountId)) ?? undefined,
      absolute: (path) => `${url}${path}`,
      // An email core would not send goes by Waymark's own mail where there is any.
      ...(mail
        ? {
            fallbackMail: async (accountId, content) =>
              transaction(database, (tx) =>
                queueNoticeMail(
                  tx,
                  sealer,
                  now(),
                  { app: site.name, url },
                  {
                    accountId,
                    title: content.title,
                    detail: content.body,
                    path: content.path ?? '/notifications',
                  },
                ),
              ),
          }
        : {}),
    },
  };
}
