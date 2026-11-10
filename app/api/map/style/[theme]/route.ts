import { accountRoute } from '@/src/access/route';
import { THEMES, type Theme } from '@/src/map/style';
import { originFor, serverMap, takeMap } from '@/src/map/server';

export const dynamic = 'force-dynamic';

/**
 * Waymark's map style for a theme (`light.json` or `dark.json`), for the signed-in account (DESIGN.md §8.1). It names Waymark's own tile and glyph addresses and no one else's, and carries the
 * attribution. With the map off it is not found.
 */
export const GET = accountRoute(async ({ request, accountId, params }) => {
  const name = typeof params.theme === 'string' ? params.theme : '';
  const theme = name.replace(/\.json$/, '') as Theme;
  const style =
    name.endsWith('.json') && THEMES.includes(theme)
      ? serverMap().style(theme, originFor(request))
      : undefined;
  if (!style) return new Response(null, { status: 404 });
  if (!(await takeMap(accountId))) return new Response(null, { status: 429 });
  return new Response(JSON.stringify(style), {
    headers: { 'content-type': 'application/json', 'cache-control': 'private, max-age=3600' },
  });
});
