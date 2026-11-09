# Epic 11: Trip screens

## Status

📋 Planned.

## Overview

Phase 2's interface: the trips list and the trip page the plugin deferred, designed now, with its views (Overview, Plan, Map, Journal, Files, People). The
plugin's Planner is the trip's Plan view. Everything paints from the device's trip streams (6.6).

## Related

[`DESIGN.md`](../../DESIGN.md) §10, §11, §13, §20.9, §20.10

## Tasks

#### 📋 11.1 — Trips

**Goal:** `/trips` and the sidebar's Trips. **Design:** §20.9, §20.2. **Depends on:** 9.4, 6.6, 7.1.

**Technical:** status chips and search; groups by status in §20.9's order; cards with dot, name, dates, days, stops in order, status, initials, and the
action by status; _New trip_ dialog (name, colour, optionally the first stop); the sidebar's Trips section shown (ongoing, upcoming, planning, the latest
three completed); the timeline's trip filter and dot.

**Accepts when:** a seeded trip of each status shows in the right group with the right action, and a new trip appears in the sidebar at once.

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
