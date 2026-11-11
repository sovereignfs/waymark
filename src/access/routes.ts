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
  // One check-in (DESIGN.md §20.6): the timeline with it open, which is the same page as `/checkins`.
  { route: '/c/[id]', page: { kind: 'account' } },
  { route: '/map', page: { kind: 'account' } },
  // The whole list of what a person was told, by day (DESIGN.md §17.1).
  { route: '/notifications', page: { kind: 'account' } },
  { route: '/places', page: { kind: 'account' } },
  // One place (DESIGN.md §20.8): the places with it open, which is the same page as `/places`.
  { route: '/places/[id]', page: { kind: 'account' } },
  // Settings (DESIGN.md §21): the profile, sign-in and data, for the signed-in account only.
  { route: '/settings', page: { kind: 'account' } },

  // APIs
  { route: '/api/health', methods: { GET: { kind: 'public' } } },
  // The service worker's text (DESIGN.md §20.12): the same for everyone, the build's version and the names of its files, and nothing of an account.
  { route: '/sw.js', methods: { GET: { kind: 'public' } } },
  // What Settings reads and changes of the signed-in account's own profile.
  { route: '/api/settings', methods: { GET: { kind: 'account' }, PATCH: { kind: 'account' } } },
  // Files (DESIGN.md §18.3): the account is the session's, and every statement names it, so another person's file is not found.
  { route: '/api/media', methods: { POST: { kind: 'account' } } },
  {
    route: '/api/media/[id]',
    methods: { GET: { kind: 'account' }, PUT: { kind: 'account' }, DELETE: { kind: 'account' } },
  },
  // Notices (DESIGN.md §17.1): the account's own, listed and marked read; every statement names the account, so another person's are not found.
  { route: '/api/notices', methods: { GET: { kind: 'account' }, POST: { kind: 'account' } } },
  // What is emailed (DESIGN.md §17.2, §21): the account's own choices, read and changed; every statement names the account.
  { route: '/api/notices/prefs', methods: { GET: { kind: 'account' }, PUT: { kind: 'account' } } },
  // Imports (DESIGN.md §16): the account's own, listed, uploaded (limited for each account) and cancelled; every statement names the account, so another person's are not found.
  { route: '/api/imports', methods: { GET: { kind: 'account' }, POST: { kind: 'account' } } },
  { route: '/api/imports/[id]', methods: { DELETE: { kind: 'account' } } },
  // Sovereign's notices to the app (DESIGN.md §19.2): the signed token in the body is the credential. There is no session, cookie or Origin, since core's server sends them; each is verified by the SDK
  // against core's keys, its audience and its age, a replay is refused (`notice_seen`), the number of requests is capped, and where no core is set up they are not found.
  {
    route: '/api/sovereign/backchannel-logout',
    methods: {
      POST: {
        kind: 'public',
        because: 'a signed token from core, verified by the SDK, and a replay refused',
      },
    },
  },
  {
    route: '/api/sovereign/account-deleted',
    methods: {
      POST: {
        kind: 'public',
        because: 'a signed token from core, verified by the SDK, and a replay refused',
      },
    },
  },
  // Exports (DESIGN.md §22): the account's own, listed, asked for (limited for each account), downloaded while ready and deleted; every statement names the account, so another person's are not found.
  { route: '/api/exports', methods: { GET: { kind: 'account' }, POST: { kind: 'account' } } },
  {
    route: '/api/exports/[id]',
    methods: { GET: { kind: 'account' }, DELETE: { kind: 'account' } },
  },
  // Finding a place (DESIGN.md §7.2): the account's own places, opened for it alone, and then the operator's place search, which only the server reaches.
  { route: '/api/places', methods: { GET: { kind: 'account' } } },
  // The device's sync (DESIGN.md §15.3): its outbox in, what was applied, refused and changed out, for the session's account alone; `Origin` is checked.
  { route: '/api/sync', methods: { POST: { kind: 'account' } } },
  // The map (DESIGN.md §8.1): style, tiles and glyphs, served by Waymark and no one else, for an account only and limited for each; with the map off, all of it is not found.
  { route: '/api/map/style/[theme]', methods: { GET: { kind: 'account' } } },
  { route: '/api/map/tiles/[z]/[x]/[y]', methods: { GET: { kind: 'account' } } },
  { route: '/api/map/glyphs/[fontstack]/[range]', methods: { GET: { kind: 'account' } } },
  // Deleting the account (DESIGN.md §23): what it would do, and doing it with the password (or a session made just now, for an account with none); the account is the session's.
  {
    route: '/api/account/delete',
    methods: { GET: { kind: 'account' }, POST: { kind: 'account' } },
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
