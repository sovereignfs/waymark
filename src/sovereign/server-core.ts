import { type Sovereign, createSovereign } from '@sovereignfs/sdk';
import { getConfig } from '../config/current';
import { serverSealer } from '../crypto/server';
import { getAuthDatabase, getDatabase } from '../db/boot';
import { transaction } from '../db/exec';
import { queueNoticeMail } from '../notices/notices';
import { site } from '../site';
import { type CoreDirectory, coreDirectory } from './directory';
import { subOfAccount } from './identity';
import type { CoreOutboxDeps, CoreSender } from './outbox';
import { type CoreServices, coreServices } from './services';
import { type CoreTokenStore, coreTokenStore } from './tokens';

/**
 * The one client of a Sovereign core this process has, or undefined where the people do not sign in through one or the server does not know its own address (a link back needs it). **Made once per process**, so that a core
 * that refused a service is rested across calls and the SDK's tokens are cached. The app calls core as itself (`sv.app`: its bell, its email, its activity) and, for the directory, as the person asking (`sv.as`), which needs a
 * place for their refresh token: the app's own, sealed (`tokens.ts`).
 */
const CLIENT = Symbol.for('waymark.sovereign-client');
type ClientHolder = { [CLIENT]?: Sovereign | null };

/** The token store over this server's database, opened when it is first used: the SDK is made at start and must not wait for a database. */
function lazyTokenStore(): CoreTokenStore {
  let made: Promise<CoreTokenStore> | undefined;
  const store = () =>
    (made ??= getDatabase().then((database) =>
      coreTokenStore({ database, sealer: serverSealer(), now: Date.now }),
    ));
  return {
    read: async (sub) => (await store()).read(sub),
    write: async (sub, next, previous) => (await store()).write(sub, next, previous),
    lock: async (sub, work) => (await store()).lock(sub, work),
    delete: async (sub) => (await store()).delete(sub),
  };
}

function serverSovereign(): Sovereign | undefined {
  const holder = globalThis as ClientHolder;
  if (holder[CLIENT] === undefined) {
    const { auth, url } = getConfig();
    const core = auth?.sovereign;
    holder[CLIENT] =
      core && url
        ? createSovereign({
            appUrl: url,
            coreUrl: new URL(core.issuer).origin,
            clientId: core.clientId,
            clientSecret: core.clientSecret,
            tokenStore: lazyTokenStore(),
          })
        : null;
  }
  return holder[CLIENT] ?? undefined;
}

/**
 * Core's services as this server has them (DESIGN.md §19.4): present only where the people sign in through a core **and** the server knows its own address. Made once per process, so that a core that refused a service is
 * rested across calls.
 */
const KEY = Symbol.for('waymark.core-services');
type Holder = { [KEY]?: CoreServices | null };

export function serverCoreServices(): CoreServices | undefined {
  const holder = globalThis as Holder;
  if (holder[KEY] === undefined) {
    const sovereign = serverSovereign();
    holder[KEY] = sovereign
      ? coreServices({
          sovereign: sovereign.app,
          now: Date.now,
          log: (line) => console.warn(`[waymark] ${line}`),
        })
      : null;
  }
  return holder[KEY] ?? undefined;
}

/** Core's directory as this server has it, for finding people to invite: present where core's services are (DESIGN.md §11.2). */
const DIRECTORY = Symbol.for('waymark.core-directory');
type DirectoryHolder = { [DIRECTORY]?: CoreDirectory | null };

export function serverDirectory(): CoreDirectory | undefined {
  const holder = globalThis as DirectoryHolder;
  if (holder[DIRECTORY] === undefined) {
    const sovereign = serverSovereign();
    holder[DIRECTORY] = sovereign
      ? coreDirectory({
          sovereign,
          now: Date.now,
          log: (line) => console.warn(`[waymark] ${line}`),
        })
      : null;
  }
  return holder[DIRECTORY] ?? undefined;
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
