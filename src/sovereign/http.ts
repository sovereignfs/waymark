/**
 * The two notices Sovereign sends Waymark (DESIGN.md §19.2; core-app §3.6.5 and §4.5 in sovereignfs/sovereign), as the HTTP rules of
 * `POST /api/sovereign/backchannel-logout` and `POST /api/sovereign/account-deleted`. The route finds who may verify a notice and who acts on
 * it and hands them in, as `src/connections/http.ts` does, so every answer here is tested with stand-ins and each rule was seen to fail
 * with it switched off.
 *
 * The credential of these routes is the signed token and nothing else: there is no session, no cookie and no `Origin` (Sovereign's server
 * sends it), so a request is trusted exactly as far as `verify` trusts its token. What a verifier refuses is `400`, as Sovereign's contract
 * says; core being unreachable to check it is `503`; a failure of ours is `500`. Sovereign does not retry a logout notice and does retry a
 * deletion until it is answered `200`, with a new token each time, so a `5xx` for a deletion is how a failed one is made to run again.
 *
 * The route owns the HTTP and the verifier owns the token: this reads a bounded form body, takes the one field, and hands the verifier that
 * string. The route is public and the verifiers ask Sovereign for its keys, so a flood of junk would otherwise become a flood of requests to
 * it: the number of requests is capped (`NOTICE_RATE`, across all callers, since there are few honest ones), and a body bigger than a
 * token ever is, a form of another kind, or a token that is not there is refused before anything is asked of Sovereign.
 *
 * Nothing here logs the token, the person, or what went wrong beyond the kind of error.
 */
import type { Limiter, Rule } from '../limits/rate';

/** Far more than a signed notice (about half a kilobyte); a body above it is not one. */
export const MAX_BODY_BYTES = 16 * 1024;

/** All the notices Sovereign sends, together. Honest ones are few (a person signing out, an account deleted); a deletion that is refused is sent again. */
export const NOTICE_RATE: Rule = { limit: 300, windowMs: 60 * 1000 };

/** What checks a notice. Waymark's server hands in `@sovereignfs/sdk`'s `verifyLogoutToken` and `verifyAccountDeletedToken`, made for its settings. */
export interface NoticeVerifiers {
  /** Throws `InvalidNoticeError` for a notice to refuse and `CoreUnavailableError` when core could not be asked. */
  logout(token: string): Promise<{ sub?: string; sid?: string }>;
  accountDeleted(token: string): Promise<{ sub: string }>;
}

/** What is done about the person. */
export interface PeopleActions {
  endSessions(sub: string): Promise<number>;
  deletePerson(sub: string): Promise<void>;
}

export interface NoticeDeps {
  verify: NoticeVerifiers;
  people: PeopleActions;
  /** Counts the requests (`NOTICE_RATE`). Without one nothing is capped, which is for a test of something else. */
  limiter?: Limiter;
  /** Where the kind of a failure is said (never its message, which may name a host or a person). */
  log?: (line: string) => void;
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });

const invalid = () => json(400, { error: 'invalid_request' });

/** `InvalidNoticeError` and `CoreUnavailableError` are the SDK's; a name is checked and not a class, so a second copy of the package still means the same. */
const kindOf = (error: unknown): string => (error instanceof Error ? error.name : 'failure');

type Checked<T> = { ok: true; value: T } | { ok: false; response: Response };

/**
 * The field of the form Sovereign posted, or undefined for anything else: not a form, no such field, or more bytes than a notice can be. The body
 * is read no further than the limit.
 */
async function formField(request: Request, field: string): Promise<string | undefined> {
  if (
    !(request.headers.get('content-type') ?? '')
      .toLowerCase()
      .startsWith('application/x-www-form-urlencoded')
  )
    return undefined;
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return undefined;
  if (!request.body) return undefined;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) {
        await reader.cancel();
        return undefined;
      }
      chunks.push(value);
    }
  } catch {
    return undefined;
  }
  const token = new URLSearchParams(Buffer.concat(chunks).toString('utf8')).get(field);
  return token === null || token === '' ? undefined : token;
}

async function checked<T>(
  deps: NoticeDeps,
  request: Request,
  field: string,
  what: string,
  check: (token: string) => Promise<T>,
): Promise<Checked<T>> {
  if (deps.limiter) {
    const taken = await deps.limiter.take('sovereign-notice', NOTICE_RATE);
    if (!taken.ok) {
      return {
        ok: false,
        response: new Response(JSON.stringify({ error: 'rate_limited' }), {
          status: 429,
          headers: {
            'content-type': 'application/json',
            'cache-control': 'no-store',
            'retry-after': String(Math.ceil(taken.retryAfterMs / 1000)),
          },
        }),
      };
    }
  }
  const token = await formField(request, field);
  if (token === undefined) return { ok: false, response: invalid() };
  try {
    return { ok: true, value: await check(token) };
  } catch (error) {
    const kind = kindOf(error);
    if (kind === 'InvalidNoticeError') return { ok: false, response: invalid() };
    deps.log?.(`[waymark] sovereign: ${what} could not be checked (${kind})`);
    if (kind === 'CoreUnavailableError')
      return { ok: false, response: json(503, { error: 'temporarily_unavailable' }) };
    return { ok: false, response: json(500, { error: 'server_error' }) };
  }
}

/** Sovereign ended a session of this person's: end every session they have here, and answer `200`. */
export async function handleBackChannelLogout(
  request: Request,
  deps: NoticeDeps,
): Promise<Response> {
  const notice = await checked(deps, request, 'logout_token', 'a logout notice', (token) =>
    deps.verify.logout(token),
  );
  if (!notice.ok) return notice.response;
  // A token that names only a session is accepted and ends nothing: Waymark does not know core's session ids. Sovereign names the person too.
  if (notice.value.sub !== undefined) {
    try {
      await deps.people.endSessions(notice.value.sub);
    } catch (error) {
      deps.log?.(`[waymark] sovereign: a logout notice could not be acted on (${kindOf(error)})`);
      return json(500, { error: 'server_error' });
    }
  }
  return new Response(null, { status: 200, headers: { 'cache-control': 'no-store' } });
}

/**
 * The person deleted their account at Sovereign: delete what is held of them here. `200` only once it is done, so that Sovereign stops
 * sending it; `500` when it is not, so that it sends it again.
 */
export async function handleAccountDeleted(request: Request, deps: NoticeDeps): Promise<Response> {
  const notice = await checked(
    deps,
    request,
    'account_deleted_token',
    'an account-deleted notice',
    (token) => deps.verify.accountDeleted(token),
  );
  if (!notice.ok) return notice.response;
  try {
    await deps.people.deletePerson(notice.value.sub);
  } catch (error) {
    deps.log?.(
      `[waymark] sovereign: an account-deleted notice could not be acted on (${kindOf(error)})`,
    );
    return json(500, { error: 'server_error' });
  }
  return new Response(null, { status: 200, headers: { 'cache-control': 'no-store' } });
}
