import { accountRoute } from '@/src/access/route';
import { getConfig } from '@/src/config/current';
import { serverSealer } from '@/src/crypto/server';
import { getDatabase } from '@/src/db/boot';
import { type PushHttpDeps, readPush, turnOff, turnOn } from '@/src/push/http';

export const dynamic = 'force-dynamic';

const deps = async (): Promise<PushHttpDeps> => ({
  database: await getDatabase(),
  sealer: serverSealer(),
  now: Date.now,
  settings: getConfig().push,
});

/** The signed-in account's devices that Web Push can reach (DESIGN.md §17.3): its own and no one else's. */
export const GET = accountRoute(async ({ accountId }) => readPush(accountId, await deps()));
export const POST = accountRoute(async ({ request, accountId }) =>
  turnOn(request, accountId, await deps()),
);
export const DELETE = accountRoute(async ({ request, accountId }) =>
  turnOff(request, accountId, await deps()),
);
