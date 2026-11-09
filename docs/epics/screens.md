# Epic 7: Check-in screens

## Status

📋 Planned.

## Overview

Phase 1's interface, designed anew (`DESIGN.md` §20), painting from the device's store: the shell's places, the check-in sheet, the timeline, the map,
places, Home, and the phone. Every map has a list beside or instead of it.

## Related

[`DESIGN.md`](../../DESIGN.md) §9, §20

## Tasks

#### 📋 7.1 — The shell's places

**Goal:** the sidebar and header working. **Design:** §20.2, §20.3. **Depends on:** 6.2.

**Technical:** _Check in_ opening the sheet over any page (`?checkin=new`); Home, Check-ins, Map, Places as links with the current one marked; the avatar
menu (Settings, Notifications, Import, Sign out, back to core when set, Couldn't sync when non-empty); the bell's place (filled by 12.1); the Trips section
hidden until 11.1; keyboard `C` for check in.

**Accepts when:** every place is reachable with the keyboard, and the sheet opens over any page and closes back to it.

#### 📋 7.2 — Checking in

**Goal:** the check-in sheet. **Design:** §9.2, §20.5. **Depends on:** 7.1, 4.2, 17.1.

**Technical:** `Sheet` wide, `Drawer` narrow, the same content; _Here_ (position asked for when first used, the person's nearest places, then the place
search's nearby, then _New place here_), _Search_, _On the map_ (17.1's point picking); the moment (now, or earlier, with the zone following the place);
note; photos (camera or files, through 6.5); companions (`TagInput`); offline, own places only, a new place by name and position, or a point alone; Enter
to check in; denied location removes _Here_ with a sentence. The trip link and sharing rows appear with 9.7 and 10.3.

**Accepts when:** in a browser with position mocked, each way checks in; with the network off, a check-in by position alone is saved and later named by
reverse lookup; the sheet works with the keyboard only.

#### 📋 7.3 — The timeline and a check-in

**Goal:** `/checkins` and `/c/<id>`. **Design:** §20.6. **Depends on:** 7.2, 17.6.

**Technical:** every check-in, newest first, grouped by day in its own zone, rows as §20.6 (the trip's dot joins with 9.7); filters in the query (year,
category, country, search over names and notes on the device; trip with 9.1); virtualised for ten thousand rows; `SplitPane` wide, a page narrow; a
check-in's page with the photo viewer (17.6), Edit (the sheet filled) and Delete (confirmed, for good).

**Accepts when:** a seeded decade scrolls smoothly, filters agree with counts from 5.4, and edit and delete work offline.

#### 📋 7.4 — The map

**Goal:** `/map`. **Design:** §8.2, §20.7. **Depends on:** 7.3, 4.3, 17.1.

**Technical:** every check-in clustered from the store; the timeline's filters; a selected marker shows the place, times and last visit; the list of what
is in view beside the map wide, and alone when `WAYMARK_MAP_SOURCE` is `off`; the style follows the theme.

**Accepts when:** the map shows a seeded decade without request off the origin, and the list matches the markers in view.

#### 📋 7.5 — Places and a place

**Goal:** `/places` and `/places/<id>`. **Design:** §20.8. **Depends on:** 7.3.

**Technical:** places by visits with a search; a place's page with its small map, "You've been here N times", first and last, its check-ins; rename,
recategorize, move the point, merge, delete with none (4.1's operations, online).

**Accepts when:** merging two places moves their check-ins and the count adds up.

#### 📋 7.6 — Home

**Goal:** Home. **Design:** §20.4. **Depends on:** 7.3, 5.4, 17.4.

**Technical:** _Now_ (the large _Check in_ with the nearest place; the Trip Mode card joins with 13.2), _Next trip_ (with 9.4), _Recently_, figures and a
small map of the year; the new person's two empty states with _Import from Swarm_.

**Accepts when:** Home paints from the store with no spinner after the first load, and a new person sees the empty states.

#### 📋 7.7 — The phone

**Goal:** phase 1 at a phone's width. **Design:** §20.12. **Depends on:** 7.6, 17.5.

**Technical:** `MobileFooter` (Home, Check-ins, launcher, Map, Trips once phase 2), the floating _Check in_ button (17.5), the avatar menu holding Places,
Notifications, Import and Settings; pages and drawers with back links; nothing decided by width but rendering.

**Accepts when:** every phase 1 journey passes in Playwright at a phone's width in WebKit.
