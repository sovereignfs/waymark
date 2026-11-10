import { accountRoute } from '@/src/access/route';
import { findPlaces } from '@/src/places/http';
import { serverFind, takeSearch } from '@/src/places/server';

export const dynamic = 'force-dynamic';

/**
 * Finds a place for the signed-in account (DESIGN.md §7.2): its own places first and then the operator's place search, or what is at a point (`?lat=&lng=`). The browser asks this server
 * and no other; see `src/places/http.ts` for what comes back. Nothing about what was asked is logged, and the answer is never cached by a browser or a proxy.
 */
export const GET = accountRoute(async ({ request, accountId }) => {
  if (!(await takeSearch(accountId))) return new Response(null, { status: 429 });
  const answer = await findPlaces(await serverFind(), accountId, new URL(request.url).searchParams);
  return new Response(JSON.stringify(answer.body), {
    status: answer.status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
});
