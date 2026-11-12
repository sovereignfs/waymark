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

#### 📋 17.1 — `Map`

**Goal:** a map component in `@sovereignfs/ui`. **Design:** §8.2, §20.11. **Depends on:** nothing here.

**What Waymark needs:** MapLibre GL JS (BSD-3) wrapped in the suite's style: given a style URL the app serves, markers in token colours with an accessible
label, clusters, a line through points, fit to points, pick a point (by pointer and keyboard), the user's position as a dot, attribution, light and dark by
the style the app passes; MapLibre's worker served without a third-party origin and the CSP it needs (`worker-src`) written in the component's docs; no
request to any URL the app did not give. Possibly its own entry point (`@sovereignfs/ui/map`), so apps without a map do not carry MapLibre: the design
system's call.

**Accepts when:** a `@sovereignfs/ui` release carrying it is published.

**Built in `sovereign`, not yet published:** `@sovereignfs/ui/map` (`Map`, an entry of its own with `maplibre-gl` an optional peer, 6.17 or later), on the branch `feat/waymark-ui-parts`, in `ui-v0.93.0`. Markers are labelled buttons in token colours and cluster by the screen's pixels; a line; fit to points (at the start and when `fitKey` changes); the person's position; choosing a point by a click or by Enter on the focused map; attribution; light and dark by the style given. **No request to an address the app did not give** (`isAllowedRequest`: the page's origin and the style's, and `allowedOrigins`). The worker is served by the app (`workerUrl`, `worker-src 'self'`); `docs/design-system.md` says what the CSP needs. Tried in Storybook in Chromium (markers, line, cluster); choosing a point and the position dot only against a fake MapLibre. Not tried: dark style, touch, a style with real tiles. **Done when `ui-v0.93.0` is published.**

#### 📋 17.2 — `AUTH_SIGNUP` by invitation

**Goal:** `invite` as a value of the shared `AUTH_SIGNUP`. **Design:** §6.2. **Depends on:** nothing here.

**What Waymark needs:** the same as Tally's 14.5: `contracts/env.md` to allow `invite` ("the first account, and anyone holding a valid invitation the app
issued"), and `@sovereignfs/config` to accept it. One change serves both apps.

**Accepts when:** the contract change is merged and a `@sovereignfs/config` release accepting it is published.

**Not started** (phase 2; it changes the contract and `@sovereignfs/config`, and Tally's 14.5 is the same change).

#### 📋 17.3 — Waymark's port in the guide

**Goal:** port 3005 recorded. **Design:** §27. **Depends on:** nothing here.

**What Waymark needs:** building-an-app §2's ports table to list Waymark's 3005, beside Ledger's 3003 and Tally's 3004.

**Accepts when:** the change is merged in `sovereign`.

**Built in `sovereign`, not yet published:** the guide's ports table lists every app's port, Waymark's 3005 included (Ledger 3003, Tally 3004, Wallet 3006 and Shopper 3007 beside it, as their manifests say). **Done when it is merged.**

#### 📋 17.4 — `AvatarStack`

**Goal:** overlapping avatars with "+N". **Design:** §20.4, §20.9. **Depends on:** nothing here.

**What Waymark needs:** the same as Tally's 14.2: initials in a row, overlapping, a count beyond a limit, an accessible label naming everyone.

**Accepts when:** a `@sovereignfs/ui` release carrying it is published.

**Built in `sovereign`, not yet published:** `AvatarStack` (`people`, `max`, `size`, `label`), in `ui-v0.93.0`: overlapping in a ring of the surface, "+N" beyond the limit (never for one more), one image to assistive technology named for everyone. **Done when `ui-v0.93.0` is published.**

#### 📋 17.5 — A floating action button

**Goal:** the phone's _Check in_. **Design:** §20.12. **Depends on:** nothing here.

**What Waymark needs:** the same as Tally's 14.3: a floating button above `MobileFooter`, respecting the safe area, with an icon and an accessible label.

**Accepts when:** a `@sovereignfs/ui` release carrying it is published.

**Built in `sovereign`, not yet published:** `FloatingActionButton` (`label`, `icon`, `extended`, `href`), in `ui-v0.93.0`: fixed above `MobileFooter` through `--sv-shell-footer-height`, clear of the safe area, a link with an `href`. **Done when `ui-v0.93.0` is published.**

#### 📋 17.6 — A photo viewer

**Goal:** photos shown well. **Design:** §20.6, §20.11. **Depends on:** nothing here.

**What Waymark needs:** a grid of thumbnails that opens a full-screen viewer: swipe and arrow keys between photos, pinch and double-tap zoom, close with
`Esc` or a swipe down, a caption slot, focus kept and returned, images from URLs the app gives (including `blob:`).

**Accepts when:** a `@sovereignfs/ui` release carrying it is published.

**Built in `sovereign`, not yet published:** `PhotoGrid`, `PhotoViewer` and `PhotoGallery`, in `ui-v0.93.0`: a modal dialog on the overlay hooks (focus kept and returned, scroll locked, `Esc`), swipe and arrow keys, pinch, double tap and wheel zoom around the point, drag to pan, swipe down to close, a caption slot, only the addresses it is given (`blob:` included). Tried in Storybook in Chromium (open, arrow key, wheel zoom, `Esc`, focus returned); **touch gestures were not tried on a device**. **Done when `ui-v0.93.0` is published.**

#### 📋 17.7 — A date range picker

**Goal:** a stop's arrival and departure in one control. **Design:** §10.3, §20.11. **Depends on:** nothing here.

**What Waymark needs:** **first, whether `DatePicker` or `Calendar` can already pick a range;** if so, this task is superseded. Otherwise a range picker:
two dates, the nights between shown, dates outside a given range disabled, keyboard reachable, `YYYY-MM-DD` in and out.

**Accepts when:** a `@sovereignfs/ui` release carrying it is published, or the check shows it exists.

**Checked:** `Calendar` and `DatePicker` pick one date and say so ("date-only, no range"), so this task stands. Not started.
