import { accountRoute } from '@/src/access/route';
import { accept } from '@/src/invitations/http';
import { serverInvite } from '@/src/invitations/server';

export const dynamic = 'force-dynamic';

/** The signed-in account accepts the invitation its body names, once (DESIGN.md §11.2). */
export const POST = accountRoute(async ({ request, accountId }) =>
  accept(request, accountId, await serverInvite()),
);
