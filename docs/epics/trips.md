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

#### ✅ 9.1 — Trips, members and access

**Goal:** a person makes a trip, is its Organizer, and nobody else can reach it. **Design:** §5.2, §10.1, §10.8. **Depends on:** 2.7, 4.1.

**Technical:** `trip` (name and description sealed) and `trip_member` (the creator as Organizer, going); `/api/ops` as Tusk's and Tally's (session,
`Origin`, one handler per operation, the trip's new state or a refusal that reads as not found); create, rename, recolour, describe, delete (confirmed,
naming what goes; linked check-ins unlinked); the membership-and-role fragment in `src/access/`; `src/access/routes.ts` and the second-person test; the limits of §10.8, each a setting (`WAYMARK_LIMIT_*`, declared in `src/config/` and `.env.example`), lowering one never deleting anything.

**Accepts when:** a second person gets not found from every operation on the trip; deleting a trip leaves no row of it and unlinks its check-ins.

**Done as:** **Tables:** `trip` and `trip_member` on both dialects (migration `0016_trips`; `SEALED.trip` was declared and is now written: the name and description are sealed, the key rotation moves them with the `seq` guard, and a test reads the database and finds neither). **`src/access/trip.ts`:** `memberOf(database, trip, account, roles)`, the one SQL fragment (`EXISTS (SELECT 1 FROM trip_member … m.role IN (…) AND m.left_at IS NULL)`) with the three role sets (`ORGANIZERS`, `EDITORS`, `MEMBERS`); every read and write of a trip names it in the statement. **`src/trips/`:** `format.ts` (roles, colours, limits of a name and a description), `trips.ts` (`createTrip`, `listTrips`, `getTrip` with its members, `updateTrip`, `previewDeletion`, `deleteTrip`, `unlinkCheckins`, `removeTripRows`), `ops.ts` (`parseOp` and `applyOp` for `trip.list`, `trip.get`, `trip.create`, `trip.update`, `trip.delete.preview` and `trip.delete`, and `OPERATIONS`, who may do each), `endpoint.ts` and `app/api/ops/route.ts` (`POST /api/ops`: `accountRoute`, so the session and `Origin` come first; 8 KB cap; 240 a minute for each account; a request that is not an operation is 400, an operation that is refused is 200 with `not_found`, the same words for a trip that is not theirs and one their role does not allow), `people.ts` and `tables.ts`. **Creating** makes the trip and its creator, its first Organizer who is going, in one transaction, and rolls it all back past `WAYMARK_LIMIT_ACCOUNT_TRIPS`. **Renaming, recolouring and describing** are Organizers' and are written only if the row is as it was read (its `seq`) and the caller is still an Organizer, in one statement; two at the same moment both stand. **Deleting** asks first what it takes (`trip.delete.preview`: the name, how many members, how many check-ins are linked) and needs `confirm: true`; the guarded `DELETE` removes the trip only if the caller is an Organizer and what follows runs only if it did, in the same transaction: **linked check-ins are unlinked in their authors' own streams** (the account's counter advanced, each row a new version and `seq`, so their devices pull it), the trip's places and members go. `tables.ts` lists every table with a `trip_id` and what happens to it, and a test reads the schema and fails for one that is not listed (`media` waits for 9.5, `notice` is kept). **The limits** are settings (`WAYMARK_LIMIT_TRIP_MEMBERS`, `_TRIP_STOPS`, `_DAY_ITEMS`, `_TRIP_ATTACHMENTS`, `_ACCOUNT_TRIPS`: `Config.limits`, checked as whole numbers of 1 to 1,000,000, in `.env.example` and the README), of which only the account's trips is used yet; lowering one never deletes anything (tested). **Members** are read as DESIGN.md §6.1 says, through the one visibility function: every member sees every name, an address only the Organizers and the person themselves. **Account deletion** (`endMembershipsOf`, in `deletePerson`'s transaction, which now also takes `notices` so that someone can be told): a trip with nobody else in it is deleted; one the person alone organized passes to its longest-standing Traveler, then Follower, who becomes Organizer and is told (`organizer_passed`, a new kind, in the bell and core's bell by default); their rows go and `created_by` and `added_by` that name them are cleared. **Seen**, on a `file:` database, sqld and PostgreSQL (the whole suite, 1183 tests, on each, and the Chromium suite, 92 tests, once; WebKit was not run): every operation as a stranger and as a Traveler and a Follower (a table of operations says who may do each, and the test fails for one that has no request), a trip that is not an id's, the same words everywhere; over HTTP as two signed-in people (a visitor 401, another site 403, Grace told Ada's trip is not there for every operation that names one, a request that names an account is not an operation); the creator is the first Organizer; the sealed fields; every limit and a lowered one; deleting leaves no row and keeps others' check-ins theirs; a person's deletion with the shared, the solo and the passed trip, and each rule of the hand-over; and **a regression test is trusted because it was seen to fail:** with the role condition taken out of `updateTrip` three tests fail, and with the caller's membership taken out of `getTrip` five. **Left out:** there is no operation to add a member, change a role or leave: the creator is the only member a trip can have until 10.1 to 10.4 (the tests put others in with SQL); **a trip's colour is a design-system colour role** (accent, info, success, warning, error, neutral), since the system's identity is monochrome and has no hues; the count of trips is checked after the new row is in, so two creations at the same moment can pass one over the limit (the permission is in the statement, the limit is a count); trips are not in the export or the import (15.3), not on the device (6.6), and have no screen (11.x); `WAYMARK_LIMIT_TRIP_MEMBERS`, `_STOPS`, `_DAY_ITEMS` and `_ATTACHMENTS` are read and checked and nothing uses them until 10.2, 9.2, 9.3 and 9.5.

#### ✅ 9.2 — Stops, days and trip places

**Goal:** the shape of a trip. **Design:** §7.1, §10.3, §10.4. **Depends on:** 9.1, 4.4.

**Technical:** `stop` and `day`; trip places (`place.trip_id`); add a stop from a found place, re-date, reorder, remove; no overlap except a shared
boundary day; 90 days a stop, 365 a trip; days made and removed with the dates, a shrink over a day with items refused naming the days, with operations to
move those items or delete them first; the trip's dates recomputed in the same transaction; day title and notes as mutations (6.6).

**Accepts when:** overlapping stops are refused and a shared boundary is accepted; shrinking a stop over an item is refused, and accepted after moving

**Done as:** **Tables:** `stop` and `day` on both dialects (migration `0017_stops_and_days`; a stop's note and a day's title and notes are sealed, `SEALED.stop` and `SEALED.day` were declared and `stop` and `day` join the key rotation with a `version` guard); **trip places** are `place` rows with a `trip_id` and no `account_id`, made with their stop. **`src/trips/dates.ts`** (pure, no zone: dates are days of the calendar and are counted on its own arithmetic, so daylight saving and the date line cannot move one): a stop has both its dates or neither, is at most 90 days, a trip at most 365 days (each stop's days counted), stops do not overlap except for a shared boundary day (which is two days, one in each stop) and a date is in at most two stops; the trip's dates are the first arrival and the last departure; days are reconciled against the dates (made, removed, kept with their ids). **`src/trips/plan.ts`:** `readPlan` (every member, Followers included), `addStop`, `updateStop`, `moveStop`, `removeStop`. **A change is one transaction that begins with a guarded `UPDATE trip … WHERE id = ? AND <Organizer or Traveler>`**, which shows the caller may _and takes the trip's row_, so that what is read after it cannot change under it: two changes at the same moment are done one after the other (tested: of two overlapping stops made at once, one is made), the trip's counter advances once, what the change writes is stamped with it, **a refused change keeps nothing (the counter included)**, and **the trip's dates are recomputed from its stops in the same transaction**. A stop adds a place of the trip's own from the found place's fields (validated by the same function as a person's place, zone from its point); **shrinking a stop over a day that has items is refused, naming the days** (`items`, with `days`), and goes through once they are moved or deleted (items are 9.3: `DAY_REFERENCES` in `tables.ts` is where they are named, and the test uses a table of its own); removing a stop removes its days, what hangs on them, and its place unless something else of the trip names it (`PLACE_USERS`), and clears a cover that was that place; **a dated stop is in the order of its dates, so only an undated one is moved** (`stop.move`, renumbering the undated ones; a dated one is refused and told to change its dates). `trip.update` takes `coverPlaceId`, which must be one of the trip's own places (a person's place or another trip's is not found). **Operations:** `trip.plan` (members), `stop.add`, `stop.update`, `stop.move`, `stop.remove` (`editor` in `OPERATIONS`: Organizers and Travelers; a Follower and a stranger are told it is not there), answering with the plan or `invalid`, `limit`, `overlap` or `items` and a sentence that repeats nothing typed. `WAYMARK_LIMIT_TRIP_STOPS` is now used; deleting a trip removes its stops, days and places (`tables.ts`), and its preview counts the stops. **Seen**, on a `file:` database, sqld and PostgreSQL (the whole suite, 1238 tests, on each): the date rules (12), every operation as a stranger and as a Traveler and a Follower, the sealed fields, days made and removed and kept, the boundary day, every limit, the counter, concurrent changes, the refused shrink naming its days and changing nothing, ordering, removal and cascade, cover, deletion, and **a run of 40 random changes after each of which the trip's dates equal its first arrival and last departure, every stop's days are exactly its dates and there is a place for each stop**; with the items refusal taken out one test fails, and with the editor condition taken out twelve. **Left out:** nothing writes a day's title or notes (6.6, offline), and there are no items (9.3), so the refusal over items is exercised against a table the test makes; `/api/places` does not yet search a trip's own places (§7.2, with the plan's screen); a stop's place cannot be changed (remove the stop and add another); no stop or day is on the device or in the export (6.6, 15.3), and no screen draws the plan (11.x).
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
