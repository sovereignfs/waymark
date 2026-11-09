# Epic 2: Accounts and sign-in

## Status

📋 Planned.

## Overview

Who can sign in, how, and what Roam keeps of them: local accounts and core, from one image; Roam's own profile of name and email; core's two notices; the
one routine that removes everything of a person; the landing page; Settings. Sign-in is copied from Tusk; the profile follows Tally's `person`, without
placeholders.

## Related

[`DESIGN.md`](../../DESIGN.md) §6, §19, §21, §23

## Tasks

#### 📋 2.1 — Local sign-in

**Goal:** local accounts, as Tusk's. **Design:** §19.1, §6.2. **Depends on:** 1.5, 1.8.

**Technical:** copy Tusk's `src/auth/` (better-auth in `roam_auth`, password, passkey, authenticator app with backup codes, the `Auth` screens), on when
`ROAM_AUTH_LOCAL=1`, the sign-in pages 404 otherwise; the sign-up policy hook with `open` and `closed` (`invite` is 10.2); email verification and
password reset only with mail set up (through 12.2 once it is in; until then, Tusk's direct send); rate limits on sign-up and sign-in.

**Accepts when:** the first account can be made and signed in to; with `closed`, a second sign-up is refused; with `AUTH_LOCAL` off, every sign-in page
answers 404.

#### 📋 2.2 — Landing page and the address `/`

**Goal:** what a visitor sees, and Home for a signed-in person. **Design:** §20.3, §20.4. **Depends on:** 2.1.

**Technical:** `/` renders a short landing page (what Roam is, sign in, sign up when allowed) for a visitor and Home (7.6) when signed in; nothing personal
in the landing page's HTML; the shell page for the worker is separate (1.11).

**Accepts when:** a visitor and a signed-in person get the right page from `/`, and the visitor's page carries no data of anyone.

#### 📋 2.3 — Sign-in through core

**Goal:** a Sovereign core as a way in. **Design:** §19.1, §19.2, §19.4. **Depends on:** 2.1, 2.7.

**Technical:** copy Tusk's `genericOAuth` provider with PKCE, on when `ROAM_CORE_*` are set; an account for anyone core signs in, whatever
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

**Goal:** Roam's own copy of name and email. **Design:** §6.1. **Depends on:** 2.1, 3.1.

**Technical:** `profile`, made in the same transaction as the account (better-auth's user-creation hook, after the policy), name and email sealed (3.1);
kept in step from Settings; one visibility function for email (`src/access/visibility.ts`), used by every read that returns a profile; names never read
from the auth store.

**Accepts when:** a new account has exactly one profile; a raw read shows no name or email in plain text; email is returned only to whom §6.1 allows.
