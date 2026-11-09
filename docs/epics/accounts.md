# Epic 2: Accounts and sign-in

## Status

📋 Planned.

## Overview

Who can sign in, how, and what Waymark keeps of them: local accounts and core, from one image; Waymark's own profile of name and email; core's two notices; the
one routine that removes everything of a person; the landing page; Settings. Sign-in is copied from Tusk; the profile follows Tally's `person`, without
placeholders.

## Related

[`DESIGN.md`](../../DESIGN.md) §6, §19, §21, §23

## Tasks

#### ✅ 2.1 — Local sign-in

**Goal:** local accounts, as Tusk's. **Design:** §19.1, §6.2. **Depends on:** 1.5, 1.8.

**Technical:** copy Tusk's `src/auth/` (better-auth in `waymark_auth`, password, passkey, authenticator app with backup codes, the `Auth` screens), on when
`WAYMARK_AUTH_LOCAL=1`, the sign-in pages 404 otherwise; the sign-up policy hook with `open` and `closed` (`invite` is 10.2); email verification and
password reset only with mail set up (through 12.2 once it is in; until then, Tusk's direct send); rate limits on sign-up and sign-in.

**Accepts when:** the first account can be made and signed in to; with `closed`, a second sign-up is refused; with `AUTH_LOCAL` off, every sign-in page
answers 404.

**Done as:** copied from Tusk and renamed: `src/auth/` (`auth.ts`, `client`, `cookie`, `messages`, `mail-routes`, `server`, `session`, `users`, `test-support`, `testing/totp`, the
`screens/` of sign-in, sign-up, forgot and reset, and the tests: sign-up and sign-in flows, the closed policy, rate limits, two-factor, mail and the routes), `src/mail/` (`smtp`, `templates`, `memory`, the
SMTP sink and its test), `src/access/route.ts` and `routes.ts` with their tests, the four pages, `app/api/auth/[...all]`, and the proxy's rule that the sign-in pages are not found with local
sign-in off. **Trimmed:** the Sovereign provider (`genericOAuth`, account-linking trust, the fake Sovereign and its tests) waits for 2.3, and the sign-in page offers no Sovereign button until then;
`AccountMenu` is _Sign out_ alone (the device's store, Settings and the rest of the menu come with 6.2, 2.6 and 2.7). Written for Waymark: `src/access/routes.ts` lists the routes that
exist (the app's pages are for an account, each page asks `requireAccount()` as well as the layout, `/api/health`, `/sw.js` and better-auth's routes are public) and its test holds `app/` to it
both ways; `(app)/layout.tsx` finds the session and sends a visitor to sign in, and `SignedInArea` shows the session's name and address until the profile does (2.7). **Mail:** verification and reset are
Tusk's direct send through `src/mail/smtp.ts` and are mounted only when `WAYMARK_SMTP_HOST` is set, as `AGENTS.md` says; 12.2 moves them to the outbox. **Seen:** the auth store's flows pass on a
`file:` database, sqld and PostgreSQL (341 pass, 4 skipped by leg). In both browsers: a visitor to `/` or any page of the app is sent to sign in; the first account is made and signs in; a wrong password reads
the same as an address with no account; a second sign-up is refused by the server with `SIGNUP_CLOSED` and the page does not offer one; and on an instance with no way of signing in every sign-in page, the
app and `/api/auth` answer 404 (and `/api/health` still answers). The smoke test passes on sqld and PostgreSQL too. The browser tests wait out the sign-in rate limit when two browsers meet it, as Tusk's do.

#### 📋 2.2 — Landing page and the address `/`

**Goal:** what a visitor sees, and Home for a signed-in person. **Design:** §20.3, §20.4. **Depends on:** 2.1.

**Technical:** `/` renders a short landing page (what Waymark is, sign in, sign up when allowed) for a visitor and Home (7.6) when signed in; nothing personal
in the landing page's HTML; the shell page for the worker is separate (1.11).

**Accepts when:** a visitor and a signed-in person get the right page from `/`, and the visitor's page carries no data of anyone.

#### 📋 2.3 — Sign-in through core

**Goal:** a Sovereign core as a way in. **Design:** §19.1, §19.2, §19.4. **Depends on:** 2.1, 2.7.

**Technical:** copy Tusk's `genericOAuth` provider with PKCE, on when `WAYMARK_CORE_*` are set; an account for anyone core signs in, whatever
`AUTH_SIGNUP` says; its profile made from core's name and email, not overwritten after; no implicit linking (a core login whose email is a local account's
is refused until linked from a signed-in session with the same address); the fake Sovereign for tests, copied. Scopes `openid profile email` in phase 1.

**Accepts when:** against the fake Sovereign, signing in makes an account and profile, a second sign-in finds it by `sub`, and an email match alone
links nothing.

#### 📋 2.4 — Core's notices

**Goal:** back-channel logout and account deleted. **Design:** §19.2. **Depends on:** 2.3, 2.5.

**Technical:** copy Tusk's routes at `/api/sovereign/backchannel-logout` and `/api/sovereign/account-deleted`, verified by the SDK's
`verifyLogoutToken` and `verifyAccountDeletedToken`, replays refused through `notice_seen`, a bounded form, one rate limit, 404 where core is not set;
account deleted runs `People.deletePerson` and answers `200` only once rows and files are gone.

**Accepts when:** against `createFakeCore`, logout ends every session of the person, account deleted removes them, and a replayed notice is refused after
a restart.

#### 📋 2.5 — Deleting a person

**Goal:** one routine that removes everything of an account. **Design:** §23. **Depends on:** 2.7, 3.2.

**Technical:** `People.deletePerson` in `src/sovereign/people.ts`, as Tusk's: safe to run twice, the `sub` link last; phase 1's tables (profile, places,
check-ins, photos, media and their files through 3.2's delete, import jobs, settings, notices, preferences, mail queued to them, credential, rate
counters, better-auth's rows); the trip rules (handing over, deleting an empty trip, clearing `created_by`) join with 10.4. Reached from Settings > Data
after the password or a fresh session, with what goes said; the device's database deleted.

**Accepts when:** a test seeding one row of every table for the person and a second person finds nothing of the first afterwards, files included, and
the second's rows intact; a new table fails the test until it is handled.

#### 📋 2.6 — Settings

**Goal:** `/settings` with its sections. **Design:** §21. **Depends on:** 2.7, 1.8.

**Technical:** Profile (name, email, units, first day of the week), Sign-in (Tusk's sections, linking core once 2.3 is in), Data (filled by 8.3, 15.1,
15.2, 2.5); Check-ins, Notifications and This device are filled by 10.3, 12.3 and 6.3. Online only, saying so offline.

**Accepts when:** each section saves and reads back; changing the name changes it wherever the person is shown.

#### 📋 2.7 — Profiles

**Goal:** Waymark's own copy of name and email. **Design:** §6.1. **Depends on:** 2.1, 3.1.

**Technical:** `profile`, made in the same transaction as the account (better-auth's user-creation hook, after the policy), name and email sealed (3.1);
kept in step from Settings; one visibility function for email (`src/access/visibility.ts`), used by every read that returns a profile; names never read
from the auth store.

**Accepts when:** a new account has exactly one profile; a raw read shows no name or email in plain text; email is returned only to whom §6.1 allows.
