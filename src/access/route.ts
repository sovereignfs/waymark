import { authSettings, getAuth } from '../auth/server';

/**
 * The one way a route that is for a signed-in person is written (DESIGN.md §7): it finds the session first, checks `Origin` when it changes
 * something, and only then calls the handler, with **the account id** (better-auth's user id) and nothing a request said about who the caller is.
 * `routes.test.ts` fails on a route that `routes.ts` says is for an account and that is not wrapped by this, so that a handler cannot be added
 * that forgets to ask.
 *
 *   export const POST = accountRoute(async ({ request, accountId }) => { … });
 *
 * The answers, in the order they are decided, and none of them says more than it must:
 *
 *   404  sign-in is off: there is nobody to be, so there is nothing here (DESIGN.md §6)
 *   401  there is no session, or it has ended
 *   403  a request that changes something and does not come from this app's own address (`Origin` is not `WAYMARK_URL`'s, or is missing)
 */

/** Methods that change nothing. Anything else is a write, and a method we have not heard of is one too. */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** What a handler is given. `params` is the route's dynamic segments, as Next gives them, already awaited. */
export interface AccountContext {
  request: Request;
  accountId: string;
  params: Readonly<Record<string, string | string[] | undefined>>;
}

/** What Next calls a route handler with: the request, and the route's dynamic segments, which it gives as a promise. */
export interface RouteContext {
  params?: Promise<Record<string, string | string[] | undefined>>;
}

export type AccountHandler = (context: AccountContext) => Response | Promise<Response>;

/** What the wrapper needs from the rest of the app, so that a test can give it a better-auth instance of its own. */
export interface AccessDeps {
  /** The address people use (`WAYMARK_URL`'s origin), or undefined when sign-in is off. */
  origin(): string | undefined;
  /** The account the request's cookies belong to, or null. */
  accountOf(headers: Headers): Promise<string | null>;
}

/** The server's own: the settings it started with and the better-auth it serves. */
export const serverDeps: AccessDeps = {
  origin: () => authSettings()?.url,
  accountOf: async (headers) => {
    const auth = await getAuth();
    const session = auth ? await auth.api.getSession({ headers }) : null;
    return session?.user.id ?? null;
  },
};

const refuse = (status: 401 | 403 | 404, code: string): Response =>
  new Response(status === 404 ? null : JSON.stringify({ code }), {
    status,
    ...(status === 404 ? {} : { headers: { 'content-type': 'application/json' } }),
  });

/** Decides whether a request may go on, and as whom. Exported for the tests that try every way it can say no. */
export async function authorize(
  request: Request,
  deps: AccessDeps = serverDeps,
): Promise<{ accountId: string } | Response> {
  const origin = deps.origin();
  if (origin === undefined) return refuse(404, 'NOT_FOUND');

  const accountId = await deps.accountOf(request.headers);
  if (accountId === null) return refuse(401, 'UNAUTHORIZED');

  if (!SAFE_METHODS.has(request.method.toUpperCase()) && request.headers.get('origin') !== origin) {
    return refuse(403, 'FORBIDDEN_ORIGIN');
  }
  return { accountId };
}

/** Wraps a handler so that it runs only for a signed-in account, and is told which. */
export function accountRoute(
  handler: AccountHandler,
  deps: AccessDeps = serverDeps,
): (request: Request, context?: RouteContext) => Promise<Response> {
  return async (request, context) => {
    const allowed = await authorize(request, deps);
    if (allowed instanceof Response) return allowed;
    const params = (await context?.params) ?? {};
    return handler({ request, accountId: allowed.accountId, params });
  };
}
