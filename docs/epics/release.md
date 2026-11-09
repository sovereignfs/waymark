# Epic 16: Release

## Status

📋 Planned.

## Overview

What each phase needs before it is published: a seed to develop and demonstrate with, documents, a written security review, the release itself, and
hosting on the live instance. Releases as Tusk's (`scripts/release.sh`, a `vX.Y.Z` tag publishes the image); a patch has no migration.

## Related

[`DESIGN.md`](../../DESIGN.md) §2, §25 · Tusk's `RELEASING.md`

## Tasks

#### 📋 16.1 — Development seed

**Goal:** `pnpm seed`. **Design:** §25 Testing. **Depends on:** 5.3, 4.1.

**Technical:** accounts; a decade of check-ins across countries and zones with photos (generated images, nothing fetched); places visited many times;
grows with phase 2 (a trip of each status relative to today, with a journal, attachments, a Tally link, members in each role, a pending invitation) and
phase 3 (an ongoing trip with timed fixed and flexible items today); refuses to run against anything but a development database.

**Accepts when:** the seed runs on each database form and every screen of the phase has something to show.

#### 📋 16.2 — Security review, phase 1

**Goal:** a written review before 0.1.0. **Design:** §25 Security. **Depends on:** 8.3, 15.2, 14.1.

**Technical:** written up in `docs/security/0.1.0.md`: access (§5.2), sealing (§18), files and uploads (§18.3), the server's outbound requests (place
search, tiles, import photos), the CSP and no third-party request from the browser, sign-in and core's notices, deletion; each finding fixed or recorded
with why.

**Accepts when:** the review is merged and every finding is fixed or recorded.

#### 📋 16.3 — Documents

**Goal:** what an operator and a person need. **Design:** §25 Deployment. **Depends on:** 1.10, 4.3.

**Technical:** the README (running alone with each database form and `/data`, hosting with `sv app add waymark`, every setting, the map's sources and
attribution, where to get a PMTiles file, the place search and what leaves the server, what encryption at rest does and does not protect, backups of
`/data` with the database), `RELEASING.md` copied from Tusk, and a short user guide (checking in, offline, importing).

**Accepts when:** someone new runs Waymark alone from the README alone.

#### 📋 16.4 — Release 0.1.0

**Goal:** phase 1 published. **Design:** §2. **Depends on:** 16.2, 16.3.

**Technical:** `scripts/release.sh` copied from Tusk; `CHANGELOG.md`'s 0.1.0; the tag publishes amd64 and arm64 to `ghcr.io/sovereignfs/waymark`, attested,
booted; the package made public.

**Accepts when:** `ghcr.io/sovereignfs/waymark:0.1.0` is published and boots from `deploy/`.

#### 📋 16.5 — Hosting on an instance

**Goal:** Waymark on the live instance. **Design:** §19.4, §25 Deployment. **Depends on:** 16.4.

**Technical:** `./sv app add waymark --image ghcr.io/sovereignfs/waymark:0.1.0` in `openfs-suite`, the three app scopes granted, the map source and SMTP set in
`suite.yml`, `./sv push && ./sv deploy`; checked by signing in through core, checking in, importing a small export.

**Accepts when:** Waymark answers at its subdomain on the live instance and a person signed in through core can check in.

#### 📋 16.6 — Security review and release 0.2.0

**Goal:** phase 2 published. **Design:** §2, §25 Security. **Depends on:** 11.8, 15.3, 14.2.

**Technical:** the review of 16.2 for phase 2 (`docs/security/0.2.0.md`): roles in every statement and in sync, sharing (§11.3), invitations, attachments
for Followers, auto-link across members; then the release and `./sv app update waymark` on the live instance, with `./sv backup` first (it has migrations).

**Accepts when:** the review is merged, 0.2.0 is published and the live instance runs it.

#### 📋 16.7 — Security review and release 0.3.0

**Goal:** phase 3 published. **Design:** §2, §25 Security. **Depends on:** 13.3, 13.4, 13.5.

**Technical:** the review for phase 3 (`docs/security/0.3.0.md`): Web Push payloads and keys, reminders' access, the worker's tile cache; then the release
and the live instance's update, with a backup first.

**Accepts when:** the review is merged, 0.3.0 is published and the live instance runs it.
