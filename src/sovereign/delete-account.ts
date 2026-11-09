import { readCapped } from '../access/body';
import type { Limiter, Rule } from '../limits/rate';
import { summaryOf } from '../media/service';
import { type PeopleDeps, deletePerson } from './people';

/**
 * `/api/account/delete` (DESIGN.md §23): what deleting the account would do, and doing it. **It asks for the password** (a stolen session cannot delete an
 * account), counted, and runs `People.deletePerson` for the session's account and no other. **An account that came in through Sovereign alone has no
 * password, so it asks for a session made in the last few minutes instead**: signing in again is the proof. The preview says what would go.
 */
export interface DeleteDeps extends PeopleDeps {
  readonly limiter: Limiter;
  /** Whether this is the password of the account the request is for. */
  verify(request: Request, password: string): Promise<boolean>;
  /** Whether the account has a password to ask for. */
  hasPassword(accountId: string): Promise<boolean>;
  /** Whether the request's session was made recently enough to stand in for a password the account does not have. */
  fresh(request: Request): Promise<boolean>;
}

const RATE: Rule = { limit: 5, windowMs: 10 * 60_000 };

const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers },
  });

export async function deletionPreview(accountId: string, deps: DeleteDeps): Promise<Response> {
  const stored = await summaryOf(deps.database, accountId);
  return json(200, {
    // Whether it asks for the password (or, for an account with none, a session made just now).
    password: await deps.hasPassword(accountId),
    // What goes, in numbers: their files now, and their places, check-ins and trips as those exist (the trip rules come with 10.4).
    files: stored.files,
    bytes: stored.bytes,
  });
}

/**
 * `POST { password }`: 204 when it is done; 400 for what is not a request; 403 for a password that is not this account's (`WRONG_PASSWORD`), or, for an account
 * with none, a session that is not recent (`SESSION_NOT_FRESH`); 429 when tried too often.
 */
export async function deleteAccount(
  request: Request,
  accountId: string,
  deps: DeleteDeps,
): Promise<Response> {
  const body = await readCapped(request, 1024);
  if (body === null) return json(413, { code: 'TOO_LARGE' });
  const taken = await deps.limiter.take(`delete-account:${accountId}`, RATE);
  if (!taken.ok)
    return json(
      429,
      { code: 'RATE_LIMITED' },
      { 'retry-after': String(Math.max(1, Math.ceil(taken.retryAfterMs / 1000))) },
    );
  let password: unknown;
  try {
    password = (JSON.parse(body) as { password?: unknown } | null)?.password;
  } catch {
    return json(400, { code: 'BAD_REQUEST' });
  }
  if (await deps.hasPassword(accountId)) {
    if (typeof password !== 'string' || password === '' || password.length > 1000)
      return json(400, { code: 'BAD_REQUEST' });
    if (!(await deps.verify(request, password))) return json(403, { code: 'WRONG_PASSWORD' });
  } else if (!(await deps.fresh(request))) {
    return json(403, { code: 'SESSION_NOT_FRESH' });
  }
  await deletePerson(deps, accountId);
  return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } });
}
