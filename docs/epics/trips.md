# Epic 9: Trips

## Status

📋 Planned.

## Overview

Phase 2's data: trips of stops, days and items, with trip places, attachments and links; planning until ready; and the auto-link that drops check-ins
into the trip their date and place match. Trips, stops, ready, attachments and links are online operations (`/api/ops`); items and day notes sync offline
(6.6). Roles beyond the creator's are epic 10.

## Related

[`DESIGN.md`](../../DESIGN.md) §5.2, §7.1, §10, §12, §15.7

## Tasks

#### 📋 9.1 — Trips, members and access

**Goal:** a person makes a trip, is its Organizer, and nobody else can reach it. **Design:** §5.2, §10.1, §10.8. **Depends on:** 2.7, 4.1.

**Technical:** `trip` (name and description sealed) and `trip_member` (the creator as Organizer, going); `/api/ops` as Tusk's and Tally's (session,
`Origin`, one handler per operation, the trip's new state or a refusal that reads as not found); create, rename, recolour, describe, delete (confirmed,
naming what goes; linked check-ins unlinked); the membership-and-role fragment in `src/access/`; `src/access/routes.ts` and the second-person test; the limits of §10.8, each a setting (`ROAM_LIMIT_*`, declared in `src/config/` and `.env.example`), lowering one never deleting anything.

**Accepts when:** a second person gets not found from every operation on the trip; deleting a trip leaves no row of it and unlinks its check-ins.

#### 📋 9.2 — Stops, days and trip places

**Goal:** the shape of a trip. **Design:** §7.1, §10.3, §10.4. **Depends on:** 9.1, 4.4.

**Technical:** `stop` and `day`; trip places (`place.trip_id`); add a stop from a found place, re-date, reorder, remove; no overlap except a shared
boundary day; 90 days a stop, 365 a trip; days made and removed with the dates, a shrink over a day with items refused naming the days, with operations to
move those items or delete them first; the trip's dates recomputed in the same transaction; day title and notes as mutations (6.6).

**Accepts when:** overlapping stops are refused and a shared boundary is accepted; shrinking a stop over an item is refused, and accepted after moving
it; the trip's dates always equal its first and last stop's.

#### 📋 9.3 — Items

**Goal:** things to do on a day. **Design:** §10.5. **Depends on:** 9.2.

**Technical:** `item` (title and notes sealed), at least a place or a title; kind; start and end in the stop's zone; fixed only with a start; fractional
order; create, edit, move within and between days, delete, as actions and mutations in the trip's stream (applied by 6.6; online until then).

**Accepts when:** an item without place or title is refused; fixed without a time is refused; moving an item to another stop's day keeps its fields.

#### 📋 9.4 — Ready and status

**Goal:** planning until ready, then dates. **Design:** §10.2. **Depends on:** 9.2.

**Technical:** `trip.ready_at`; mark ready (Organizers; needs a dated stop) and back to planning; status computed in `src/trips/status.ts`, pure, in the
first stop's zone; "these dates have passed" for a planning trip in the past; `trip_ready` raised once 12.1 is in.

**Accepts when:** fixtures give each status at the day's edges in the stop's zone; a trip with no dated stop cannot be marked ready.

#### 📋 9.5 — Attachments

**Goal:** files on a trip or a day. **Design:** §10.6. **Depends on:** 9.1, 3.2.

**Technical:** `attachment` (title sealed) through 3.2 (`media.trip_id`, PDF or image, 15 MB); kind; on the trip or a day; upload, rename, move, delete;
Organizers and Travelers only, in every statement and in `/api/media`'s check; deleted with the trip.

**Accepts when:** a Follower gets not found for an attachment's row and its file; deleting the trip deletes its files.

#### 📋 9.6 — Links

**Goal:** a trip's links, Tally first. **Design:** §10.7. **Depends on:** 9.1.

**Technical:** `trip_link` (title and address sealed), up to 10, `https` only; kind `tally` when chosen as _Expenses in Tally_; never fetched, no preview;
add, edit, reorder, remove.

**Accepts when:** an `http:` or `javascript:` address is refused, and no request is ever made to a link's address.

#### 📋 9.7 — Auto-link

**Goal:** check-ins fall into the trip their date and place match. **Design:** §12. **Depends on:** 9.2, 6.6, 5.2.

**Technical:** `src/autolink/`, pure: candidates by local date among trips where the person goes, the nearest stop that day, the shorter trip, the
earlier made; run in the action on the device and again in apply on the server; `link_source` manual never touched; re-decided when a check-in's moment or
place changes; a job re-links a person's automatic links when a trip's stops change dates; Change and Unlink on the check-in; earlier imports re-linked once.

**Accepts when:** fixtures hold for a work trip and a weekend sharing dates, a travel day, a check-in across the date line, and a manual link surviving a
re-date; the device and the server always choose the same trip.
