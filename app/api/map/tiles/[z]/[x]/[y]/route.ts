import { accountRoute } from '@/src/access/route';
import { mapResponse } from '@/src/map/http';
import { serverMap, takeMap } from '@/src/map/server';

export const dynamic = 'force-dynamic';

/**
 * A vector tile for the signed-in account (DESIGN.md §8.1), from the source the operator chose: the disk cache or the upstream, or a PMTiles file. Nothing in what leaves the server names a
 * person. With the map off it is not found, and with the upstream out of reach it says when to try again.
 */
export const GET = accountRoute(async ({ accountId, params }) => {
  const part = (name: string) => (typeof params[name] === 'string' ? (params[name] as string) : '');
  const map = serverMap();
  if (!map.on) return new Response(null, { status: 404 });
  if (!(await takeMap(accountId))) return new Response(null, { status: 429 });
  return mapResponse(await map.tile(part('z'), part('x'), part('y')), 'tile');
});
