import { accountRoute } from '@/src/access/route';
import { bodyOf, fileHeaders, refusal, stored, uploadKind } from '@/src/media/http';
import { serverMedia, takeUpload } from '@/src/media/server';
import { deleteMedia, putMedia, readMedia } from '@/src/media/service';

export const dynamic = 'force-dynamic';

const idOf = (params: Readonly<Record<string, string | string[] | undefined>>): string =>
  typeof params.id === 'string' ? params.id : '';

/**
 * A file, for the account it belongs to (DESIGN.md §18.3): the statement names the account, so another person's file, and one that is not there, are the same answer. It is
 * served with the type it was stored as, `nosniff`, `Cache-Control: private`, and a policy that lets nothing in it run.
 */
export const GET = accountRoute(async ({ accountId, params }) => {
  const file = await readMedia(await serverMedia(), { accountId, id: idOf(params) });
  if (!file) return new Response(null, { status: 404 });
  return new Response(new Uint8Array(file.bytes), { headers: fileHeaders(file.type) });
});

/** Adds a file under an id the device made (a photo taken with no connection, 6.5): checked, idempotent on it, and refused as not found if the id is another account's. */
export const PUT = accountRoute(async ({ request, accountId, params }) => {
  const kind = uploadKind(new URL(request.url).searchParams.get('kind'));
  if (!kind) return refusal('not_allowed');
  if (!(await takeUpload(accountId))) return new Response(null, { status: 429 });
  const bytes = await bodyOf(request);
  if (bytes === 'too_big') return refusal('too_big');
  const result = await putMedia(await serverMedia(), { accountId, kind, bytes, id: idOf(params) });
  return result.ok ? stored(result) : refusal(result.reason);
});

/** Deletes a file, and a photo's thumbnail with it. */
export const DELETE = accountRoute(async ({ accountId, params }) => {
  const gone = await deleteMedia(await serverMedia(), { accountId, id: idOf(params) });
  return new Response(null, { status: gone ? 204 : 404 });
});
