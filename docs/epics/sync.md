# Epic 6: Offline and sync

## Status

📋 Planned.

## Overview

The device holds what a person has seen and records without a network; the server checks and orders it. **The shape is Tally's** (its §11 and epic 6),
with two kinds of stream: the person's own (phase 1) and one per trip (phase 2). Copied from Tally where it is built by then, from Tusk's Desk otherwise,
and said so in each task.

## Related

[`DESIGN.md`](../../DESIGN.md) §15, §20.12 · Tally's `docs/epics/sync.md`

## Tasks

#### ✅ 6.1 — The sync endpoint

**Goal:** `POST /api/sync`, for the person's stream. **Design:** §15.3. **Depends on:** 5.2.

**Technical:** session and `Origin` checked; a request carries the outbox in order and a cursor per stream; the answer carries applied, refused (with
reasons), and changes since each cursor, paged at `seq` boundaries and unsealed for the account; a protocol version; a rate limit per account. Trip streams
join with 6.6.

**Accepts when:** a lost answer retried applies nothing twice; a stale cursor returns what changed since, in order; a second person's rows never appear.

**Done as:** `POST /api/sync` (`app/api/sync/route.ts`, for an account only, `Origin` checked, a megabyte at most, **a hundred and twenty a minute** for each account, `Cache-Control: no-store`, in `routes.ts`), over `handleSync` in `src/sync/endpoint.ts` and `pullAccount` in `src/sync/pull.ts`. A request is `{ protocol, outbox, cursor, limit }`: the outbox is **applied in order** by 5.2's `applyMutation` (at most fifty mutations, `TOO_MANY` beyond; **a refusal does not stop the ones after it**, and one that depended on it
is refused for that), then the stream is **pulled past the cursor**, so a device gets its own changes back at once with the server's numbers. The answer is `{ protocol, results, account }`: a result for each mutation sent (`applied` with its number, `replay`, or `refused` with the reason and the sentence, for Couldn't sync, 6.3), and a page with the **places, check-ins (with their photo ids, in order) and tombstones past the cursor, in the order of the stream and unsealed
for this account only**, the cursor now, **`more`** (ask again at once) and **`head`** (the stream's own number). A page is cut at the last number it holds, and since every change took a number of its own, nothing past it is left behind; a device with cursor 0 gets a snapshot, a page at a time (200 by default, 500 at most). **A protocol it does not speak is told to update (`426`) before anything is applied**, and its outbox stays with it; a body that is not a request is `400`.
`src/sync/server.ts` gives it this process's database, key and media store (so the files of photos that leave a check-in are removed), and the rate limit. **Seen:** an empty request gets everything as a snapshot, with the photos; the outbox is applied in order and each mutation is told what became of it, and a refused one lets the next through; **a lost answer retried applies nothing twice** and is still answered; a stale cursor returns what changed since, in order, a deleted row as a tombstone with no
content, and nothing once the cursor has caught up; nine changes paged three at a time come back once each, in order, with none left behind; **a second person's rows never appear** as a snapshot, past a cursor or among what was refused, and her attempt at his ids is refused; a request from another origin, or with no session, is refused, and two people syncing the same ids each have their own. Each safeguard was taken out in turn and seen to fail (the account in pull, the cursor, the protocol, a page cut with rows left behind).
**Left out:** a trip's streams (6.6, phase 2); the device's side is 6.2; and `Retry-After` on a `429`, which the device's loop reads as "later".

#### ✅ 6.2 — The device's store, outbox and loop

**Goal:** IndexedDB per account, an outbox, and a loop that syncs. **Design:** §15.1, §15.3, §15.8. **Depends on:** 6.1.

**Technical:** `src/local/` with `idb`: one database per account (`waymark-<account id>`); the person's places, check-ins and photo records; writes to the
store and the outbox in one transaction; the loop after a write (debounced), on load, on focus, on coming online, every 30 seconds while visible, and from
Background Sync; Web Locks so one tab syncs, BroadcastChannel to tell the others; first load in pages, newest first; sign-out sends the outbox, then deletes
the database; an ended session keeps the outbox for the same account. Copied: Tally's `src/local/` shape.

**Accepts when:** two browsers of one account, one offline, both end with the same check-ins; signing out leaves no Waymark database in the browser.

**Done as:** `idb` (8.0.4) and, for the tests, `fake-indexeddb`. **`src/local/db.ts`:** one database for each account, **`waymark-<account id>`** (an id is checked to be plain, so a name cannot be made to mean another database), with the places and check-ins as the server last said them, the **outbox**, the **refused** (Couldn't sync's store, filled now and shown by 6.3) and the cursor; a connection that another tab's delete is waiting for closes itself.
**`overlay.ts`:** what the screens read is **the rows with the outbox laid over them**, in order, as the server would apply them (a put keeps the version the device last saw, a new row is version 1; a delete takes the row away), so a change shows at once and **a refused one is gone from what is shown by itself**. **`store.ts`:** `record` puts a mutation in the outbox and returns (**recording never waits**); `settle` takes the
server's answer in **one transaction**: applied and replayed mutations leave the outbox, **a refused one moves to the refused with its sentence**, the rows past the cursor replace the device's, tombstones delete theirs, the cursor moves; a transaction that fails changes none of it. **`sync.ts`:** `syncOnce` sends the outbox in turns of fifty with the cursor and pulls pages until there are no more, and ends `ok`, `offline` (no network or a 5xx: the outbox is kept), `signed_out` (401: kept
for the same account, §15.8), `update_required` (426: kept), `busy` (429) or `error` (an answer that is not the protocol's is not trusted). **`loop.ts`:** syncs on load, after a write (after 300 ms, so several writes are one request), on focus, on coming online, on becoming visible and **every 30 seconds while the page is visible**; **one tab at a time** (a Web Lock asked for with `ifAvailable`; where there is none the tab syncs anyway, which is safe since the
server answers a mutation it already applied as a replay), a run going is not joined by a second at the same time, **and the question is not lost: one more run follows it** (found by a browser test that failed one run in three: a change recorded while a run was going had to wait for the next thirty-second trigger), and `BroadcastChannel` tells the other tabs that something changed (they read the store again) or that a tab wrote (the tab that syncs does). Everything the loop needs of the browser is given to it, so its tests have no browser. **`LocalProvider.tsx`** opens the store for the account, runs the loop and gives the screens `useLocal()` (the places, the check-ins, the state, `record`), and `SignedInArea` makes it for an account
(the offline shell, which has none, makes none). **Signing out** (`AccountMenu`) sends what can be sent, **asks before it throws away what cannot** ("Some changes were not sent": what is waiting or was refused and is only on this device), ends the session, and **deletes the account's database from the browser**. A test (`client-only.test.ts`) follows every import that is not only a type from the provider and fails for one that reaches server code or a package
the browser is not meant to carry: **it found that the first version took the whole applier into the page, and a script the page's policy refuses with it** (a constant was imported from the endpoint's file; it is `LIMITS.outbox` in the format now). **Seen:** against the real server code and database of each leg, two devices (an IndexedDB each) of one account, one offline for a while, end with the same check-ins and nothing lost; the later of two edits stands on both; a
delete reaches the other as a tombstone; a lost answer loses nothing, and the outbox sent again is answered as replays; a refused mutation is kept with its sentence and the rest go; 401, 426, 429, 5xx and an answer that is not the protocol's all keep the outbox; sixty mutations and a long stream go in turns and pages until done; what is waiting is still shown on top of a pull; signing out deletes the database and not another account's; the loop's triggers, its pause, a run that is not doubled and a question that is not lost, the lock, the other tabs and its stopping, with no browser. **In Chromium and WebKit (`e2e/device.spec.ts`):** two browsers of one account, one offline, both end with the same check-ins through the app's own loop; signing out leaves no Waymark database in the browser; and signing out with a refused change asks first, and staying keeps the database. Each safeguard was taken out in turn and seen to fail its test (a refused change kept, the outbox laid over the rows, the outbox left before the answer is known,
the lock). **Left out:** Background Sync (the worker waking a page that is not open needs the store in the worker, which 6.4 decides with offline opening; a page that is open syncs on its own), **first load newest first** (a snapshot comes in the stream's order, oldest first; screens that wait for the first load show what has arrived, and reordering the first load is a refinement of 6.4's), and the screens that read and write through `useLocal` (7.x).

#### ✅ 6.3 — Couldn't sync

**Goal:** a refused change is kept, explained and fixable. **Design:** §15.5. **Depends on:** 6.2.

**Technical:** refused mutations move to a Couldn't sync list in the store with the reason's sentence; a mark on the avatar and an entry in its menu;
Settings > This device lists them with fix and send again, or discard; never silently dropped.

**Accepts when:** a check-in refused by the server appears in Couldn't sync with its reason, and can be fixed and sent.

**Done as:** the refused store of 6.2 now has its two operations, **`retryRefused`** (the mutation goes back to the **end of the outbox with the id it had**, in one transaction so it is never in neither: the server rolled the refusal back with everything else, so the id was not spent) and **`discardRefused`** (only the person decides), and `refused()` lists them oldest first. `LocalProvider` exposes `refused`, `retry` and `discard`. **`src/local/describe.ts`** says what a mutation was in a few words a person
recognises ("Check-in at Sé de Lisboa, 4 July 2026 12:30", in the zone it was made in; "Place Café de Flore"; "Delete of a check-in"), naming the place from the mutation itself when it made the place and from the device otherwise. **Settings > This device** (`DeviceSection`, the fourth section, `?section=device`, which `query.ts` and its test now know): each change with the reason as the server's sentence, _Send again_ and _Discard_ (which asks, and _Keep it_ keeps it); with none, "Everything
on this device has been taken by the server." The avatar menu gains **"Couldn't sync (n)"** while there is any, which goes to that section. **Seen:** a refused check-in is kept with its sentence and is sent again when what stopped it is mended, and then is no longer refused and reaches the server; sent again with nothing mended it is refused again with the same sentence, not lost and not applied twice; it is thrown away only by the person and then is gone for good, and another sync does
not touch it; and in Chromium and WebKit the menu says so, goes to the section, the sentence and the description are there, _Send again_ keeps it, _Discard_ asks, _Keep it_ keeps it and _Discard_ removes it and the menu entry with it. **Left out:** the mark **on the avatar** itself: the design system's `UserMenu` has no badge, and a badge is built in `sovereign` first (epic 17), so for now the mark is the menu's entry; and **fixing** a check-in before sending it
again is the check-in's editor (7.x): this sends it as it was.

#### 📋 6.4 — Opening offline

**Goal:** signed-in addresses answer with no network. **Design:** §20.12. **Depends on:** 6.2, 1.11.

**Technical:** the worker answers Home, Check-ins, a check-in, Map (its list when tiles are not kept), Places and a place with the kept shell, which reads
the store; every other address gets the offline page; `navigator.storage.persist()` requested; `OfflineGate` for what needs a network (§15.7).

**Accepts when:** with the network off after one visit, each of those addresses opens with the person's data, and none of it is in the worker's cache.

#### 📋 6.5 — Photos waiting

**Goal:** photos taken offline upload later. **Design:** §15.6. **Depends on:** 6.2, 5.3.

**Technical:** a photo's blob kept in the store with its device-made id; uploaded to `/api/media` when online, before or after its check-in's mutation,
retried with backoff; shown from the store meanwhile (`blob:` URLs); a photo refused goes to Couldn't sync with its check-in; blobs deleted once uploaded.

**Accepts when:** a check-in with a photo made offline shows the photo at once, and on reconnecting the photo reaches the server and another device.

#### 📋 6.6 — Trips on the device

**Goal:** one stream per trip, for its members. **Design:** §15.1, §15.2, §15.3, §15.4. **Depends on:** 9.3, 6.2.

**Technical:** `trip.seq`; pull per trip the account is an active member of, with rows each role may see (no attachment rows for a Follower); a trip left is
named as gone and deleted from the device; mutations for items and day notes in a trip stream, checked against the role; conflicts by §15.4's table, the
replaced author told (`edit_replaced`, raised once 12.1 is in); an offline item for a gone day to Couldn't sync; shared check-ins join with 10.3.

**Accepts when:** two Travelers editing one item end with the later edit and a notice to the other; a Traveler lowered to Follower between syncs gets their
item edit in Couldn't sync; a Follower's device never holds an attachment row.

#### 📋 6.7 — Keeping the history small

**Goal:** tombstones and applied mutations do not grow for ever. **Design:** §15.8. **Depends on:** 6.1, 1.6.

**Technical:** a job removes tombstones and applied-mutation records after 90 days; a device whose cursor is older sends its outbox, then receives a
fresh snapshot of that stream.

**Accepts when:** after pruning, a device with an old cursor ends with the right rows and nothing lost from its outbox.
