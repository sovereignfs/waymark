/**
 * Every page and route of the app, and who may use it (DESIGN.md §5.2). A route that is not here, or is here with a method it does not have, fails
 * `routes.test.ts`, so that a new endpoint cannot be added without saying who may call it, and a decision in this table cannot outlive the route.
 *
 *  - `public`: anyone, signed in or not. It shows nothing that belongs to an account. A public route that changes something says what stands in
 *    for a session in `because`, and the test refuses one that does not.
 *  - `account`: a signed-in account, and only its own data. A page asks `requireAccount()`; a route is wrapped in `accountRoute` (`route.ts`),
 *    which finds the session, checks `Origin` on a write and hands over the account id. The test holds both to it.
 *
 * The rest of the rules (what a role may do on a trip) arrive with trips and sharing, in phase 2 (9.1, 10.1): then a trip's routes say the role they need.
 */
export type RouteAccess = { kind: 'public'; because?: string } | { kind: 'account' };

export interface RouteRule {
  /** The route as the app router spells it: `/api/lists/[id]`. */
  route: string;
  /** For an API route, each method it answers. A page has none. */
  methods?: Record<string, RouteAccess>;
  /** For a page. */
  page?: RouteAccess;
}

export const ROUTES: RouteRule[] = [
  // Pages
  // The landing page for a visitor, the same for everyone and with nothing of anyone in it. For someone with a session cookie the proxy shows Home at `/`.
  { route: '/', page: { kind: 'public' } },
  // Home (DESIGN.md §20.4): the front address `/` shows it to someone signed in (the proxy rewrites it), and `/home` itself is sent back to `/`.
  { route: '/home', page: { kind: 'account' } },
  { route: '/sign-in', page: { kind: 'public' } },
  { route: '/sign-up', page: { kind: 'public' } },
  // Only with mail (DESIGN.md §19.1): without it they are 404, like the routes under /api/auth that send and use the links.
  { route: '/forgot-password', page: { kind: 'public' } },
  { route: '/reset-password', page: { kind: 'public' } },
  // The page the service worker keeps (DESIGN.md §20.12): the same for everyone, with nothing of an account in it.
  { route: '/shell', page: { kind: 'public' } },
  // The app, for someone signed in: the layout around it (`app/(app)/layout.tsx`) finds who, and each page asks for itself as well.
  { route: '/checkins', page: { kind: 'account' } },
  { route: '/map', page: { kind: 'account' } },
  { route: '/places', page: { kind: 'account' } },

  // APIs
  { route: '/api/health', methods: { GET: { kind: 'public' } } },
  // The service worker's text (DESIGN.md §20.12): the same for everyone, the build's version and the names of its files, and nothing of an account.
  { route: '/sw.js', methods: { GET: { kind: 'public' } } },
  // Files (DESIGN.md §18.3): the account is the session's, and every statement names it, so another person's file is not found.
  { route: '/api/media', methods: { POST: { kind: 'account' } } },
  {
    route: '/api/media/[id]',
    methods: { GET: { kind: 'account' }, PUT: { kind: 'account' }, DELETE: { kind: 'account' } },
  },
  // better-auth's own: it checks `Origin` and the session cookie itself, and rate-limits sign-in (src/auth/auth.ts). Absent, with a 404, when sign-in is off.
  {
    route: '/api/auth/[...all]',
    methods: {
      GET: { kind: 'public' },
      POST: {
        kind: 'public',
        because: 'better-auth checks Origin, the session cookie and the rate limit',
      },
    },
  },
];
