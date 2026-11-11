import { accountRoute } from '@/src/access/route';
import { getDatabase } from '@/src/db/boot';
import { RateLimiter } from '@/src/limits/rate';
import { listResponse, requestResponse } from '@/src/portability/http';
import { serverExport } from '@/src/portability/server';

export const dynamic = 'force-dynamic';

/** The signed-in account's exports (DESIGN.md §22): listed, and one asked for, to be built by a job. Its own and no one else's. */
export const GET = accountRoute(async ({ accountId }) =>
  listResponse(accountId, await serverExport()),
);
export const POST = accountRoute(async ({ accountId }) =>
  requestResponse(accountId, await serverExport(), async () => {
    // Five an hour for each account: an export reads everything and is built once at a time anyway.
    const taken = await new RateLimiter(await getDatabase()).take(`export:request:${accountId}`, {
      limit: 5,
      windowMs: 60 * 60_000,
    });
    return taken.ok;
  }),
);
