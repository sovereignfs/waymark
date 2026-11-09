import { accountRoute } from '@/src/access/route';
import { bodyOf, refusal, stored, uploadKind } from '@/src/media/http';
import { serverMedia, takeUpload } from '@/src/media/server';
import { putMedia } from '@/src/media/service';

export const dynamic = 'force-dynamic';

/**
 * Adds a file for the signed-in account (DESIGN.md §18.3): the body is the file, `?kind=` says what it is for (`photo`, `attachment`, `import`), and the server makes its id. It is
 * judged by its bytes, never its name or type; an image is re-encoded with its metadata gone; and what it adds is counted against the account's limit. A photo taken offline is
 * sent with an id of its own, to `PUT /api/media/<id>`, so that a retry is the same upload.
 */
export const POST = accountRoute(async ({ request, accountId }) => {
  const kind = uploadKind(new URL(request.url).searchParams.get('kind'));
  if (!kind) return refusal('not_allowed');
  if (!(await takeUpload(accountId))) return new Response(null, { status: 429 });
  const bytes = await bodyOf(request);
  if (bytes === 'too_big') return refusal('too_big');
  const result = await putMedia(await serverMedia(), { accountId, kind, bytes });
  return result.ok ? stored(result) : refusal(result.reason);
});
