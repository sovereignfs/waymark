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

#### ✅ 2.2 — Landing page and the address `/`

**Goal:** what a visitor sees, and Home for a signed-in person. **Design:** §20.3, §20.4. **Depends on:** 2.1.

**Technical:** `/` renders a short landing page (what Waymark is, sign in, sign up when allowed) for a visitor and Home (7.6) when signed in; nothing personal
in the landing page's HTML; the shell page for the worker is separate (1.11).

**Accepts when:** a visitor and a signed-in person get the right page from `/`, and the visitor's page carries no data of anyone.

**Done as:** `src/landing/` (Tusk's `Landing` and its stylesheet, with Waymark's words in `content.ts`: what is so today, and nothing of trips or sharing until phase 2; its test fails if a word of
a later phase or an address is in it), `app/page.tsx` for a visitor (a server component with no script: the sign-in link only where sign-in is set up, the sign-up link only where the server would take
one), `app/(app)/home/page.tsx` for Home (a placeholder until 7.6). **The proxy** shows Home at `/` to anyone with a session cookie (a rewrite, the address stays `/`, marked so that it does not loop) and
sends `/home` to `/` with a 308; only the cookie is looked at, and the layout checks the session, so a forged cookie is sent to sign in. `src/access/routes.ts`: `/` public, `/home` an account's. Proxy tests: the
rewrite and the mark, the policy on a rewritten page, the redirect, the sign-in pages absent with local sign-in off and Sovereign's one page kept. **Seen** in both browsers: a visitor gets the landing page
(heading, Sign in link, no sign-up link once the instance has its first account, none of the account's address in the HTML) and the app's pages send them to sign in; a signed-in person gets Home at `/`
and `/home` goes there; signing out returns to the landing page; with no way of signing in the front address says so and everything else is a 404.

#### ✅ 2.3 — Sign-in through core

**Goal:** a Sovereign core as a way in. **Design:** §19.1, §19.2, §19.4. **Depends on:** 2.1, 2.7.

**Technical:** copy Tusk's `genericOAuth` provider with PKCE, on when `WAYMARK_CORE_*` are set; an account for anyone core signs in, whatever
`AUTH_SIGNUP` says; its profile made from core's name and email, not overwritten after; no implicit linking (a core login whose email is a local account's
is refused until linked from a signed-in session with the same address); the fake Sovereign for tests, copied. Scopes `openid profile email` in phase 1.

**Accepts when:** against the fake Sovereign, signing in makes an account and profile, a second sign-in finds it by `sub`, and an email match alone
links nothing.

**Done as:** copied from Tusk and renamed, as 2.1 left out: the `genericOAuth` provider in `src/auth/auth.ts` (discovery from `WAYMARK_CORE_URL`, **PKCE S256, the client secret by basic authentication, `requireIdTokenVerification`** so that a discovery document with no signing keys is not a reason to trust whatever the token endpoint says, `disableProviderLogout` so that signing out of Waymark does not sign the person out of core, scopes `openid profile email` from `SOVEREIGN_SCOPES`, a missing name falling back to the part of the address before the `@`), **`trustedProviders: ['sovereign']`** for linking (core's contract is that `email` is verified) with implicit linking still off, the fake Sovereign (`src/auth/testing/fake-sovereign.ts`, strict as core is: the exact redirect, PKCE checked, a code good once, an EdDSA ID token) with the **recorded discovery fixture** and its test (`src/auth/fixtures/`, `scripts/record-sovereign-discovery.mjs`), `src/sovereign/identity.ts` (`accountOfSub`, `subOfAccount`, `endSessionsOf`, which 2.4 uses), `SovereignPanel` in Settings > Sign-in (link, unlink, what came back), and `signInsOf` telling which row is linked. **`jose` is a dev dependency now** (6.2.16, exact, already in the store as better-auth's; the fake signs with it). **Changed from Tusk, as the task says:** an account is made for **anyone a core signs in, whatever `WAYMARK_AUTH_SIGNUP` says** (the sign-up policy hook lets the Sovereign provider's callback through; `closed` is about who may make a local account, and a core decides for itself who may sign in to it), and Tusk's "first account only" test is replaced by one that signs three people in on a closed instance and then sees a local sign-up refused by the server. **Its profile is made from core's name and address when the account is made** (`onAccountCreated`, 2.7) **and not overwritten after** (tested: the person changes their name, core later says another, the profile is the person's). **The sign-in page offers Sovereign** when a core is set up (2.1 had trimmed it to `false`); with core as the only way in, the local pages are not found. **Seen** in the auth suite on a `file:` database, sqld and PostgreSQL (88 tests each): signing in makes an account (its `sub`, address and name), a second sign-in finds it by `sub` even when the address has changed at core, an ID token signed by another key, meant for another client or with no nonce leaves no account, a declined login returns to the sign-in page with a reason, a callback is good once, signing out is local, an address that matches a local account links nothing and is refused with what to do, linking from a signed-in session works only with the same address (any case) and only for an identity nobody else has linked, unlinking is refused for the only way in and asks for a fresh session, two-factor is not asked of a core login, a core that cannot be reached starts anyway; **in Chromium (`e2e/sovereign.spec.ts`, two instances of their own and a fake core run by `e2e/fake-sovereign-server.ts`):** core only (the local pages are not found; a person signs in with the name core gives and finds it in Settings; a second person is let in on an instance whose sign-up is closed; declining is explained; an account with no password has none to manage and cannot unlink its only way in) and both ways (a password and Sovereign each sign in; a core login with a local account's address is refused; a local account links Sovereign from Settings and then signs in with it as the same account, with its own name; a different address is refused with the reason and nothing is linked; unlinking works and the same login is then refused again). Each safeguard was taken out in turn and seen to fail its test (the sign-up bypass, the trusted provider). **A port the browser refuses:** the first choice for the fake core, 4190, is on the Fetch standard's list of ports a `fetch` will not use (Node says "bad port"), so every instance skipped the provider; the ports are 4192 and 4193, and `e2e/ports.ts` says why. **Left out:** `profile.core_sub` stays empty (the link is the sign-in store's `account` row, which `subOfAccount` reads; the column is for 14.x if it is needed), the back-channel logout and account-deleted notices (2.4), and `offline_access` and `directory` (phase 2, 10.2 and 14.2). WebKit was not run.

#### 📋 2.4 — Core's notices

**Goal:** back-channel logout and account deleted. **Design:** §19.2. **Depends on:** 2.3, 2.5.

**Technical:** copy Tusk's routes at `/api/sovereign/backchannel-logout` and `/api/sovereign/account-deleted`, verified by the SDK's
`verifyLogoutToken` and `verifyAccountDeletedToken`, replays refused through `notice_seen`, a bounded form, one rate limit, 404 where core is not set;
account deleted runs `People.deletePerson` and answers `200` only once rows and files are gone.

**Accepts when:** against `createFakeCore`, logout ends every session of the person, account deleted removes them, and a replayed notice is refused after
a restart.

#### ✅ 2.5 — Deleting a person

**Goal:** one routine that removes everything of an account. **Design:** §23. **Depends on:** 2.7, 3.2.

**Technical:** `People.deletePerson` in `src/sovereign/people.ts`, as Tusk's: safe to run twice, the `sub` link last; phase 1's tables (profile, places,
check-ins, photos, media and their files through 3.2's delete, import jobs, settings, notices, preferences, mail queued to them, credential, rate
counters, better-auth's rows); the trip rules (handing over, deleting an empty trip, clearing `created_by`) join with 10.4. Reached from Settings > Data
after the password or a fresh session, with what goes said; the device's database deleted.

**Accepts when:** a test seeding one row of every table for the person and a second person finds nothing of the first afterwards, files included, and
the second's rows intact; a new table fails the test until it is handled.

**Done as:** `src/sovereign/people.ts` written from Tusk's shape for Waymark's phase-1 tables: **1.** the account's files, the files first and then their rows (`deleteMediaOf`, so that a run that stops between the two
leaves the rows that name the files still to go), **2.** in one transaction of the app store their profile and their rate counters, **3.** the sign-in store: sessions, sign-ins, second factors, passkeys, verifications named
by their address, and the account last. Safe to run twice. `src/sovereign/delete-account.ts` and `app/api/account/delete/route.ts` (copied from Tusk and trimmed): the preview (does it ask for a password, and how many files and
bytes go; places, check-ins and trips join as those tables do) and the deletion with the password, **counted** (5 in 10 minutes), or for an account with no password a session made in the last ten minutes; the account is the session's and
no other, `Origin` is checked, the route is in `src/access/routes.ts`. Settings > Data (2.6) is where it is reached. **Tests:** `people.test.ts` asks the schema for its tables and **fails for one that is in none of its three lists**
(seen with a planted table), then seeds a profile, a photo, a rate counter and sign-in rows for two people, deletes one twice, and finds nothing of them, files on disk included, and the other whole; a run cut off after one file
is finished by the next; `delete-account.test.ts` over HTTP: signed-in and from the app, wrong or absent password deletes nothing, the limit, the right password deletes the session's account and not another's and ends the session,
the no-password path; 459 tests pass on a `file:` database, sqld and PostgreSQL (and the profile deletion's removal fails the seeding test). Left out: the device's database being deleted (6.2) and core's `account-deleted`
notice (2.4), which calls this routine; the rules for trips and for later tables join with them (`AGENTS.md`: a new table is handled here in the same change).

#### ✅ 2.6 — Settings

**Goal:** `/settings` with its sections. **Design:** §21. **Depends on:** 2.7, 1.8.

**Technical:** Profile (name, email, units, first day of the week), Sign-in (Tusk's sections, linking core once 2.3 is in), Data (filled by 8.3, 15.1,
15.2, 2.5); Check-ins, Notifications and This device are filled by 10.3, 12.3 and 6.3. Online only, saying so offline.

**Accepts when:** each section saves and reads back; changing the name changes it wherever the person is shown.

**Done as:** `/settings` (`app/(app)/settings/page.tsx`, from the avatar menu's new _Settings_) with `src/settings/`: the shell (Tusk's, with its sections down the left, the ones not shown kept mounted, and the design
system's `OfflineGate` so that with no connection it says it needs one and shows nothing that could be stale), **Profile** (name, units, the first day of the week, saved through `PATCH /api/settings`; the address is shown and
not changed here, since it is the one the person signs in with), **Sign-in** (Tusk's `SecuritySection`, `PasskeysPanel` and `TwoFactorPanel` copied and renamed: password, authenticator app with backup codes, passkeys, devices; `qrcode.react` is
installed for the authenticator's code; linking core waits for 2.3) and **Data** (storage used against the account's limit, and _Delete account_ from 2.5 saying what goes and asking for the password). `src/settings/api.ts`
holds the two handlers (taking their dependencies, so a test calls them as a second person) and `app/api/settings/route.ts` binds them: `GET` and `PATCH` of the session's own profile, a body cut off at 4 KB, only `name`, `units`,
`weekStart` and `shareDefault` accepted, a refusal that says `BAD_REQUEST` and nothing of what was sent; both in `src/access/routes.ts`. **The sections that depend on other tasks are not shown yet** (Check-ins 10.3,
Notifications 12.3, This device 6.3, and Data's import and export 8.3, 15.1, 15.2): an empty section is worse than none. **Seen:** the handlers as the person, as someone else, as a visitor and from another origin (each person
reads and changes only their own; a change as one is not a change to the other); 468 tests on a `file:` database, sqld and PostgreSQL; the whole browser suite, 58 tests in Chromium and WebKit, including opening Settings from the menu, each
section, a saved name and units reading back after a reload and showing in the menu on another page, an invalid name refused, and the offline notice. `src/settings/query.test.ts` holds what an address can ask for. Left out: changing the
sign-in address (better-auth's `changeEmail` and its verification, which is decided apart from the profile's copy) and the check-ins section's `share_default` control, which saves through the same route when 10.3 adds it.

#### ✅ 2.7 — Profiles

**Goal:** Waymark's own copy of name and email. **Design:** §6.1. **Depends on:** 2.1, 3.1.

**Technical:** `profile`, made in the same transaction as the account (better-auth's user-creation hook, after the policy), name and email sealed (3.1);
kept in step from Settings; one visibility function for email (`src/access/visibility.ts`), used by every read that returns a profile; names never read
from the auth store.

**Accepts when:** a new account has exactly one profile; a raw read shows no name or email in plain text; email is returned only to whom §6.1 allows.

**Done as:** the `profile` table of §24.3 in both dialects (`0002_profile`): `account_id` the key, `core_sub`, `units` (`km`, `mi`), `week_start` (0 to 6, Monday by default), `share_default` (`ask`, `on`,
`off`), the sealed envelope of name and email, and the two moments. `src/profile/profile.ts` is the one place that reads or writes it: `createProfile` (idempotent, since the key is the account),
`getProfile`, `ensureProfile`, `updateProfile` (what Settings changes, one account, choices checked, a message that names the problem and not the value) and the cleaning of a name (1 to 100 characters, one
line) and an email (lower case). **Made with the account** from better-auth's `databaseHooks.user.create.after`, after the sign-up policy's `before`, through a new `onAccountCreated` dependency of
`createAuth`; **the two stores cannot share a transaction** (separate files, namespaces and schemas), so it is made idempotently, a failure is logged by kind and does not undo the account, and
`ensureProfile` makes the one an account lacks when the signed-in layout first reads it. **The layout and the avatar menu now take the name and email from the profile**, not the session. `src/access/visibility.ts` is the one
visibility function (`self` and `organizer` see name and email, `member` the name, `none` nothing, which a caller reads as not found); the relations are decided by trips' statements in phase 2 (9.1, 10.1).
`openAppBesideAuth()` joins the test support. **Seen:** a new account has exactly one profile (and two have two), made once whatever is asked again; a raw read of the row holds neither name nor
email and its envelope opens only as that account; Settings' changes change this account's profile and nobody else's; 414 tests pass on a file, sqld and PostgreSQL; the browser shows the name and the lower-case
address in the menu after signing up. **Changed in a shared test:** the schema-parity test reads `bytea` and `blob` as the one `buffer` kind (it first met a sealed column here). Not done: Settings (2.6), where
changing the sign-in address through better-auth (with its verification) is decided apart from the profile's copy, and the sign-in address is not changed by this task.
