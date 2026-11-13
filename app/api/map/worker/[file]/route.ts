import { workerFile } from '@/src/map/worker';

export const dynamic = 'force-dynamic';

/**
 * MapLibre's web worker, served from this origin (`src/map/worker.ts`, DESIGN.md §8.1, §25): the design system's `Map` is given its address (`workerUrl`), so the page's policy needs only `worker-src 'self'` and no
 * worker is made from a `blob:`. It is library code, the same for everyone, with nothing of anyone in it, so it asks for no session; **only the two files the worker is made of** are served.
 */
export async function GET(_request: Request, context: { params: Promise<{ file: string }> }) {
  const { file } = await context.params;
  const body = await workerFile(file);
  if (!body) return new Response(null, { status: 404 });
  return new Response(new Uint8Array(body), {
    headers: {
      'content-type': 'text/javascript; charset=utf-8',
      'cache-control': 'public, max-age=3600',
      'x-content-type-options': 'nosniff',
    },
  });
}
