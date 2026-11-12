# Epic 17: Upstream, in `sovereign`

## Status

📋 Planned.

## Overview

What Waymark needs from `sovereignfs/sovereign` before it can use it: parts of the design system it lacks, a value the environment contract does not allow
yet, and its port in the guide. **The work is done in `sovereign`,** as that repository's own tasks, following its `AGENTS.md` (design system first, a
story and a gallery entry per component, a published release). These entries record what Waymark needs, so that a Waymark task can depend on them; each is
marked done when the release that carries it is published. **Where Tally needs the same** (its epic 14), one build serves both, and whichever app's task
starts first does it.

## Related

[`DESIGN.md`](../../DESIGN.md) §6.2, §8.2, §20.11, §27 · `docs/specs/design-system.md` and `contracts/env.md` in `sovereign` · Tally's
`docs/epics/upstream.md`

## Tasks

#### ✅ 17.1 — `Map`

**Goal:** a map component in `@sovereignfs/ui`. **Design:** §8.2, §20.11. **Depends on:** nothing here.

**What Waymark needs:** MapLibre GL JS (BSD-3) wrapped in the suite's style: given a style URL the app serves, markers in token colours with an accessible
label, clusters, a line through points, fit to points, pick a point (by pointer and keyboard), the user's position as a dot, attribution, light and dark by
the style the app passes; MapLibre's worker served without a third-party origin and the CSP it needs (`worker-src`) written in the component's docs; no
request to any URL the app did not give. Possibly its own entry point (`@sovereignfs/ui/map`), so apps without a map do not carry MapLibre: the design
system's call.

**Accepts when:** a `@sovereignfs/ui` release carrying it is published.

**Built in `sovereign`, published in `@sovereignfs/ui` 0.96.1:** `@sovereignfs/ui/map` (`Map`, an entry of its own with `maplibre-gl` an optional peer, 6.17 or later), on the branch `feat/waymark-ui-parts`, in `ui-v0.93.0`. Markers are labelled buttons in token colours and cluster by the screen's pixels; a line; fit to points (at the start and when `fitKey` changes); the person's position; choosing a point by a click or by Enter on the focused map; attribution; light and dark by the style given. **No request to an address the app did not give** (`isAllowedRequest`: the page's origin and the style's, and `allowedOrigins`). The worker is served by the app (`workerUrl`, `worker-src 'self'`); `docs/design-system.md` says what the CSP needs. Tried in Storybook in Chromium (markers, line, cluster); choosing a point and the position dot only against a fake MapLibre. Not tried: dark style, touch, a style with real tiles. **Done when `ui-v0.93.0` is published.**

#### ✅ 17.2 — `AUTH_SIGNUP` by invitation

**Goal:** `invite` as a value of the shared `AUTH_SIGNUP`. **Design:** §6.2. **Depends on:** nothing here.

**What Waymark needs:** the same as Tally's 14.5: `contracts/env.md` to allow `invite` ("the first account, and anyone holding a valid invitation the app
issued"), and `@sovereignfs/config` to accept it. One change serves both apps.

**Accepts when:** the contract change is merged and a `@sovereignfs/config` release accepting it is published.

**Done (merged on `sovereign`'s `main`, 2026-11-12):** `contracts/env.md` allows `AUTH_SIGNUP=invite` ("the first account, and anyone holding a valid invitation the app issued, checked when the account is made"; an app that issues none treats it as `closed`), and `docs/building-an-app.md` says so (`3eb5aee`). **`@sovereignfs/config` needed nothing**: it declares no `AUTH_SIGNUP` of its own; an app declares the variable as a choice (`oneOf`) among the modes it supports, so it "accepts" `invite` already, and there is no release of it to wait for. The rest is Waymark's own and belongs to 10.2: accept `invite` in `src/auth/config.ts` (today `open` or `closed`) and check an invitation token when an account is made, which can be done now that the contract says it (the sign-up hook is Waymark's).

#### ✅ 17.3 — Waymark's port in the guide

**Goal:** port 3005 recorded. **Design:** §27. **Depends on:** nothing here.

**What Waymark needs:** building-an-app §2's ports table to list Waymark's 3005, beside Ledger's 3003 and Tally's 3004.

**Accepts when:** the change is merged in `sovereign`.

**Built in `sovereign`, published in `@sovereignfs/ui` 0.96.1:** the guide's ports table lists every app's port, Waymark's 3005 included (Ledger 3003, Tally 3004, Wallet 3006 and Shopper 3007 beside it, as their manifests say). **Done when it is merged.**

#### ✅ 17.4 — `AvatarStack`

**Goal:** overlapping avatars with "+N". **Design:** §20.4, §20.9. **Depends on:** nothing here.

**What Waymark needs:** the same as Tally's 14.2: initials in a row, overlapping, a count beyond a limit, an accessible label naming everyone.

**Accepts when:** a `@sovereignfs/ui` release carrying it is published.

**Built in `sovereign`, published in `@sovereignfs/ui` 0.96.1:** `AvatarStack` (`people`, `max`, `size`, `label`), in `ui-v0.93.0`: overlapping in a ring of the surface, "+N" beyond the limit (never for one more), one image to assistive technology named for everyone. **Done when `ui-v0.93.0` is published.**

#### ✅ 17.5 — A floating action button

**Goal:** the phone's _Check in_. **Design:** §20.12. **Depends on:** nothing here.

**What Waymark needs:** the same as Tally's 14.3: a floating button above `MobileFooter`, respecting the safe area, with an icon and an accessible label.

**Accepts when:** a `@sovereignfs/ui` release carrying it is published.

**Built in `sovereign`, published in `@sovereignfs/ui` 0.96.1:** `FloatingActionButton` (`label`, `icon`, `extended`, `href`), in `ui-v0.93.0`: fixed above `MobileFooter` through `--sv-shell-footer-height`, clear of the safe area, a link with an `href`. **Done when `ui-v0.93.0` is published.**

#### ✅ 17.6 — A photo viewer

**Goal:** photos shown well. **Design:** §20.6, §20.11. **Depends on:** nothing here.

**What Waymark needs:** a grid of thumbnails that opens a full-screen viewer: swipe and arrow keys between photos, pinch and double-tap zoom, close with
`Esc` or a swipe down, a caption slot, focus kept and returned, images from URLs the app gives (including `blob:`).

**Accepts when:** a `@sovereignfs/ui` release carrying it is published.

**Built in `sovereign`, published in `@sovereignfs/ui` 0.96.1:** `PhotoGrid`, `PhotoViewer` and `PhotoGallery`, in `ui-v0.93.0`: a modal dialog on the overlay hooks (focus kept and returned, scroll locked, `Esc`), swipe and arrow keys, pinch, double tap and wheel zoom around the point, drag to pan, swipe down to close, a caption slot, only the addresses it is given (`blob:` included). Tried in Storybook in Chromium (open, arrow key, wheel zoom, `Esc`, focus returned); **touch gestures were not tried on a device**. **Done when `ui-v0.93.0` is published.**

#### ✅ 17.7 — A date range picker

**Goal:** a stop's arrival and departure in one control. **Design:** §10.3, §20.11. **Depends on:** nothing here.

**What Waymark needs:** **first, whether `DatePicker` or `Calendar` can already pick a range;** if so, this task is superseded. Otherwise a range picker:
two dates, the nights between shown, dates outside a given range disabled, keyboard reachable, `YYYY-MM-DD` in and out.

**Accepts when:** a `@sovereignfs/ui` release carrying it is published, or the check shows it exists.

**Checked:** `Calendar` and `DatePicker` pick one date and say so ("date-only, no range"), so this task stood. **Built and published (`sovereign` `ccf932d`; released as `@sovereignfs/ui` 0.96.1, tag `ui-v0.96.1`, 2026-11-12):** `DateRangePicker` and `RangeCalendar`: `YYYY-MM-DD` in and out (never through a zone), the nights between said in the trigger and a status line, days outside `min` and `max` disabled, the first pick starting a range and the second completing it (the earlier is the start; one day twice is a day with no nights), the days between shaded as focus or the pointer moves, `Escape` dropping a range being chosen, the grid's keyboard and ring, a popover on desktop and a bottom sheet on mobile. 14 new tests; the design system audit and token check pass. **Released:** `0.96.0` was tagged first and its CI failed on two things that were not the picker's (a Docker test that expected `/data/s3` to hold only the app's folder, and an acceptance locator that the launcher's "Add an app" tile made ambiguous); both were fixed in `sovereign` and `0.96.1` carries everything since `0.92.0`: `Map` (`@sovereignfs/ui/map`), `AvatarStack`, `FloatingActionButton`, the photo viewer and gallery, `DateRangePicker` and `RangeCalendar`. Waymark is on `0.96.1` and its whole suite passes on it.
