import { accountRoute } from '@/src/access/route';
import { serverSealer } from '@/src/crypto/server';
import { getDatabase } from '@/src/db/boot';
import { changeNotices, readNotices } from '@/src/notices/http';
import type { NoticeDeps } from '@/src/notices/notices';

export const dynamic = 'force-dynamic';

const deps = async (): Promise<NoticeDeps> => ({
  database: await getDatabase(),
  sealer: serverSealer(),
  now: Date.now,
});

/** The signed-in account's notices (DESIGN.md §17.1): the bell and `/notifications` read them here, and mark them read. Its own and no one else's. */
export const GET = accountRoute(async ({ accountId }) => readNotices(accountId, await deps()));
export const POST = accountRoute(async ({ request, accountId }) =>
  changeNotices(request, accountId, await deps()),
);
