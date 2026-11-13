# Epic 16: Release

## Status

📋 Planned.

## Overview

What each phase needs before it is published: a seed to develop and demonstrate with, documents, a written security review, the release itself, and
hosting on the live instance. Releases as Tusk's (`scripts/release.sh`, a `vX.Y.Z` tag publishes the image); a patch has no migration.

## Related

[`DESIGN.md`](../../DESIGN.md) §2, §25 · Tusk's `RELEASING.md`

## Tasks

#### ✅ 16.1 — Development seed

**Goal:** `pnpm seed`. **Design:** §25 Testing. **Depends on:** 5.3, 4.1.

**Technical:** accounts; a decade of check-ins across countries and zones with photos (generated images, nothing fetched); places visited many times;
grows with phase 2 (a trip of each status relative to today, with a journal, attachments, a Tally link, members in each role, a pending invitation) and
phase 3 (an ongoing trip with timed fixed and flexible items today); refuses to run against anything but a development database.

**Accepts when:** the seed runs on each database form and every screen of the phase has something to show.

**Done as:** **`pnpm seed`** (`scripts/seed.mjs`, which loads `.env` as `pnpm dev` does and runs `src/seed/main.ts` through jiti, since the sources use extensionless imports). It is made of the app's own parts: **accounts are signed up through better-auth** (so each has a sealed profile, by the server's own hook) and **places, check-ins and photos go in through the one write path**, by the import job's `applyBatch`, with the media store storing the photos before the check-in that names them. **Three accounts** with one shared development password (in `src/seed/run.ts`, and printed by the seed): Ada, with a decade (about 3,800 check-ins at 68 places, 284 photos), Grace, with a quiet year, and Nell, with nothing, for the empty screens. **The check-ins** (`src/seed/checkins.ts`, pure and with no randomness of its own: a small generator started from each day's date) are a life in two cities (Berlin, then Lisbon from a fixed date) with the places of a week, **the first of each base visited hundreds of times** and others once or twice, and three trips away a year of three to nine days in 14 cities of 12 countries and 12 zones, several check-ins a day, with notes, companions and a photo on one in five. **A photo is generated, never fetched** (`src/seed/images.ts`: a JPEG drawn from the photo's key, so the store's own checks and re-encoding run). **Running it again makes nothing twice, on the same day or another:** a check-in's id is made from the account, the date and its place in the day, and an account is found by its address. **It refuses anything but a development database** (`src/seed/guard.ts`): not with `NODE_ENV=production`; a file not under `/data`, or an sqld or PostgreSQL service not on this machine; a `WAYMARK_URL` not on this machine; a data directory of `/data`. It names the setting and never its value. **Seen:** the generator (determinism, ten years, every row accepted by the write path's own rules, countries and zones, places of many visits, stable across days), the guard, and the seed on a `file:` database, sqld and PostgreSQL (16 tests each: accounts that sign in with the password, a profile each, rows only their owner's, photos as files, a second run on the same day and the next making nothing); and by hand: `pnpm seed` on a scratch database took 18 seconds and a second run made nothing, then Check-ins and Places in Chromium as Ada showed 3,798 check-ins and the places by visits (459 at the most visited). **Left out:** Home and Map are still placeholders (they wait on epic 17), so the seed does not yet fill them; trips of each status, a journal, attachments, a Tally link, members in each role and a pending invitation join with phase 2, and an ongoing trip with timed items today with phase 3, as the task says. It was not run against the e2e instances: the browser tests make their own accounts.

#### ⏳ 16.2 — Security review, phase 1

**Goal:** a written review before 0.1.0. **Design:** §25 Security. **Depends on:** 8.3, 15.2, 14.1.

**Technical:** written up in `docs/security/0.1.0.md`: access (§5.2), sealing (§18), files and uploads (§18.3), the server's outbound requests (place
search, tiles, import photos), the CSP and no third-party request from the browser, sign-in and core's notices, deletion; each finding fixed or recorded
with why.

**Accepts when:** the review is merged and every finding is fixed or recorded.

**Done so far:** `docs/security/0.1.0.md`, a review of access, sealing, files, outbound requests, the CSP, sign-in and core's notices, deletion and the worker, each rule with where it is held (the code and the test that fails when it stops being true) and each finding fixed or recorded with its cost. **Two defects were found and fixed:** `worker-src` was `'self' blob:` because MapLibre made its worker from a blob, and is now `'self'` alone (the worker is a file of the app's own, `workerUrl`; `csp.test.ts` holds it, the map screens pass in both browsers under it); and **a map's chunk that could not be fetched replaced the whole screen with the error page** (`src/screens/loadMap.ts` now draws nothing in its place and leaves the list; found by `checkin.spec.ts` failing offline in a full run, with and without the CSP change). **Not covered:** the Swarm import's photos and screen (8.2 and 8.3, which wait on a real export), so the import's host allow-list (`*.4sqi.net`, `*.foursquare.com`) has never been reached and its first real use is reviewed when it is, and a pass on a live instance (16.5). The task stays ⏳ until the review is amended for 8.3.

#### ⏳ 16.3 — Documents

**Goal:** what an operator and a person need. **Design:** §25 Deployment. **Depends on:** 1.10, 4.3.

**Technical:** the README (running alone with each database form and `/data`, hosting with `sv app add waymark`, every setting, the map's sources and
attribution, where to get a PMTiles file, the place search and what leaves the server, what encryption at rest does and does not protect, backups of
`/data` with the database), `RELEASING.md` copied from Tusk, and a short user guide (checking in, offline, importing).

**Accepts when:** someone new runs Waymark alone from the README alone.

**Done so far:** `RELEASING.md`, copied from Tusk's with the name changed; the README's sections (running alone with each form of the database and `/data`, hosting with `sv app add`, every setting by group, what leaves the server, what encryption at rest does and does not protect, backups, and the map, which was already there); and a short user guide, `docs/user-guide.md` (checking in, offline, importing). **Not done:** nobody new has followed the README from nothing (`scripts/deploy-check.sh` checks the setups it describes, not its words), the user guide describes what is built (the Swarm import, 8.3, is not), and it must be read again when the screens that wait on `@sovereignfs/ui` 0.93.0 are built.

#### ⏳ 16.4 — Release 0.1.0

**Goal:** phase 1 published. **Design:** §2. **Depends on:** 16.2, 16.3.

**Technical:** `scripts/release.sh` copied from Tusk; `CHANGELOG.md`'s 0.1.0; the tag publishes amd64 and arm64 to `ghcr.io/sovereignfs/waymark`, attested,
booted; the package made public.

**Accepts when:** `ghcr.io/sovereignfs/waymark:0.1.0` is published and boots from `deploy/`.

**Done so far:** `scripts/release.sh`, `scripts/lib/release.sh`, `scripts/release/waymark.sh` and `scripts/test-release.sh` copied from Tusk's (the name, the `WAYMARK_RELEASE_GATES` variable and the repository's address changed; behaviour is the same), the changelog's `[Unreleased]` link the script moves, and CI running shellcheck and `scripts/test-release.sh` when `scripts/` changes (71 tests pass, shellcheck clean). `publish.yml` was already Tusk's with the name changed. **Not done:** 0.1.0 itself, which waits on 16.2, 16.3 and the screens that wait on `@sovereignfs/ui` 0.93.0 (17.1, 17.4 to 17.6, built in `sovereign` and not yet published).

#### 📋 16.5 — Hosting on an instance

**Goal:** Waymark on the live instance. **Design:** §19.4, §25 Deployment. **Depends on:** 16.4.

**Technical:** `./sv app add waymark --image ghcr.io/sovereignfs/waymark:0.1.0` in `openfs-suite`, the three app scopes granted, the map source and SMTP set in
`suite.yml`, `./sv push && ./sv deploy`; checked by signing in through core, checking in, importing a small export.

**Accepts when:** Waymark answers at its subdomain on the live instance and a person signed in through core can check in.

#### ⏳ 16.6 — Security review and release 0.2.0

**Goal:** phase 2 published. **Design:** §2, §25 Security. **Depends on:** 11.8, 15.3, 14.2.

**Technical:** the review of 16.2 for phase 2 (`docs/security/0.2.0.md`): roles in every statement and in sync, sharing (§11.3), invitations, attachments
for Followers, auto-link across members; then the release and `./sv app update waymark` on the live instance, with `./sv backup` first (it has migrations).

**Accepts when:** the review is merged, 0.2.0 is published and the live instance runs it.

**Done so far:** `docs/security/0.2.0.md`: roles in every statement (one fragment and three sets of roles; each operation called as each lower role), the stream and the device, sharing (§11.3), invitations (a token that is 32 random bytes kept as its hash, the same page for every link that cannot be used), attachments that Followers never receive (list, file, thumbnail and the stream), auto-link, and trips in export, import and deletion. No code change was needed; the findings are recorded with their costs, among them that an unaccepted invitation link can make more than one account. **Core's directory (14.2) was added to it (§8):** the refresh token kept sealed and moved out of the sign-in store, a rotation never lost, an invitation by `sub` looked up again by the server and taken at sign-in by the `sub` and nothing else; four findings recorded, one a decision to flag (a person with no account is put in the trip at their first sign-in through core). The sqld and PostgreSQL legs of the data-layer tests were run for it. **Not done:** the live instance's update (with `./sv backup`), the scopes granted in the Console, and the release itself, which are 16.5's and the developer's.

#### ⏳ 16.7 — Security review and release 0.3.0

**Goal:** phase 3 published. **Design:** §2, §25 Security. **Depends on:** 13.3, 13.4, 13.5.

**Technical:** the review for phase 3 (`docs/security/0.3.0.md`): Web Push payloads and keys, reminders' access, the worker's tile cache; then the release
and the live instance's update, with a backup first.

**Accepts when:** the review is merged, 0.3.0 is published and the live instance runs it.

**Done so far:** `docs/security/0.3.0.md`: Web Push (a payload that is a kind and a path and nothing else, encrypted to the device; a subscription held to a browser's own push service twice, when it is made and when it is sent to; sealed; the key derived from a secret that is never logged), reminders (who is reminded, once, with two workers), a trip's map kept on the device (an anchored allow-list, a bounded message API, a bound on tiles, forgotten at sign-out) and Directions. **Not done:** a push received from a real push service in a real browser (12.4's open note), Directions on an iPhone, the update of a live instance and the release.
