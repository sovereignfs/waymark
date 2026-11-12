import { readCapped } from '../access/body';
import type { Limiter } from '../limits/rate';
import { TripError } from '../trips/format';
import { type InviteDeps, acceptInvitation, previewInvitation } from './service';

/**
 * What `/api/invitations` answers (DESIGN.md §11.2). **The preview is public** (`GET /api/invitations/<token>`): it is what the page at `/invite/<token>` shows to anyone with the link, the trip's name, its dates and who invited, **and
 * nothing else**; every link that cannot be used (wrong, expired, revoked, used, of a trip that is gone) is **the same `404`**, so a link says nothing of why. **Accepting needs a signed-in account** (`POST /api/invitations/accept`,
 * `{ token }`): it joins the trip, once. Neither is cached, and a reply never carries the token back.
 */
export interface InviteHttpDeps extends InviteDeps {
  readonly limiter: Limiter;
}

const noStore = { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' };
const notThere = () => Response.json({ code: 'NOT_FOUND' }, { status: 404, headers: noStore });
const bad = () => Response.json({ code: 'BAD_REQUEST' }, { status: 400, headers: noStore });
/** Looking up links: a few hundred in a minute from the one place, in all, is far more than anyone with a link needs. */
const PREVIEW_RATE = { limit: 120, windowMs: 60_000 } as const;
const ACCEPT_RATE = { limit: 20, windowMs: 60_000 } as const;

export async function preview(token: string, deps: InviteHttpDeps): Promise<Response> {
  // Counted for the whole server and not for a holder: nothing identifies one, and a link is 256 bits that cannot be guessed. This keeps the lookup from being a way to load the database.
  const taken = await deps.limiter.take('invite-preview', PREVIEW_RATE);
  if (!taken.ok) return Response.json({ code: 'RATE_LIMITED' }, { status: 429, headers: noStore });
  const found = await previewInvitation(deps, token);
  return found ? Response.json(found, { headers: noStore }) : notThere();
}

export async function accept(
  request: Request,
  accountId: string,
  deps: InviteHttpDeps,
): Promise<Response> {
  const taken = await deps.limiter.take(`invite-accept:${accountId}`, ACCEPT_RATE);
  if (!taken.ok) return Response.json({ code: 'RATE_LIMITED' }, { status: 429, headers: noStore });
  const text = await readCapped(request, 1024);
  if (text === null) return Response.json({ code: 'TOO_LARGE' }, { status: 413, headers: noStore });
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return bad();
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return bad();
  const asked = body as Record<string, unknown>;
  if (Object.keys(asked).some((key) => key !== 'token') || typeof asked.token !== 'string')
    return bad();
  try {
    const result = await acceptInvitation(deps, accountId, asked.token);
    return result ? Response.json(result, { headers: noStore }) : notThere();
  } catch (error) {
    // A trip that is full says so in words.
    if (error instanceof TripError)
      return Response.json(
        { code: 'REFUSED', sentence: error.message },
        { status: 409, headers: noStore },
      );
    throw error;
  }
}
