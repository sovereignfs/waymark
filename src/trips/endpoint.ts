import { readCapped } from '../access/body';
import type { Limiter, Rule } from '../limits/rate';
import { type Op, applyOp, parseOp } from './ops';
import type { TripDeps } from './trips';

/**
 * `POST /api/ops` (DESIGN.md §15.7): one operation on a trip, from a person who is signed in. The route (`app/api/ops/route.ts`) is wrapped in `accountRoute`, which has found the session and checked `Origin`; this is what
 * runs for the account it names, with everything it needs given to it, so that a test runs it as each person and each role.
 *
 * **The status line is for the request, and the body for the operation.** A request is refused whole when it is not an operation (400), is too big (413) or comes too often (429). An operation that is refused is answered `200`
 * with its refusal, which says no more than `not_found` for what is not theirs.
 */
export interface OpsDeps extends TripDeps {
  readonly limiter: Limiter;
}

export const OPS_RATE: Rule = { limit: 240, windowMs: 60_000 };
export const OPS_BODY_BYTES = 16 * 1024;

const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers },
  });

export async function handleOp(body: string, accountId: string, deps: OpsDeps): Promise<Response> {
  const taken = await deps.limiter.take(`ops:${accountId}`, OPS_RATE);
  if (!taken.ok)
    return json(
      429,
      { code: 'RATE_LIMITED' },
      { 'retry-after': String(Math.max(1, Math.ceil(taken.retryAfterMs / 1000))) },
    );
  let request: unknown;
  try {
    request = JSON.parse(body);
  } catch {
    return json(400, { code: 'BAD_REQUEST' });
  }
  const parsed = parseOp(request);
  // Not an operation: the request is refused, and says nothing of why that a device did not already know.
  if (!parsed.ok) return json(400, { code: 'BAD_REQUEST' });
  const op: Op = parsed.value;
  return json(200, await applyOp(deps, accountId, op));
}

export async function opsResponse(
  request: Request,
  accountId: string,
  deps: OpsDeps,
): Promise<Response> {
  const body = await readCapped(request, OPS_BODY_BYTES);
  if (body === null) return json(413, { code: 'TOO_LARGE' });
  return handleOp(body, accountId, deps);
}
