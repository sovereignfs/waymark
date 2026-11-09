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

#### 📋 6.1 — The sync endpoint

**Goal:** `POST /api/sync`, for the person's stream. **Design:** §15.3. **Depends on:** 5.2.

**Technical:** session and `Origin` checked; a request carries the outbox in order and a cursor per stream; the answer carries applied, refused (with
reasons), and changes since each cursor, paged at `seq` boundaries and unsealed for the account; a protocol version; a rate limit per account. Trip streams
join with 6.6.

**Accepts when:** a lost answer retried applies nothing twice; a stale cursor returns what changed since, in order; a second person's rows never appear.

#### 📋 6.2 — The device's store, outbox and loop

**Goal:** IndexedDB per account, an outbox, and a loop that syncs. **Design:** §15.1, §15.3, §15.8. **Depends on:** 6.1.

**Technical:** `src/local/` with `idb`: one database per account (`roam-<account id>`); the person's places, check-ins and photo records; writes to the
store and the outbox in one transaction; the loop after a write (debounced), on load, on focus, on coming online, every 30 seconds while visible, and from
Background Sync; Web Locks so one tab syncs, BroadcastChannel to tell the others; first load in pages, newest first; sign-out sends the outbox, then deletes
the database; an ended session keeps the outbox for the same account. Copied: Tally's `src/local/` shape.

**Accepts when:** two browsers of one account, one offline, both end with the same check-ins; signing out leaves no Roam database in the browser.

#### 📋 6.3 — Couldn't sync

**Goal:** a refused change is kept, explained and fixable. **Design:** §15.5. **Depends on:** 6.2.

**Technical:** refused mutations move to a Couldn't sync list in the store with the reason's sentence; a mark on the avatar and an entry in its menu;
Settings > This device lists them with fix and send again, or discard; never silently dropped.

**Accepts when:** a check-in refused by the server appears in Couldn't sync with its reason, and can be fixed and sent.

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
