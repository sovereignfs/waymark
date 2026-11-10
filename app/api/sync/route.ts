import { accountRoute } from '@/src/access/route';
import { handleSync } from '@/src/sync/endpoint';
import { serverSync, takeSync } from '@/src/sync/server';

export const dynamic = 'force-dynamic';

/** The most a request may hold, in bytes: fifty mutations of a check-in or two each are far under it. */
const MAX_BODY_BYTES = 1024 * 1024;

/**
 * The device's sync (DESIGN.md §15.3): its outbox in order and a cursor for its stream in, what was applied and refused and what changed since in the answer. The account is the session's;
 * `Origin` is checked because the request changes things. The answer is the account's own and is never cached by a browser or a proxy.
 */
export const POST = accountRoute(async ({ request, accountId }) => {
  if (!(await takeSync(accountId))) return new Response(null, { status: 429 });
  const length = Number(request.headers.get('content-length') ?? 0);
  if (length > MAX_BODY_BYTES) return new Response(null, { status: 413 });
  let body: unknown;
  try {
    const text = await request.text();
    if (text.length > MAX_BODY_BYTES) return new Response(null, { status: 413 });
    body = JSON.parse(text);
  } catch {
    return Response.json({ code: 'BAD_REQUEST' }, { status: 400 });
  }
  const answer = await handleSync(await serverSync(), accountId, body);
  return new Response(JSON.stringify(answer.body), {
    status: answer.status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
});
