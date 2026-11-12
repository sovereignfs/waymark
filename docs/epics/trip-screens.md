# Epic 11: Trip screens

## Status

⏳ In progress: 11.1 is done.

## Overview

Phase 2's interface: the trips list and the trip page the plugin deferred, designed now, with its views (Overview, Plan, Map, Journal, Files, People). The
plugin's Planner is the trip's Plan view. Everything paints from the device's trip streams (6.6).

## Related

[`DESIGN.md`](../../DESIGN.md) §10, §11, §13, §20.9, §20.10

## Tasks

#### ✅ 11.1 — Trips

**Goal:** `/trips` and the sidebar's Trips. **Design:** §20.9, §20.2. **Depends on:** 9.4, 6.6, 7.1.

**Technical:** status chips and search; groups by status in §20.9's order; cards with dot, name, dates, days, stops in order, status, initials, and the
action by status; _New trip_ dialog (name, colour, optionally the first stop); the sidebar's Trips section shown (ongoing, upcoming, planning, the latest
three completed); the timeline's trip filter and dot.

**Accepts when:** a seeded trip of each status shows in the right group with the right action, and a new trip appears in the sidebar at once.

**Done as:** **`/trips` is one page drawn from the device** (`TripsView`, `app/(app)/trips/page.tsx`): it reads the trips the store holds (`LocalContext.trips`, new, from `LocalStore.trips()`), so it opens with no network, and is also a screen of the offline shell (`/trips` in `src/sw/addresses.ts`, `OfflineApp`). **`src/screens/trips.ts`, pure and tested:** a card per trip with its **status worked out on the device** by 9.4's `statusOf`, **in the first stop's zone**, with the device's clock (re-read each minute, `useTrips.ts`), because the status the server last said can be a day old (a trip that begins in Auckland begins at Auckland's midnight, tested for Auckland and Lisbon at the same instant); the dates, the days, the stops in order, the members for their initials, and **one action by status and role** (_Open journal_ when completed, _Open Trip Mode_ when ongoing for an Organizer or Traveler who is going, _Continue planning_ when planning for an editor, else _View plan_; a Follower, and a member who is not going, never get Trip Mode); the groups in §20.9's order (ongoing, upcoming by date, planning by latest change, completed newest first, the same whatever order the rows are held in); the chips with their counts; the search over the name and the stops (every word, any order, no case or accents); the sidebar's list (ongoing, upcoming, planning and the latest three completed); and the dot's token for each colour, which a test holds to the design system's own tokens. **The chip, the search and the open dialog are in the address** (`?status=`, `?q=`, `?new=1`), so a link to _New trip_ is a link and a reload keeps them. **_New trip_** (`NewTripDialog`): a name, a colour from the six roles, and optionally the first stop found by the place search; **an online operation** (`trip.create`, then `stop.add`), then `syncNow()`, so the card and the sidebar show it at once; with no connection it says in a sentence that a trip is made on the server, and a first stop that fails leaves the trip made and says so. A place search that is off, not answering or offline says so in the dialog and does not hide the name and colour. **The sidebar's Trips section** (`AppSidebar`, in the drawer too): full, each trip with its dot, name and status, then _All trips_ and _New trip_; **as a rail, each trip is its dot with the name as its label and tooltip**, and one icon for the list. **`/t/<id>` exists as a placeholder** (`TripPlaceholder`: the trip's name, status and dates from the device, or "This trip is not here" for one it does not hold) so the links go somewhere until 11.2. **The timeline's trip filter and dot** (`?trip=<id>`, a _Trip_ select once the device holds a trip, a dot with the trip's name on a check-in linked to one; `parseFilters` accepts only a trip id). Both routes are in `src/access/routes.ts`.
**Seen:** 14 unit tests for the model (above) and one for the timeline filter (and the hostile queries); the status in two zones, the action by role, the groups, the chips and the sidebar's three completed each failed when the rule was taken out (the first stop's zone, and "an editor" for Trip Mode, were broken in turn and seen to fail); **in Chromium (`e2e/trips.spec.ts`):** a trip of each status (made through the operations, with dates around today) is in its own group with the right action and address, the groups are in order, a chip narrows to its status and is in the address, a search narrows by name and says when nothing matches, a trip made in the dialog with a first stop is in the list and the sidebar at once, and the sidebar links go to the list and the dialog (full on Home, as dots on any other page). The unit suite passed on a `file:` database, sqld and PostgreSQL; the whole Chromium suite passed (95). **Found on the way, and fixed:** five browser specs still posted `protocol: 1` to `/api/sync` (6.6 made it 2) and the export spec expected format version 1 (15.3 made it 2), so seventeen of them had been failing unseen; and the push test's `json()` returned a rejected promise where the browser's throws, which left an unhandled rejection that made `pnpm test` exit with an error. **Left out:** the trip page itself (11.2); the timeline's trip dot has no browser test (it needs a check-in linked to a trip, which waits for auto-link to be reached from a screen); the phone's footer still names Map and Places (7.7 settles it); WebKit was not run.

#### 📋 11.2 — A trip and its overview

**Goal:** `/t/<id>` and its header and Overview. **Design:** §20.10, §13. **Depends on:** 11.1, 17.4.

**Technical:** the header (dot, name, dates, status, initials, the reader's role, Mark ready and Back to planning for Organizers, Open Trip Mode when
ongoing with 13.2, the menu with rename, colour, delete); views as tabs in `?view=`; Overview: the stops in order (`StepStrip`) on a small map, the trip's
figures, the next thing for the reader, links (Tally first), the Traveler's sharing choice.

**Accepts when:** each role sees the header's actions its role allows and no others, and switching views keeps the address and the back button right.

#### 📋 11.3 — The plan

**Goal:** the Plan view, the plugin's Planner remade. **Design:** §20.10, §10.3–§10.5. **Depends on:** 11.2, 9.3, 17.7.

**Technical:** stops across the top (reorder, re-date with 17.7, _Add a stop_ through the place search, remove); the selected stop's days below, columns
wide and sections narrow, each with title, notes and items; drag within and between days (`@dnd-kit`, with keyboard moves); an item beside the plan or in a
sheet (place or title, kind, times, fixed disabled until a time, notes, its day); shrinking a stop over items opens the move-or-delete dialog; read-only
for Followers; the clock mark on unsynced items.

**Accepts when:** a trip is planned from nothing with the keyboard only; an item edited offline syncs; a Follower can change nothing.

#### 📋 11.4 — The trip's map

**Goal:** the Map view. **Design:** §8.2, §20.10. **Depends on:** 11.2, 17.1.

**Technical:** stops joined in order, a day picker showing that day's items numbered, shared check-ins as their own markers; a list of the same beside it;
_Plan_ and _Map_ side by side wide (`SplitPane`).

**Accepts when:** choosing a day shows its items in plan order, and the list matches the markers.

#### 📋 11.5 — Planned versus actual

**Goal:** the Journal view. **Design:** §13. **Depends on:** 11.2, 10.3.

**Technical:** `src/journal/`, pure: done, skipped, found on the way, untimed and placeless items as planned, using 4.1's match rule over the check-ins the
reader may see; each day as a sentence and a list in time order with who checked in and their photos; the trip's figures for Overview.

**Accepts when:** a hand-worked trip gives the expected done, skipped and found counts per day, and a reader never sees an unshared check-in of another.

#### 📋 11.6 — Files and links

**Goal:** the Files view and editing links. **Design:** §10.6, §10.7, §20.10. **Depends on:** 11.2, 9.5, 9.6.

**Technical:** attachments by day and kind, upload with `FileDropzone`, open (download, or a PDF inline), rename, move, delete; the view hidden from
Followers; links edited from Overview, with _Expenses in Tally_ offered first.

**Accepts when:** an attachment uploaded by a Traveler opens for an Organizer, and the Files view does not exist for a Follower.

#### 📋 11.7 — People

**Goal:** the People view. **Design:** §11, §20.10. **Depends on:** 11.2, 10.2, 10.4.

**Technical:** members by role with names (emails for Organizers), going, pending invitations with resend and revoke; _Invite_ (name, email or link, with a
role; `QrCode` for the link); role changes and removal for Organizers; _Leave_ for everyone, with the last Organizer's hand-over.

**Accepts when:** an invitation made here is accepted in a second browser, and the new member appears with their role.

#### 📋 11.8 — The phone, for trips

**Goal:** phase 2 at a phone's width. **Design:** §20.12. **Depends on:** 11.3–11.7.

**Technical:** Trips in `MobileFooter`; the trip's views as tabs; an item, a stop and an invitation as drawers or pages with back links; the plan as one
day at a time with the stops above.

**Accepts when:** every phase 2 journey passes in Playwright at a phone's width in WebKit.
