import { accountRoute } from '@/src/access/route';
import { deleteResponse, downloadResponse } from '@/src/portability/http';
import { serverExport } from '@/src/portability/server';

export const dynamic = 'force-dynamic';

/** One of the signed-in account's exports (DESIGN.md §22): its ZIP, to download while it is ready, and its deletion. Another person's, and one that is not ready or has run out, are not found. */
export const GET = accountRoute(async ({ accountId, params }) =>
  downloadResponse(accountId, String(params.id ?? ''), await serverExport()),
);
export const DELETE = accountRoute(async ({ accountId, params }) =>
  deleteResponse(accountId, String(params.id ?? ''), await serverExport()),
);
