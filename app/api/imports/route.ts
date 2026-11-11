import { accountRoute } from '@/src/access/route';
import { getDatabase } from '@/src/db/boot';
import { listResponse, uploadResponse } from '@/src/import/http';
import { serverImport } from '@/src/import/server';
import { RateLimiter } from '@/src/limits/rate';

export const dynamic = 'force-dynamic';

/** The signed-in account's imports (DESIGN.md §16): listed with their counts, and an export uploaded to be read by a job. Its own and no one else's. */
export const GET = accountRoute(async ({ accountId }) =>
  listResponse(accountId, await serverImport()),
);
export const POST = accountRoute(async ({ request, accountId }) =>
  uploadResponse(request, accountId, await serverImport(), async () => {
    // Ten an hour for each account: an export is large, and one at a time is the rule anyway.
    const taken = await new RateLimiter(await getDatabase()).take(`import:upload:${accountId}`, {
      limit: 10,
      windowMs: 60 * 60_000,
    });
    return taken.ok;
  }),
);
