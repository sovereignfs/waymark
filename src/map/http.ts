import type { Served } from './service';

/**
 * What a map route answers for what the service served (DESIGN.md §8.1). A tile with nothing in it is a `204`, which MapLibre draws as an empty gap; a glyph range that is not there is a `404`;
 * an upstream that cannot be reached is a `503` that says when to try again; no map is a `404`, whatever was asked. A tile is public map data and is kept by the browser for a day (`private`:
 * a shared cache is not a place for what is behind a sign-in).
 */
export function mapResponse(served: Served, kind: 'tile' | 'glyph'): Response {
  switch (served.status) {
    case 'ok':
      return new Response(new Uint8Array(served.body), {
        status: 200,
        headers: {
          'content-type': served.type,
          ...(served.gzip ? { 'content-encoding': 'gzip' } : {}),
          'cache-control': 'private, max-age=86400',
          'x-content-type-options': 'nosniff',
        },
      });
    case 'empty':
      return new Response(null, { status: kind === 'tile' ? 204 : 404 });
    case 'bad':
    case 'off':
      return new Response(null, { status: 404 });
    case 'unavailable':
      return new Response(null, { status: 503, headers: { 'retry-after': '5' } });
  }
}
