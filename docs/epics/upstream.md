# Epic 17: Upstream, in `sovereign`

## Status

📋 Planned.

## Overview

What Roam needs from `sovereignfs/sovereign` before it can use it: parts of the design system it lacks, a value the environment contract does not allow
yet, and its port in the guide. **The work is done in `sovereign`,** as that repository's own tasks, following its `AGENTS.md` (design system first, a
story and a gallery entry per component, a published release). These entries record what Roam needs, so that a Roam task can depend on them; each is
marked done when the release that carries it is published. **Where Tally needs the same** (its epic 14), one build serves both, and whichever app's task
starts first does it.

## Related

[`DESIGN.md`](../../DESIGN.md) §6.2, §8.2, §20.11, §27 · `docs/specs/design-system.md` and `contracts/env.md` in `sovereign` · Tally's
`docs/epics/upstream.md`

## Tasks

#### 📋 17.1 — `Map`

**Goal:** a map component in `@sovereignfs/ui`. **Design:** §8.2, §20.11. **Depends on:** nothing here.

**What Roam needs:** MapLibre GL JS (BSD-3) wrapped in the suite's style: given a style URL the app serves, markers in token colours with an accessible
label, clusters, a line through points, fit to points, pick a point (by pointer and keyboard), the user's position as a dot, attribution, light and dark by
the style the app passes; MapLibre's worker served without a third-party origin and the CSP it needs (`worker-src`) written in the component's docs; no
request to any URL the app did not give. Possibly its own entry point (`@sovereignfs/ui/map`), so apps without a map do not carry MapLibre: the design
system's call.

**Accepts when:** a `@sovereignfs/ui` release carrying it is published.

#### 📋 17.2 — `AUTH_SIGNUP` by invitation

**Goal:** `invite` as a value of the shared `AUTH_SIGNUP`. **Design:** §6.2. **Depends on:** nothing here.

**What Roam needs:** the same as Tally's 14.5: `contracts/env.md` to allow `invite` ("the first account, and anyone holding a valid invitation the app
issued"), and `@sovereignfs/config` to accept it. One change serves both apps.

**Accepts when:** the contract change is merged and a `@sovereignfs/config` release accepting it is published.

#### 📋 17.3 — Roam's port in the guide

**Goal:** port 3005 recorded. **Design:** §27. **Depends on:** nothing here.

**What Roam needs:** building-an-app §2's ports table to list Roam's 3005, beside Ledger's 3003 and Tally's 3004.

**Accepts when:** the change is merged in `sovereign`.

#### 📋 17.4 — `AvatarStack`

**Goal:** overlapping avatars with "+N". **Design:** §20.4, §20.9. **Depends on:** nothing here.

**What Roam needs:** the same as Tally's 14.2: initials in a row, overlapping, a count beyond a limit, an accessible label naming everyone.

**Accepts when:** a `@sovereignfs/ui` release carrying it is published.

#### 📋 17.5 — A floating action button

**Goal:** the phone's _Check in_. **Design:** §20.12. **Depends on:** nothing here.

**What Roam needs:** the same as Tally's 14.3: a floating button above `MobileFooter`, respecting the safe area, with an icon and an accessible label.

**Accepts when:** a `@sovereignfs/ui` release carrying it is published.

#### 📋 17.6 — A photo viewer

**Goal:** photos shown well. **Design:** §20.6, §20.11. **Depends on:** nothing here.

**What Roam needs:** a grid of thumbnails that opens a full-screen viewer: swipe and arrow keys between photos, pinch and double-tap zoom, close with
`Esc` or a swipe down, a caption slot, focus kept and returned, images from URLs the app gives (including `blob:`).

**Accepts when:** a `@sovereignfs/ui` release carrying it is published.

#### 📋 17.7 — A date range picker

**Goal:** a stop's arrival and departure in one control. **Design:** §10.3, §20.11. **Depends on:** nothing here.

**What Roam needs:** **first, whether `DatePicker` or `Calendar` can already pick a range;** if so, this task is superseded. Otherwise a range picker:
two dates, the nights between shown, dates outside a given range disabled, keyboard reachable, `YYYY-MM-DD` in and out.

**Accepts when:** a `@sovereignfs/ui` release carrying it is published, or the check shows it exists.
