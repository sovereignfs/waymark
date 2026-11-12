# Epic 13: Trip Mode

## Status

📋 Planned.

## Overview

Phase 3: today on an ongoing trip. Today's plan worked out as a pure function before any screen; the screen, phone first; Directions handed off to the
device's maps; reminders through the bell, Web Push and email; and the day's plan and map kept for offline. The plan is shown exactly as ordered; reordering
by distance is later (`DESIGN.md` §26.1).

## Related

[`DESIGN.md`](../../DESIGN.md) §14, §17.3, §8.2

## Tasks

#### ✅ 13.1 — Today

**Goal:** what today looks like, and what is next. **Design:** §14.1. **Depends on:** 9.3, 4.4.

**Technical:** `src/today/`, pure, from a trip's rows, the person's done marks and the moment: today in the current stop's zone, the day or the travel
day's two, items in plan order with timed ones by time, next, the countdown, the empty day; `item_done` as a mutation in the trip's stream.

**Accepts when:** fixtures hold across the date line, at 23:59 and 00:01 local, on a travel day, and with the device in another zone than the stop.

**Done as:** **`src/today/today.ts`**, pure and the one implementation (no clock, no database, no device: `now` and `deviceZone` are given; `todayOfTrip` adapts a trip as `LocalStore.tripView` holds it). **Today's date is the date in the current stop's zone**, never the device's (a phone still set to Tokyo, in Lisbon, is on Lisbon's date; a stop whose place has no zone falls back to the device's). The current stop is the one whose dates contain the date **as its own zone says it is**; on a travel day both stops qualify, the later is the current one, and **both days are shown, departing then arriving**; once the zones disagree (Tokyo has gone on to the 6th while Honolulu is still the 5th) only the stop whose own date it still is remains. A trip with no dates is `planning`; before its first day (by the first stop's zone) `before`, with the date; after its last day (by the last stop's zone) `after`, with the date; on none of its stops' days `between`; otherwise `during`. **Items are in plan order, and the timed ones in time order in the places the timed ones had** (an untimed item stays where the plan put it; ties by position, then id). **Next** is the first item in that order that is not done and is either timed with a start still ahead (the moment is the day's date and the start time **in the day's stop's zone**, across a change of clocks too: `momentOf`) or untimed and after the last item done; a timed item that has passed unmarked is not next and stays in the list undone; the countdown is whole minutes rounded up, none for an untimed one; **a day with nothing in it is an empty day**, not an error. **`item_done`**: a person's own _Done_ mark, a new table (migration `0025_itemdone`: trip, item, account, time; nothing sealed) and a **mutation in the trip's stream** (`{ table: 'item_done', op: 'put' | 'delete', id: <item> }`, in `trips/sync-format.ts` with the rest, checked by the same rules on both sides; `markDone` in `actions/items.ts`). The server applies it in the same one transaction as the other trip changes: by an Organizer or a Traveler **now** (a Follower is refused with the role sentence, a stranger as not in the trip), for **an item of this trip** (an unknown item, or another trip's, is "That item was removed from the trip", kept in Couldn't sync), once (marking twice is marking once), and **a delete takes away only the sender's own mark**. A trip's pull carries **only the account's own marks** (`sets.done`, of items still there: a deleted item's mark is out of sight), so another member never sees them; the device lays the outbox over them (`overlayTrip`), so **a mark made offline moves "next" at once**, reaches the person's other devices, and is taken away by a delete. Marks go with the trip, with the person when they leave it, and with their account (`TRIP_TABLES`, `endMembership`, `endMembershipsOf`, the deletion test). **Seen**, on a `file:` database, sqld and PostgreSQL (the whole suite, 1570 tests; 21 of them new) and under three machine zones (`pnpm test:zones`, now with the Today fixtures): the day's date from the stop's zone with the device in another; **23:59 and 00:01 local**, whatever UTC says; a change of clocks; a travel day in one zone and **across the date line** (both days while both zones are on the 5th; one once they disagree); before, after, between, planning; the order of a day (including with the rows given in any order); next after the last done, an item done before its time never offered, an item that has passed unmarked skipped, no next at the end, an empty day; the countdown rounded up; the marks' own rules on the server (own, twice, delete only one's own, role, stranger, unknown and other trips' items, a deleted item, trip, leaving, account), and on a device Today from the rows it holds with a mark made offline moving next, reaching the person's second device and not another member's. With each of these taken out one test fails: the stop's zone for the date, the later stop being current, the "ahead" test for a timed item, skipping done items, a delete of anyone's mark, and the item check. **Left out:** the Trip Mode screen and its map (13.2), **checking in from it linking and marking the item done in the journal** (the journal's own "done" is §13's, with 11.5; this is the person's own press), and Directions (13.3); reminders read the same rules (13.4); marks are not in the export.

#### 📋 13.2 — The Trip Mode screen

**Goal:** `/t/<id>/today`. **Design:** §14.2. **Depends on:** 13.1, 11.4, 7.2.

**Technical:** for Travelers and going Organizers on an Ongoing trip, otherwise when it starts or that it ended; the map with the day's items numbered and
the person's position; next with the countdown, _Directions_ and _Check in_ (pre-filled with the next item's place, copied into the person's places by
4.1's rule, and the trip); the day's items with _Done_; Home's Trip Mode card (7.6) and _Open Trip Mode_ on the trip (11.2).

**Accepts when:** on a mocked clock and position, the screen shows the right day and next item, and checking in from it links to the trip and marks the item
done in the journal.

#### 📋 13.3 — Directions

**Goal:** a hand-off to the device's maps. **Design:** §14.3. **Depends on:** 13.2.

**Technical:** `geo:` on Android, `maps://` on iPhone and iPad, an OpenStreetMap directions link elsewhere, decided from the device; the item's point and
name; documented in the README.

**Accepts when:** on the iOS Simulator, Directions opens Apple Maps at the item, not a browser tab.

#### 📋 13.4 — Reminders

**Goal:** "Dinner, Gion in 30 minutes". **Design:** §14.4. **Depends on:** 13.1, 12.4.

**Technical:** a one-minute job for Ongoing trips and the eve of Upcoming ones: `trip_starts`, `item_soon`, `day_plan`, with defaults; per person and trip
lead time and kinds in the trip's settings; once per item and person (`reminder_sent`), again if the item's time changes; none for untimed items; through
the bell, Web Push, email if chosen, and core's bell when hosted.

**Accepts when:** on a mocked clock, a fixed item's reminder is sent once with two workers, a re-timed item reminds again, and an untimed item never does.

#### 📋 13.5 — A trip offline

**Goal:** the day's plan and map with no network. **Design:** §14.5. **Depends on:** 13.2, 6.6, 1.11.

**Technical:** the worker keeps tiles around each stop of an Upcoming or Ongoing trip, to a street level and a bounded count per trip, fetched through
`/api/map`; _Download for offline_ on the trip; removed after the trip ends or at sign-out; Trip Mode and the trip's plan answered offline by 6.4's shell;
Settings > This device shows kept tiles and their size.

**Accepts when:** with the network off after downloading, Trip Mode shows the day with its map around the stop, and the kept tiles stay within the bound.
