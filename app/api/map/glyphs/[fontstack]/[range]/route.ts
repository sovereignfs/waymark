import { accountRoute } from '@/src/access/route';
import { mapResponse } from '@/src/map/http';
import { serverMap, takeMap } from '@/src/map/server';

export const dynamic = 'force-dynamic';

/**
 * A range of the map's glyphs for the signed-in account (DESIGN.md §8.1): `/api/map/glyphs/Noto Sans Regular/0-255.pbf`. Latin, Greek and Cyrillic come from the image; another range is the
 * upstream's, kept, for the `proxy` source. Only the two fonts of the style are served.
 */
export const GET = accountRoute(async ({ accountId, params }) => {
  const part = (name: string) => (typeof params[name] === 'string' ? (params[name] as string) : '');
  const map = serverMap();
  if (!map.on) return new Response(null, { status: 404 });
  if (!(await takeMap(accountId))) return new Response(null, { status: 429 });
  return mapResponse(await map.glyph(part('fontstack'), part('range')), 'glyph');
});
