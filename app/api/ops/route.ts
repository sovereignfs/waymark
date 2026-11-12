import { accountRoute } from '@/src/access/route';
import { opsResponse } from '@/src/trips/endpoint';
import { serverOps } from '@/src/trips/server';

// The one door every online operation on a trip comes through (DESIGN.md §15.7). The wrapper has found the session and checked `Origin`; the account it hands over is the only one there is, and the permission
// is in the statement that does the work (`src/access/trip.ts`).
export const dynamic = 'force-dynamic';

export const POST = accountRoute(async ({ request, accountId }) =>
  opsResponse(request, accountId, await serverOps()),
);
