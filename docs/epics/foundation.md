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

#### 📋 1.3 — Continuous integration

**Goal:** CI that runs what a change can affect. **Design:** §25. **Depends on:** 1.2.

**Technical:** Tusk's `ci.yml` and its change classifier, copied; legs for format, lint, types, unit tests; the database legs join with 1.5, the image
with 1.10, the browser with 1.9. Skipped on drafts and `skip-ci`. No leg reaches the internet: place search and tiles are faked (4.2, 4.3).

**Accepts when:** a PR runs only the legs its files affect, and a failing leg fails the PR.

#### 📋 1.4 — Configuration and start-up

**Goal:** settings declared once and checked before anything is served. **Design:** §19.1, §25 Deployment. **Depends on:** 1.2.

**Technical:** `@sovereignfs/config` with prefix `WAYMARK`: `URL`, `AUTH_SECRET`, `AUTH_LOCAL`, `AUTH_SIGNUP` (`open`, `closed`; `invite` joins with 10.2
once 17.2 is released), `AUTH_PASSWORD_MIN_LENGTH`, `CORE_*`, `DB_*`, `SMTP_*`, `ENCRYPTION_KEY(_PREVIOUS)`, `WORKER`; Waymark's own are declared by the
tasks that use them (4.2, 4.3, 3.2, 12.4). `_FILE` forms for secrets; `instrumentation.ts` hands to `instrumentation-node.ts`, which checks and stops on a
wrong setting; `.env.example` held to the declarations by a test; `/api/health`. Copied: Tusk's `src/config/`, instrumentation.

**Accepts when:** a missing or malformed setting stops start-up with every problem named and no value printed; `.env.example` matches the code.

#### 📋 1.5 — The database layer

**Goal:** three forms, two dialects, migrations at start-up. **Design:** §24.1, §24.2. **Depends on:** 1.4.

**Technical:** copy Tusk's `src/db/` (config, clients, provision, migrate, boot with retries and `DB_CONNECT_TIMEOUT_MS`, `exec.ts`, the column
vocabulary, `test-support.ts` reading `WAYMARK_TEST_*`); add a `sealed` column type (a binary envelope, `blob` and `bytea`); the two stores `waymark` and
`waymark_auth`; `pnpm db:generate`, `pnpm db:dev`; the parity test; CI legs on sqld, a file and PostgreSQL.

**Accepts when:** an empty database of each form is provisioned and migrated at start-up, twice safely; CI fails if generating would write anything.

#### 📋 1.6 — The job runner

**Goal:** background work in the web process, safe across processes. **Design:** §5. **Depends on:** 1.5.

**Technical:** copy Tusk's `src/jobs/` (runner, `claim.ts`, `index.ts`) and `job_claim`; `WAYMARK_WORKER=off`; stopped on SIGTERM, letting a running import
step finish or record its cursor (8.1).

**Accepts when:** a job's work is done once when two processes run it; SIGTERM stops the runner and the server cleanly.

#### 📋 1.7 — Security headers

**Goal:** the CSP and headers every response has. **Design:** §25 Security. **Depends on:** 1.4.

**Technical:** copy Tusk's `proxy.ts` and `src/security/` (nonce CSP, `connect-src 'self'`, no `'unsafe-inline'`, HSTS over https, Edge discipline);
`img-src 'self' blob: data:` for photos taken offline; `worker-src` as 17.1 settles for MapLibre. A helper for the server's outbound requests (allowed
hosts, timeouts, size caps, no redirect elsewhere, no private address), used by 4.2, 4.3, 8.2 and 12.4.

**Accepts when:** every response, including errors and redirects, carries the policy; a test fails if `'unsafe-inline'` appears in `script-src`; the
outbound helper refuses a private address and a redirect to another host.

#### 📋 1.8 — Design system boundary and shell

**Goal:** `@sovereignfs/ui` wired in, with the app's frame. **Design:** §20.1, §20.2. **Depends on:** 1.2.

**Technical:** tokens and Hanken Grotesk served by the app; `src/theme/` sets `data-theme` before paint; `AppShell` with the header (wordmark, a place for
the bell, the avatar menu) and the sidebar's frame (_Check in_, Home, Check-ins, Map, Places; the Trips section hidden until phase 2), full or a rail,
remembered on the device; `MobileFooter` at a phone's width; the app's CSS check (only `--sv-*` colours); Waymark's mark in `public/icons/`; not-found and
error pages. The places are filled by epic 7.

**Accepts when:** the shell renders in light and dark at desktop and phone widths, with no literal colour anywhere.

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
