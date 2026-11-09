# AGENTS.md

Guidance for every AI agent working in this repository (Codex reads this file directly; Claude Code loads it through `CLAUDE.md`). It is
the one copy of the conventions. Do not duplicate them elsewhere, and do not add task history or release narrative to it: those belong
in `ROADMAP.md`, the task's epic and the PR body.

This repository follows the conventions of [`sovereignfs/sovereign`](https://github.com/sovereignfs/sovereign) (its `AGENTS.md`,
`docs/building-an-app.md` and `docs/development-workflow.md`), of [`sovereignfs/tusk`](https://github.com/sovereignfs/tusk) (its `AGENTS.md`, the closest
model: an app of its own built from a roadmap) and of `sovereignfs/tally` (whose sync, invitations and notice delivery Roam follows). Where this file is
silent, do what Tusk does; where they differ, this file says which.

## What this is

**Roam**, an app of the Sovereign suite exactly as Tusk, Fjord, Ledger and Tally are: check in where you are, plan trips with the people going and the
people following, and look back on everywhere you have been, on a map. Check-ins stand alone; a trip is a folder they fall into when the dates match. A
Sovereign instance can host it, and **it runs fully on its own, with every feature, needing no instance**: its own accounts, mail, notices, files and map.
It replaces the legacy plugin `sovereignfs/sovereign-plugin-travellog`, whose behaviour is the starting point and none of whose code, data or interface is
carried over. It is a PWA on Next.js, with its own database (sqld, a SQLite file or PostgreSQL) and files under `/data`, signing people in locally,
through a Sovereign core, or both, from one image. Three phases, a release each: check-ins, trips, Trip Mode.

**Nothing is built yet.** `DESIGN.md` is the design, `ROADMAP.md` the order, and Milestone A starts by copying Tusk's infrastructure (`DESIGN.md` §5.1).

## Source of truth

Read the relevant document before a task. Where two disagree, the earlier one wins and the later one is stale and should be fixed:

1. **The contracts Sovereign publishes**, in the `sovereign` repository: `contracts/app-manifest.md`, `contracts/env.md`, `docs/using-the-sdk.md` and
   `docs/specs/sdk.md`, `docs/specs/design-system.md` and `docs/design-system.md`, `docs/connecting-an-app.md`. A gap is raised in `sovereign`, not
   patched here.
2. **`DESIGN.md`**: what Roam is and how it is built, with numbered sections that tasks cite.
3. **`ROADMAP.md`**: the order of work, one row per task, canonical for status.
4. **`docs/epics/`**: each task's detail (goal, "Accepts when", and once done, how it was done and what was left out).

Directories are created when they are needed. Research (`docs/research/`), RFCs (`docs/rfcs/`), ADRs (`docs/adrs/`) and workstreams
(`docs/workstreams/`) are used as Sovereign and Tusk use them. A documented "not now" is a valid outcome.

## Planning workflow

- **The developer assigns the task** at the start of a session. There is no "next task" pointer in any file; read `ROADMAP.md` for the queue and ask
  which to pick up.
- **Task IDs are permanent** (`4.3`): use them in cross-references and dependency lists, never in branch names, commit messages or PR titles.
- **A finished task is marked done in its roadmap row and written up in its epic** (Done as: what, where, what was left out), in the same change as
  the work.
- **Copying from Tusk or Tally is said, not hidden:** a task that copies a file names it in its Done as, and changes in behaviour are stated.
- **Epic 17 is work in `sovereign`;** a Roam task that depends on it waits for the published release. Where Tally needs the same part, one build serves
  both.
- **`DESIGN.md` §28 lists what still waits on an input** (a real Swarm export, the default tile upstream); the task it blocks says so.

## Working conventions

- **One task, one branch, one draft PR.** Branch from an up-to-date `main`, named `feat/<slug>`, `fix/<slug>`, `docs/<slug>` or `chore/<slug>`. Do not
  start a second task on a branch whose PR is not merged.
- **Nothing goes to `main` directly,** except the owner's bypass, which is theirs to use.
- **Never commit or push without being asked.** Prepare changes in the working tree and stop.
- **Commits explain why.** `type(scope): summary` under 72 characters, body wrapped at 100, a `Verified:` line naming what was run, one logical change
  per commit. Every commit an agent makes ends with `Co-Authored-By: Claude Code <noreply@anthropic.com>`: model-agnostic, never a specific model
  name.
- **PRs target `main`, are opened as drafts** (`gh pr create --draft --base main`), and are marked ready only on instruction. The body says what changed
  and why, cites the `DESIGN.md` section, carries no task numbers, and ends with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.
- **Merge with rebase and merge,** never squash and never a merge commit. **Never merge a PR automatically.**
- **Verify before claiming done.** Run the commands under Commands and show the output. A regression test is trusted only after it has been seen to
  fail against the code it guards.
- **Docs are part of the change.** A statement a change makes false is fixed in the same PR; a change to behaviour adds a line under `## [Unreleased]`
  in `CHANGELOG.md`.
- **Releases are their own PR,** as Tusk's: `scripts/release.sh`, a `vX.Y.Z` tag publishes the image. A patch has no migration and no setting change.
- **Flag Docker-config impact immediately:** a new setting, port, path or native dependency (`sharp`, the time-zone table, map fonts) updates the
  `Dockerfile` and `.dockerignore` in the same change.

## Rules of an app

Tusk's rules, as they apply here, and Roam's own. They describe the app as `DESIGN.md` designs it.

- **Every feature works with no Sovereign instance.** Core adds a way in, a directory, a bell and email; a feature that only works with core is not
  done. A call to core that fails, is refused or is not supported changes nothing but that call (`DESIGN.md` §19.4). **Files, the map, place search and
  push are always Roam's own.**
- **An account is known by its better-auth user id (`account_id`).** Names and emails are read from `profile`, never from the auth store or core. A `sub`
  is identity; an email is never matched to an account at sign-in.
- **An email is shown only to whom `DESIGN.md` §6.1 allows,** through the one visibility function, and never in a notice or another person's export.
- **Everything of an account is removed by `People.deletePerson`** (`src/sovereign/people.ts`), files included, safe to run twice. **A new table is
  handled there, and exported and imported, in the same change,** with a test that seeds one of each.
- **Everything that says where or what is sealed** (`DESIGN.md` §18.1): place names, points, addresses, notes, titles, companions, profile names and
  emails, files. Written and read only through `src/crypto/sealed.ts`, declared per table; **no sealed field is ever a column, in a `WHERE`, an `ORDER BY`
  or an index.** Search, distance and figures work in memory on unsealed rows.
- **A person's rows carry `account_id`; a trip's carry `trip_id`; the permission is in the statement:** the owner, or active membership with the role the
  operation needs, as a condition of the same query (`DESIGN.md` §5.2), never checked first and then touched. **A refusal reads as not found.** A route,
  operation or mutation finds the session first, checks `Origin` on a write, is listed in `src/access/routes.ts`, and has a test calling it as a second
  person and, for a trip, as each lower role.
- **A check-in is its author's.** It reaches another person only when shared with a trip they are a member of (`DESIGN.md` §11.3), as a copy in that
  trip's stream. **Followers never receive an attachment,** row or file.
- **Check-ins, items and day notes are written only through the one path:** an action in `src/actions/` makes the mutation, and `src/sync/apply.ts`
  applies it, re-checking ownership or role, in one short transaction that increments the stream's `seq`. A replayed mutation writes nothing. Nothing anyone
  typed is thrown away: a refused change goes to Couldn't sync.
- **Trips, stops, ready, roles, invitations, attachments and links are online operations** (`/api/ops`), decided by the server at once.
- **A pure figure has one implementation:** auto-link (`src/autolink/`), the journal (`src/journal/`), today (`src/today/`), figures (`src/figures/`),
  time zones (`src/places/tz.ts`), "the same place" (`src/places/match.ts`), shared by the device, the server and the tests.
- **A manual trip link is never changed by anything automatic.**
- **The device's store is per account and holds only what the account may see;** it is deleted at sign-out. **The service worker caches the shell and
  a trip's map tiles only,** by allow-list; no page or answer with a person's data is ever in a cache.
- **The browser talks only to its own server.** No third-party load or request: the map's style, tiles, glyphs and sprites come from `/api/map`; place
  search from `/api/places`. What people write is rendered as text, never as HTML.
- **The server's outbound requests go through the one helper:** configured hosts only (place search, tile upstream, push services, SMTP, core) and the
  import's allow-list (`*.4sqi.net`, `*.foursquare.com`); timeouts, size caps, no redirect elsewhere, never a private address.
- **Uploads are judged by their bytes;** images are re-encoded with every piece of metadata removed; files are sealed on disk under `/data/media` and
  served only through `/api/media` after the access check.
- **Notices are raised in the change's transaction, never for the person who acted.** Mail goes through `mail_outbox`; push payloads name no place or
  person.
- **An invitation token is random, stored only as its hash, compared in constant time,** single-use and expiring; every invalid link shows the same
  page.
- **A job claims its work in the database** and is safe to run twice and from two processes; an import resumes from its cursor.
- **Logs hold no place names, points, notes, titles, search text, names or addresses:** an id and a kind of failure.
- **The database has three forms and two dialects:** a schema and migrations per dialect, generated with `pnpm db:generate`, never written by hand or
  `push`ed; standard SQL, values bound; no `LISTEN/NOTIFY`, trigger, extension or foreign key; every deletion names what it deletes, in a transaction;
  short transactions, nothing held across a call to core, SMTP, place search or a tile upstream. A data-layer test runs on sqld, a `file:` database and
  PostgreSQL. **Tests read `ROAM_TEST_*` and never the app's variables, and never reach the internet.**
- **A released migration is never edited:** a fix is a new migration.
- **Secrets never appear in an error, a log, a URL or the browser.** Credentials (core's refresh token, push keys) are stored only through `src/crypto/`.
- **The manifest is the one copy** (`sovereign.manifest.json`) of what an instance reads. `pnpm manifest:check` passes, and the image is built with
  `pnpm exec sovereign-manifest docker-args`. The port is 3005 everywhere.
- **Environment variables carry the prefix `ROAM_`,** declared once through `@sovereignfs/config`; every one is in `.env.example`; the server refuses to
  start on a wrong setting; no secret has a default; never `NEXT_PUBLIC_*` for a value that varies at run time.
- **The design system is imported from `@sovereignfs/ui` directly,** pinned exactly; style with `--sv-*` tokens only, the map's style included; Hanken
  Grotesk served by the app. **Reusable UI is built in `@sovereignfs/ui` in `sovereign`, released, then used** (epic 17), never forked here.
- **Never fork a navigation decision by viewport;** fork only what is rendered. Every map has a list of the same.
- **No reward mechanics:** no points, badges, streaks, mayorships or leaderboards.
- **User-facing words are "check in", "check-in", "place", "trip", "stop", "day", "plan", "Organizer", "Traveler", "Follower", "share with the trip",
  "app"** (`DESIGN.md` §4), never "visit", "plugin", "tenant", "geocode", "POI" or "client".
- **Next.js tracks the latest stable release.** Read the guide bundled with the installed version (`node_modules/next/dist/docs/`) before writing
  Next code.
- **TypeScript is strict.** No `any` without a comment; prefix an intentionally unused identifier with `_`; never disable a lint rule inline without a
  comment.

## pnpm

As Tusk's: `pnpm install --frozen-lockfile` for every routine install; `pnpm-workspace.yaml` carries pnpm's settings and the Dockerfile copies it;
pnpm refuses a release less than a day old and an install script nobody decided on (`sharp`'s is decided, in `allowBuilds`); an exception in
`minimumReleaseAgeExclude` only for a package of ours, exact-pinned. Never accept pnpm's offer to add one.

## Commands

None exist yet. Milestone A brings Tusk's set (`format`, `lint`, `typecheck`, `test`, `db:generate`, `db:dev`, `seed`, `boot-check`, `e2e`,
`manifest:check`, `build`, `scripts/deploy-check.sh`), and this list is where they are written as they land. Until then, `verify` means the Markdown is
formatted and every relative link resolves.

## Layout

`DESIGN.md` §5.1 is where things go as the app is built. Today the repository holds only `DESIGN.md`, `ROADMAP.md`, `docs/epics/` and this file.
