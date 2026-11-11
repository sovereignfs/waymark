import { accountRoute } from '@/src/access/route';
import { getConfig } from '@/src/config/current';
import { getDatabase } from '@/src/db/boot';
import { changePref, readPrefs, type PrefsDeps } from '@/src/notices/prefs-http';

export const dynamic = 'force-dynamic';

const deps = async (): Promise<PrefsDeps> => ({
  database: await getDatabase(),
  mail: getConfig().mail !== undefined,
  now: Date.now,
});

/** The signed-in account's choices of what is emailed (DESIGN.md §17.2, §21): its own and no one else's. */
export const GET = accountRoute(async ({ accountId }) => readPrefs(accountId, await deps()));
export const PUT = accountRoute(async ({ request, accountId }) =>
  changePref(request, accountId, await deps()),
);
