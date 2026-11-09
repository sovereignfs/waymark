# Epic 1: Foundation

## Status

📋 Planned.

## Overview

The repository that can hold Waymark as `DESIGN.md` designs it: a Next.js app that runs alone or hosted, on three forms of database, with files under
`/data`. Nothing a person would notice. **Tusk is the model throughout, and its infrastructure is copied** (`DESIGN.md` §5.1), renamed to `WAYMARK_`, and
trimmed of what Waymark does not use (workspaces, the cipher, backup to git). Where Tally or Ledger already trimmed a file the same way, its copy may be the
starting point, and the task says so. Each task says which files it copied.

## Related

[`DESIGN.md`](../../DESIGN.md) §5, §20.1, §20.12, §24, §25 · Tusk's and Tally's `docs/epics/foundation.md`

## Tasks

#### ✅ 1.1 — Repository conventions

**Goal:** the files a repository of the suite is expected to have. **Design:** §25, `AGENTS.md`. **Depends on:** nothing.

**Technical:** `LICENSE` (AGPL-3.0-or-later), `CHANGELOG.md` with `[Unreleased]`, `CONTRIBUTING.md`, `README.md`, PR template, Dependabot,
`.editorconfig`, `.node-version`; `package.json` (`@sovereignfs/waymark`, `type: module`, engines `>=24.15 <25`, pnpm 11 with `minimumReleaseAge` and
`allowBuilds`); Next.js 16 (latest stable), React 19, TypeScript strict with `noUncheckedIndexedAccess`; `@sovereignfs/ui`, `sdk`, `config`, `manifest`
pinned exactly at Tusk's versions.

**Accepts when:** a clean checkout installs with `pnpm install --frozen-lockfile`, `pnpm typecheck` passes, and `git status` is clean after.

**Done as:** `LICENSE`, `.editorconfig`, `.node-version`, `.prettierignore`, `.github/dependabot.yml`, `tsconfig.json` and `pnpm-workspace.yaml` copied from
Tusk unchanged (the `esbuild: false` entry in `allowBuilds` waits for `drizzle-kit`, 1.5); `.gitignore` is Tusk's; the pull request template is Tusk's with
the convergence line reworded (Waymark's sync has no convergence suite of its own); `CONTRIBUTING.md` is Tusk's renamed, its branching paragraph saying the
owner may use the bypass, and its browser-test paragraph pointing at 1.9. `package.json` is `@sovereignfs/waymark` with `dev` and `start` on port 3005, the
four `@sovereignfs` packages at Tusk's versions (`ui` 0.92.0, `sdk` 2.1.0, `config` 0.1.0, `manifest` ^0.1.0), Next 16.4, React 19.3 and TypeScript 6.0 (other
dependencies join with the task that uses them). `app/layout.tsx` and `app/page.tsx` are a placeholder so that `next typegen` and `tsc` have something to
check; the shell replaces them (1.8). Left out: `README.md` says nothing of settings yet (1.4 adds them).

#### ✅ 1.2 — Format, lint and test tooling

**Goal:** the checks every later task runs. **Design:** §25 Testing. **Depends on:** 1.1.

**Technical:** Prettier and ESLint as Tusk's (copied configs); Vitest with the design system inlined and files run one after another, and
`fake-indexeddb` for the device's store (6.2); scripts `format`, `format:check`, `lint`, `typecheck` (`next typegen && tsc --noEmit`), `test`; one real
test.

**Accepts when:** each check passes, and each is seen to fail on a planted fault.

**Done as:** `prettier.config.ts`, `eslint.config.ts` (without Tusk's `tools/` ignore, which waits for the operator tools), `vitest.config.ts` and
`types/eslint-plugin-jsx-a11y.d.ts` copied from Tusk; Tusk's `vitest.setup.ts` is not copied (it configures Tusk's operator key; sealing's setup arrives with
3.1). `fake-indexeddb` is installed for 6.2. The one real test (`src/smoke.test.ts`) reads `package.json` and `src/site.ts`; it reads the manifest instead
once 1.10 exists. Seen to fail: a badly formatted file (`format:check`), an `any` and an unused variable (`lint`), a `string` assigned to a `number`
(`typecheck`), and a test expecting `1` to be `2` (`test`); each planted file was removed.

#### ✅ 1.3 — Continuous integration

**Goal:** CI that runs what a change can affect. **Design:** §25. **Depends on:** 1.2.

**Technical:** Tusk's `ci.yml` and its change classifier, copied; legs for format, lint, types, unit tests; the database legs join with 1.5, the image
with 1.10, the browser with 1.9. Skipped on drafts and `skip-ci`. No leg reaches the internet: place search and tiles are faked (4.2, 4.3).

**Accepts when:** a PR runs only the legs its files affect, and a failing leg fails the PR.

**Done as:** `scripts/ci-changes.sh` and `scripts/test-ci-changes.sh` copied from Tusk (40 cases pass; the cases' example paths renamed to Waymark's), and
`.github/workflows/ci.yml` copied from Tusk and trimmed to the legs that can exist now: `what changed`, `format, lint, type-check, test and build`, and
`shell scripts` (shellcheck and the classifier's tests). The pinned actions, the draft and `skip-ci` guard, the weekly schedule and the pinned database
images are Tusk's. The manifest check, the migrations check and the database legs (1.5), the browser legs (1.9), the image leg and the release script's tests
(1.10) are added with their tasks; the workflow says so. Checked with `actionlint` and `shellcheck`. Not exercised: a run on GitHub, which waits for a push.

#### ✅ 1.4 — Configuration and start-up

**Goal:** settings declared once and checked before anything is served. **Design:** §19.1, §25 Deployment. **Depends on:** 1.2.

**Technical:** `@sovereignfs/config` with prefix `WAYMARK`: `URL`, `AUTH_SECRET`, `AUTH_LOCAL`, `AUTH_SIGNUP` (`open`, `closed`; `invite` joins with 10.2
once 17.2 is released), `AUTH_PASSWORD_MIN_LENGTH`, `CORE_*`, `DB_*`, `SMTP_*`, `ENCRYPTION_KEY(_PREVIOUS)`, `WORKER`; Waymark's own are declared by the
tasks that use them (4.2, 4.3, 3.2, 12.4). `_FILE` forms for secrets; `instrumentation.ts` hands to `instrumentation-node.ts`, which checks and stops on a
wrong setting; `.env.example` held to the declarations by a test; `/api/health`. Copied: Tusk's `src/config/`, instrumentation.

**Accepts when:** a missing or malformed setting stops start-up with every problem named and no value printed; `.env.example` matches the code.

**Done as:** copied from Tusk and renamed to `WAYMARK_`: `src/config/` (`env.ts`, `current.ts`, `edge.ts`, `index.ts`, and the two tests, `process-env.test.ts`
holding `.env.example` to the code and `process.env` to `src/config`), `src/auth/config.ts`, `src/mail/config.ts` and the `Mail` types, `src/crypto/keys.ts`,
`src/db/config.ts` and its test (the settings of the database belong to `loadConfig`; the clients and migrations are 1.5), `instrumentation.ts` and
`instrumentation-node.ts`. Trimmed: the GitHub, Web Push and operator-encryption settings and the Tusk-only `_FILE` list. Changed in behaviour: **the instance
key is required** (Tusk's is optional), because everything Waymark stores about where and what is sealed with it (§18.1), so a start with none stops;
`WAYMARK_AUTH_SIGNUP` accepts `open` and `closed` only (`invite` joins with 10.2); the phase-1 scopes are `openid`, `profile`, `email`. New tests for sign-in
(`src/auth/config.test.ts`) and mail (`src/mail/config.test.ts`). `next.config.ts` is Tusk's without its header list (1.7). `/api/health` answers for the process
alone until 1.5 gives it the database and `/data`. Seen to work on the built server: a wrong address, worker and a missing key stop it with all three named and
no value printed, and a good key starts it and answers `/api/health`. Left out: `README.md`'s table of settings, which 16.3 writes.

#### ✅ 1.5 — The database layer

**Goal:** three forms, two dialects, migrations at start-up. **Design:** §24.1, §24.2. **Depends on:** 1.4.

**Technical:** copy Tusk's `src/db/` (config, clients, provision, migrate, boot with retries and `DB_CONNECT_TIMEOUT_MS`, `exec.ts`, the column
vocabulary, `test-support.ts` reading `WAYMARK_TEST_*`); add a `sealed` column type (a binary envelope, `blob` and `bytea`); the two stores `waymark` and
`waymark_auth`; `pnpm db:generate`, `pnpm db:dev`; the parity test; CI legs on sqld, a file and PostgreSQL.

**Accepts when:** an empty database of each form is provisioned and migrated at start-up, twice safely; CI fails if generating would write anything.

**Done as:** copied from Tusk and renamed (`waymark`, `waymark_auth`, `WAYMARK_`): `src/db/` (`config` was 1.4's, with `boot`, `client`, `exec`, `migrate`,
`provision`, `retry`, `sqld`, `test-support` and their tests, including the parity and vocabulary tests), `src/limits/rate.ts` with its test (its table is the
app store's first), the four `drizzle.*.config.ts`, `scripts/db-generate.mjs`, `scripts/dev-db.mjs`, `scripts/boot-check.mjs` and `scripts/lib/standalone.mjs`.
**Added:** the `sealed` word in both column vocabularies (`blob` in buffer mode on SQLite, `bytea` on PostgreSQL), tested to keep every byte value and to read
back through raw SQL; a `makeStore()` in `src/db/test-support.ts` (Tusk has it in its sync tests). **The stores:** the app store holds `rate_bucket` and nothing
else yet (a task adds its tables with its migration); the auth store holds better-auth's seven tables, Tusk's `auth.ts` schema, which has the foreign keys
inside that store that better-auth's cascade deletes need (the rule against foreign keys is the app store's). Migrations `0000_init` for each of the four
(`pnpm db:generate init`); generating again writes nothing. **Changed:** the dev containers listen on 38080, 38081 and 35432, because Tusk's and Ledger's
sit on 28080, 28081 and 25432 on a machine that runs the suite. `/api/health` and `instrumentation-node.ts` now open the database and stop the server if it
cannot; the health answer does not yet say that `/data` is writable, which joins with the first thing stored there (3.2), where the directory's setting is
settled. **Seen:** the full suite passes on a `file:` database, on sqld (v0.24.33) and on PostgreSQL 16 (133 pass, 4 skipped by leg); the built server booted
from empty on each form and, on the file, a second time over the first; a planted column wrote a migration that the CI step's `git status` check catches.
CI: the `tests` job has a leg for each form (start the service, boot the built server from empty, run the suite), and the `check` job runs the migrations
check. Not exercised: those jobs on GitHub.

#### 📋 1.6 — The job runner

**Goal:** background work in the web process, safe across processes. **Design:** §5. **Depends on:** 1.5.

**Technical:** copy Tusk's `src/jobs/` (runner, `claim.ts`, `index.ts`) and `job_claim`; `WAYMARK_WORKER=off`; stopped on SIGTERM, letting a running import
step finish or record its cursor (8.1).

**Accepts when:** a job's work is done once when two processes run it; SIGTERM stops the runner and the server cleanly.

#### ✅ 1.7 — Security headers

**Goal:** the CSP and headers every response has. **Design:** §25 Security. **Depends on:** 1.4.

**Technical:** copy Tusk's `proxy.ts` and `src/security/` (nonce CSP, `connect-src 'self'`, no `'unsafe-inline'`, HSTS over https, Edge discipline);
`img-src 'self' blob: data:` for photos taken offline; `worker-src` as 17.1 settles for MapLibre. A helper for the server's outbound requests (allowed
hosts, timeouts, size caps, no redirect elsewhere, no private address), used by 4.2, 4.3, 8.2 and 12.4.

**Accepts when:** every response, including errors and redirects, carries the policy; a test fails if `'unsafe-inline'` appears in `script-src`; the
outbound helper refuses a private address and a redirect to another host.

**Done as:** `src/security/csp.ts` and its test copied from Tusk, and `proxy.ts` and its test rewritten from Tusk's: the nonce, the policy for a page, none for
`/api/`, HSTS over https, the same matcher less Tusk's `api/import`; its sign-in and Home rewrites join with 2.1 and 2.2. **Changed from Tusk:**
`worker-src 'self' blob:` (the design's, for MapLibre; 17.1 narrows it to `'self'` if the design system can serve the worker as a file) and
`Permissions-Policy: geolocation=(self)`, since checking in here asks where the device is (Tusk has `geolocation=()`). `img-src 'self' data: blob:` is Tusk's
already. **The outbound helper is new** (Tusk has none; `src/security/outbound.ts`): `outbound(url, { allow, … })` takes host rules (`host`, or `*.suffix` for
the names under it and never the bare domain; `allowPrivate` and `allowHttp` for the operator's own host, never for a name from a person or a file),
connects to the address its own checked lookup returned (so a rebinding name reaches nothing), follows a redirect only to a host in the list and checks it
again, sends the caller's headers to no other host, caps the answer's size and the whole exchange's time, and fails with an `OutboundError` whose message
holds a kind and no address or query (a search is a place). 38 tests against fake hosts on this machine; the private-address checks and the header stripping
were seen to fail with the code switched off (the latter by a patch that did not apply the first time). **Seen** on the built server: a page, `/api/health`
and a 404 each carry the headers, and the pages the policy with a nonce. Left out: the `/api/map` and `/api/places` allowances, which their tasks add as
configured hosts; this task did it before 1.8 because the layout's theme script needs the nonce.

#### ✅ 1.8 — Design system boundary and shell

**Goal:** `@sovereignfs/ui` wired in, with the app's frame. **Design:** §20.1, §20.2. **Depends on:** 1.2.

**Technical:** tokens and Hanken Grotesk served by the app; `src/theme/` sets `data-theme` before paint; `AppShell` with the header (wordmark, a place for
the bell, the avatar menu) and the sidebar's frame (_Check in_, Home, Check-ins, Map, Places; the Trips section hidden until phase 2), full or a rail,
remembered on the device; `MobileFooter` at a phone's width; the app's CSS check (only `--sv-*` colours); Waymark's mark in `public/icons/`; not-found and
error pages. The places are filled by epic 7.

**Accepts when:** the shell renders in light and dark at desktop and phone widths, with no literal colour anywhere.

**Done as:** copied from Tusk and renamed: `src/theme/` (key `waymark.theme`), `src/ui/` (`AppShell.module.css`, `SidebarToggle`, `mobile-nav`, `sidebar`, `useSidebar`,
`design-tokens` and its test, `contrast`, and the `no-fork` and `sidebar` tests), `src/screens/AppFrame` and `AppSidebar.module.css`, `app/globals.css`, `app/error.tsx`.
Written for Waymark: `AppShell` (wordmark _waymark._, slots for the toggle, the bell, the account menu and the footer), `WaymarkMark` and the icons (a pin with its dot cut
out; `icon.svg` the dark tile, the PNGs made from it with `qlmanage` and `sips`, the maskable and Apple icons full-bleed), `src/screens/places.ts` (Home, Check-ins, Map, Places),
`AppSidebar` (the places, full or a rail, and the same places as a drawer on a phone), `PhoneFooter` (the design system's `MobileFooter`: Home and Check-ins, the launcher
opening the drawer, Map and Places), `SignedInArea`, the root layout (tokens, the nonce'd theme script, `ToastProvider`) and `app/(app)/` with a placeholder for each place.
**Decisions:** _Check in_ and the Trips section are not in the sidebar yet, because a control with nothing behind it is worse than none (`AGENTS.md`'s own rule for the
sidebar): 7.2 adds the first, 11.1 the second. The footer's right side is Map and Places for now, since Trips is phase 2 and `MobileFooter` wants as many icons on each
side; 7.7 settles it (Check in as a floating button, Places into the avatar menu). The `(app)` layout does not check a session until 2.1. `@dnd-kit/core` and `sortable` are
installed because `@sovereignfs/ui` needs them as peers (the build fails without). **Seen** on the built server: the shell at desktop width in light (Home with the sidebar full)
and dark (a page with the rail), and at 375px in dark with the footer and its drawer, with no console error (so the nonce'd theme script runs under the policy); the CSS
check fails on a planted literal colour. Not done here: the avatar menu and the bell (2.7, 12.1), the offline shell (6.4).

#### 📋 1.9 — Browser tests

**Goal:** Playwright on the built app. **Design:** §25 Testing. **Depends on:** 1.5.

**Technical:** Tusk's Playwright setup copied: Chromium and WebKit, the database form from the environment, shards in CI; helpers for a second browser
context, for going offline (`context.setOffline`), for a mocked position (`geolocation` permission and coordinates) and a mocked clock; a check that the
page made no request off its origin.

**Accepts when:** a smoke test opens the built app on each database form in CI, and the origin check fails on a planted third-party request.

#### 📋 1.10 — The image and deployment setups

**Goal:** one image, three Compose setups. **Design:** §19.3, §25 Deployment. **Depends on:** 1.5, 1.6.

**Technical:** `sovereign.manifest.json` (§19.3, phase 1's scopes) with `pnpm manifest:check` and a test holding it to the code (port 3005 everywhere);
Tusk's Dockerfile (Debian, `USER node`, `ARG PORT`, migrations beside the server, licences) built with `sovereign-manifest docker-args`; `/data` made in
the image and writable by `node`, declared in `data`; `sharp`'s native build allowed in `allowBuilds`; `deploy/` for sqld, a file and PostgreSQL, each with
a `/data` volume; `scripts/deploy-check.sh`; `publish.yml` on a `vX.Y.Z` tag.

**Accepts when:** `scripts/deploy-check.sh` boots every setup from nothing and as an instance would host it, answering `/api/health` with `200`.

#### 📋 1.11 — The PWA

**Goal:** installable, with a service worker that keeps the shell only. **Design:** §20.12. **Depends on:** 1.8.

**Technical:** copy Tusk's `src/sw/` and `app/manifest.ts` (name Waymark, icons with a maskable one, `display: standalone`); an allow-list of build files and
icons; the public shell page holding nothing of a person; an offline page for every other address. Answering signed-in addresses offline is 6.4; a trip's
tiles are 13.5.

**Accepts when:** the app installs in Chromium; a test of the worker's source shows it caches nothing outside the allow-list.
