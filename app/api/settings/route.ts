import { accountRoute } from '@/src/access/route';
import { serverSealer } from '@/src/crypto/server';
import { getDatabase } from '@/src/db/boot';
import { changeSettings, readSettings, type SettingsDeps } from '@/src/settings/api';

export const dynamic = 'force-dynamic';

const deps = async (): Promise<SettingsDeps> => ({
  database: await getDatabase(),
  sealer: serverSealer(),
  now: Date.now,
});

/** What Settings reads and changes of the signed-in account's own profile (DESIGN.md §21). */
export const GET = accountRoute(async ({ accountId }) => readSettings(accountId, await deps()));
export const PATCH = accountRoute(async ({ request, accountId }) =>
  changeSettings(request, accountId, await deps()),
);
