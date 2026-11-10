# Epic 7: Check-in screens

## Status

📋 Planned.

## Overview

Phase 1's interface, designed anew (`DESIGN.md` §20), painting from the device's store: the shell's places, the check-in sheet, the timeline, the map,
places, Home, and the phone. Every map has a list beside or instead of it.

## Related

[`DESIGN.md`](../../DESIGN.md) §9, §20

## Tasks

#### ✅ 7.1 — The shell's places

**Goal:** the sidebar and header working. **Design:** §20.2, §20.3. **Depends on:** 6.2.

**Technical:** _Check in_ opening the sheet over any page (`?checkin=new`); Home, Check-ins, Map, Places as links with the current one marked; the avatar
menu (Settings, Notifications, Import, Sign out, back to core when set, Couldn't sync when non-empty); the bell's place (filled by 12.1); the Trips section
hidden until 11.1; keyboard `C` for check in.

**Accepts when:** every place is reachable with the keyboard, and the sheet opens over any page and closes back to it.

**Done as:** **_Check in_ is first in the sidebar** (full, rail and the phone's drawer): a real link to `?checkin=new` (so it can be opened in a new tab or copied), which a plain click turns into a push of the current path and query with `checkin=new` added, so **the rest of the query is kept**; it is marked with `aria-keyshortcuts="C"` and shows the key. **`src/screens/checkin.ts`**, pure: whether a query asks for the sheet (**exactly `checkin=new`**, nothing else opens it), the address that opens it over a page, the address that closes it
(the same path and query without it), and the rule for the **`C` key**: no modifier (Ctrl, Cmd and Alt are the browser's), not held down, not already taken, **and not while typing** (an input, text area, select, anything editable, a `role` of text box or combobox). **`CheckInSheet`** (made by `SignedInArea`, inside a `Suspense` since it reads the address on the client): open when the address says so, **over any page**; Escape, its close button and the back button close it and the
address and the page are as they were (the sheet is a step in the history); **a `Sheet` on a wide screen and a `Drawer` on a narrow one with the same content** (`CheckInContent`, which says what is true: the ways to check in are coming; **7.2 replaces it and nothing else of the sheet changes**). **Already there, and unchanged:** Home, Check-ins, Map and Places as links with the current one marked; the Trips section absent until 11.1; Couldn't sync in the avatar menu while there is any (6.3).
**Not here, since the page it opens is not:** the avatar menu's Notifications (12.1) and Import (8.3) and a way back to core (2.3), and the bell's place (12.1): an entry is added with its page, as `places.ts` says. **Seen:** the address rules and the key rules with the odd and hostile cases (a stray query, a query that decodes to something, every modifier, every kind of field); **in Chromium and WebKit (`e2e/shell.spec.ts`):** every place of the sidebar goes where it says by Enter and marks itself current; in Chromium the Tab order is
Check in, Home, Check-ins, Map, Places (**Safari does not Tab to links unless the person has asked it to, so the order of Tab is asked of the browsers that do**); the sheet opens over Home, Check-ins, Map, Places and Settings and closes back to the same address by Escape, by its button and by the back button; `C` opens it from a page, is not another request with it open, does nothing with Ctrl, and does nothing in a field (the typed `c` lands in the field); an address with `checkin=new` opens it on load with the rest of its query kept, and
`checkin`, `checkin=old` and `checkin=NEW` do not; at 375 px it is a drawer with the same content and closes the same way. Each rule was taken out in turn and seen to fail its test (typing, a modifier, the rest of the query). **Left out:** the bell (12.1), and moving focus back to _Check in_ when the sheet closes, which the design system's `Sheet` and `Drawer` do or do not do for themselves.

#### ⏳ 7.2 — Checking in

**Goal:** the check-in sheet. **Design:** §9.2, §20.5. **Depends on:** 7.1, 4.2, 17.1.

**Technical:** `Sheet` wide, `Drawer` narrow, the same content; _Here_ (position asked for when first used, the person's nearest places, then the place
search's nearby, then _New place here_), _Search_, _On the map_ (17.1's point picking); the moment (now, or earlier, with the zone following the place);
note; photos (camera or files, through 6.5); companions (`TagInput`); offline, own places only, a new place by name and position, or a point alone; Enter
to check in; denied location removes _Here_ with a sentence. The trip link and sharing rows appear with 9.7 and 10.3.

**Accepts when:** in a browser with position mocked, each way checks in; with the network off, a check-in by position alone is saved and later named by
reverse lookup; the sheet works with the keyboard only.

**Done as, except _On the map_, which waits for `Map` (17.1, in `sovereign`) and is not offered until it exists:** **`src/screens/checkin-flow.ts`**, pure (every way and every odd turn tested without a browser): `buildOptions` offers **the person's own places first** (searched on the device, nearest first when the position is known, those within 1.5 km when nothing is typed), then the place search's with any the person already has taken out, then _New place here_ and _A place near …_ only where there is a position; `selectionOf`, `zoneOfSelection` and `momentFromInput` (the moment on the **place's** clock,
23:59 and 00:01 on the right days); and `planCheckIn`, which makes the action, **reusing a place the person has however it was reached** (the same source and id, or the same name within 50 metres, so "Café de Flore" by search and by name at the spot is one place and two check-ins). **The sheet's content (`CheckInContent`)**: _Here_ (the position is **asked for when it is first used and never needed**; if the browser already allows it, it is read without a question and _Here_ is first; if it is refused or the device cannot tell, _Here_ goes with a sentence and the
person is left on _Search_), _Search_ (the field has the focus when the sheet opens; own places at once, the place search after a 450 ms pause and for three characters or more, **the position never sent with a search**), a new place by name at the position, a point alone, the moment (now, or **Another time** on the clock where the place is, in its zone, **with the sentence for a moment in the future given by the app and not by the browser**: the form does not use the browser's own validation), a note, photos (files or the camera, up to ten, shown and removable
before they are kept, each kept on the device under an id the check-in names and uploaded as 6.5 does), companions (`TagInput`), and **Check in**, which **saves and closes at once**: the check-in is on the device and goes when there is a network. **Enter checks in** from the search field or a chosen place, taking the first place on offer when none is chosen. A place search that is **off**, **not reachable** or **needs a connection** says so in a sentence and the person's own places are still there. The browser tests' main instance now
searches the fake place search (`src/places/fake.ts`, started by Playwright), so the search is tried for real and reaches nothing. **Three real faults found by the browser tests, and fixed:** (1) the sheet opened and closed by the **router**, which asks the server for the page again, so **with no network it fell back to loading the page and failed**; the address is now read from `window.location` and changed by the **history API** (`checkin-location.ts`), which asks for nothing, **and the sheet is told at once** (the browser's back button too), so it opens and closes immediately instead of waiting for Next to take
the new address up, which a busy page did late enough to fail a WebKit test now and then (Next keeps `usePathname` and `useSearchParams` in step, and the sheet still closes when the app navigates elsewhere); (2) **`store.view()` read the rows and the outbox in two transactions**, so a sync settling between them left a check-in, or the place it was made at, out of what was shown for a moment, which made a search typed at that moment miss the person's own place (an intermittent failure, one run in about five); it reads in one transaction now, and a test fixes that;
(3) a click on the avatar menu before a cold server's page had started up did nothing, so the sign-out helper asks again if the menu has not opened. **Seen, in Chromium and WebKit (`e2e/checkin.spec.ts`):** with the position mocked, _Here_ is first, a new place by name makes a place in its zone and a check-in, and a second check-in by search is **the same place** (one place, two check-ins); at Tokyo Tower the search's place is offered and makes a place with its source, id, category and zone; search finds Café Central and Enter checks in at the first when none is chosen; **with the network off, a check-in by
position alone is saved on the device** (the sheet opens, works and closes with no network) **and goes when the network is back**, the place called "A place near …" in the zone of its point (the server names it from where it is when its job runs, 5.2); with the network off the person's own places are still searched and the sheet says the place search needs a connection; another time is on the place's clock (23:59 of a day in the past, in Tokyo, whatever the device's zone) and tomorrow is refused with the sentence; a refused position removes _Here_ with its sentence and searching
still works with no way to make a place; a note, two companions and photos (one removed before saving) are kept with the check-in and the photo reaches the server; the keyboard alone (`C`, type, Enter) checks in; and at 375 px it is the drawer and works the same. The whole browser suite passed eight times in a row. **Left out:** _On the map_ (17.1); the trip link and sharing rows (9.7, 10.3); and the sheet filled in from Trip Mode or an item.

#### ⏳ 7.3 — The timeline and a check-in

**Goal:** `/checkins` and `/c/<id>`. **Design:** §20.6. **Depends on:** 7.2, 17.6.

**Technical:** every check-in, newest first, grouped by day in its own zone, rows as §20.6 (the trip's dot joins with 9.7); filters in the query (year,
category, country, search over names and notes on the device; trip with 9.1); virtualised for ten thousand rows; `SplitPane` wide, a page narrow; a
check-in's page with the photo viewer (17.6), Edit (the sheet filled) and Delete (confirmed, for good).

**Accepts when:** a seeded decade scrolls smoothly, filters agree with counts from 5.4, and edit and delete work offline.

**Done as, except the photo viewer (17.6, in `sovereign`) and the trip link, trip filter and "shared" mark (9.1, 9.7, 10.3):** **`/checkins` and `/c/<id>` are one page** (`CheckinsView`) **that draws what the address says**, so opening a check-in, changing a filter and coming back are changes of the address in the page by the history API (`goTo`, which takes only a path of this app) and ask the server for nothing: they work with no network, and a reload on `/c/<id>` is the same page. **`src/screens/timeline.ts`**, pure and tested with
**a seeded decade of ten thousand check-ins**: days **in each check-in's own zone**, newest first by the clock where each was made (ordered by the moment alone, check-ins in different zones cut a day into pieces: found by the decade test), each with its count of places; rows with the place, the time, the first line of the note and the first photo; the filters in the query (year, category, country, and a search whose every word must be in the place's name, the note or who was with the person), read so that **a stray or hostile query is no filter and runs
nothing**; the options from what the person has; and the **window**: rows of fixed heights with prefix sums and a binary search, so **only the rows in view are drawn** (about thirty at any scroll position of ten thousand, built in well under a second). **The filters agree with the counts of 5.4**: for every year and every country the number a filter leaves is the figures' number, held by a test on the hand-worked seed and on the decade. **The list** (`TimelineList`) has a height of its own (the viewport less the header and the phone's footer: a list that is
not given one grows to its whole content, which is every row), keeps a selected check-in in view, and says "No check-ins yet" with a way to check in, or "Nothing matches" with a way to clear the filters. **A check-in** (`CheckinDetail`): the place, the moment on the clock where it was made with its zone, the note, the photos (from the device while they are only there, the server's after; **the thumbnail's id is now worked out on the device** (`media/thumb.ts`, held equal to the server's for 200 photos), which 6.5 had left out; a photo not there yet is a
placeholder, never a broken image), who was there, **Edit** and **Delete**. **Wide: the check-in is beside the list; narrow: it is a page with a way back, at the same address** (`CheckinsLayout`, the only file that asks the width, in `no-fork.test.ts`'s list). **Edit is the check-in sheet filled in** (`?checkin=edit&of=<id>`, an id that is one): the person's own places to move it to with its own first, the date and time on the clock where it was made, the note, who was there and the photos it has, which can be taken away, and new ones added; **only what differs is a change** (`planEdit`; a moment left as it was is not worked out again, so a check-in made live does not become one made by hand), the row goes whole with the version it
was made from, and **nothing changed is refused with a sentence**. **Delete asks first and is for good**, with its photos. **Found while doing it:** an edit of a check-in from the device's store was never "unchanged", because the store's row carries the server's number for it (`seq`) and the comparison choked on it; it compares what a check-in is now. **Seen, in Chromium and WebKit (`e2e/timeline.spec.ts`):** a seeded decade of four thousand: a handful of rows drawn, the oldest reached by scrolling still with a handful, the year and country filters leave the data's counts, a search leaves its count, and the empty and cleared
states; a check-in opens beside the list at `/c/<id>?year=2025`, keeps the list and marks the row, a reload keeps it, the back button returns to the filtered timeline, and at 375 px the same address is a page with "← Check-ins" back to it; a check-in that is not here is a page that says so; **editing with the network off** changes the note and companions at once and the server has the change when the network is back; saving nothing says "Nothing was changed." and a moment can be corrected on the clock where it was made; **deleting with the network off** asks, keeping keeps it,
deleting removes it at once and the server loses it when the network is back. The whole browser suite passed three times in a row. **Left out:** the photo viewer (17.6), the trip's dot and name and the trip filter (9.1, 9.7), "shared" (10.3), and a link from the place's name to its page (7.5).

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
