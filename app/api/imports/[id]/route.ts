import { accountRoute } from '@/src/access/route';
import { cancelResponse } from '@/src/import/http';
import { serverImport } from '@/src/import/server';

export const dynamic = 'force-dynamic';

/** Cancels one of the signed-in account's imports that is waiting or running (DESIGN.md §16). Another person's, and one that has ended, are not found. */
export const DELETE = accountRoute(async ({ accountId, params }) =>
  cancelResponse(accountId, String(params.id ?? ''), await serverImport()),
);
