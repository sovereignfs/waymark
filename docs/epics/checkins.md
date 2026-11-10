# Epic 5: Check-ins

## Status

📋 Planned.

## Overview

A check-in is written through one path: a pure action makes a mutation, and the server applies it, re-checking, sealing and ordering it in one short
transaction. Photos join it through the media store. Figures are read back from check-ins, never stored. The shape is Tally's write path (its epic 5).

## Related

[`DESIGN.md`](../../DESIGN.md) §9, §15.2, §15.3, §18

## Tasks

#### ✅ 5.1 — Actions and validators

**Goal:** every check-in change as a pure function from intent to a mutation. **Design:** §9.1, §9.4, §15.2. **Depends on:** 4.1.

**Technical:** `src/actions/` for check-ins and places: create (by place, by a new place, by a point alone named later), edit, delete; the mutation shape
(id made by the device, stream `account`, `baseVersion` on an edit); `src/checkins/validate.ts`, one module for the browser and the server (sizes, a moment
not in the future, a valid zone, at most 10 photos); the auto-link hook point, empty until 9.7.

**Accepts when:** each action's output is fixed by fixtures, and the validator refuses each bad input with a sentence.

**Done as:** **the mutation format** in `src/sync/format.ts`, with no dependence on a server, a browser or a database: a `Mutation` is `{ mutationId, stream: 'account', changes }`, each change a **whole-row `put`** (a create, or an edit that replaces the row, with the `baseVersion` it was made from, which says what was
seen and does not stop the edit, since the later one stands, §15.4) or a `delete`, over the two tables of a person's own stream, `place` and `checkin`; `PROTOCOL_VERSION` 1; the `LIMITS`. A trip's stream (`trip:<id>`) and its tables join with phase 2. **`src/checkins/validate.ts`**, the one module the browser runs before it queues and
the server before it applies: `validatePlaceRow`, `validateCheckinRow(row, now)`, `validateCompanions`, `validatePhotos` (ten ids the device made, none twice; 5.3 attaches them, so a check-in row carries no photos yet), and `parseMutation(unknown, now)`, which takes what a device sent, **refuses a key the format does not have**, more than 50 changes,
the same row twice, and any row that breaks a rule, and returns the mutation cleaned. Every refusal is a reason and **a sentence that says what to do, never the value that was wrong**. The rules: a moment is a whole number of milliseconds and **not in the future** (five minutes of difference between two clocks are allowed, which is mine and not
the design's), the zone is a zone, the offset is a whole number of minutes between -14 and +14 hours and is kept **as the device made it** (an older zone's offset may be one this server's tables would not give, and a refusal would lose a check-in), a note is at most 2,000 characters, companions at most 20 of 60, trimmed and kept once each in the first spelling (limits I chose; the design says "free-text names"),
a link is a trip and who made it, and **a link taken away by hand is `manual` with no trip**, which nothing automatic changes again. The place's rules moved to the pure `src/places/clean.ts` (4.1's functions, unchanged, now imported by both sides; `places.ts` re-exports them). **`src/actions/`**: `places.ts` (`createPlace`, `updatePlace`, `deletePlace`, and `placeRowOf`)
and `checkins.ts` (`checkInAtPlace`, `checkInAtNewPlace`, `checkInAtPoint`, `editCheckin`, `deleteCheckin`), each **a pure function of what it is given**: the rows on the screen, what was asked, and a context with the ids, the time, the device's zone and the **auto-link hook (`ctx.link`, empty until 9.7)**, so nothing reads a clock or a random number. A check-in
is now in the device's zone when made live and the place's for another time, with the offset worked out from the two (23:59 and 00:01 in Auckland land on the right days); a new place is made in the same mutation, first; a point alone makes "A place near 38.7223, -9.1393", marked `unnamed` for the server to name by reverse lookup (5.2); an edit sends the row
whole with the version it was made from, works the offset out again for a new moment, follows a new place's zone unless one was chosen by hand, and asks the hook again only when the moment or place changed and the link was not made by hand; a place with check-ins is not deleted, and the sentence says to merge it. **Seen:** the output of each action fixed by fixtures with
ids from a counter; **every mutation an action makes is accepted by `parseMutation`** (checked on each); the validator refuses 24 bad check-ins, 13 bad places and 17 bad mutations, each with its sentence, and none repeats what it was given; each safeguard was taken out in turn and seen to fail its tests (the offset on an edit, a link made by hand, the future, unknown keys, a place in use). **Left out:** photos on a
check-in (5.3), merging two places as a mutation (it moves check-ins, which 5.2's applying and 7.x's screen decide together), and the trip's stream.

#### 📋 5.2 — Applying a mutation

**Goal:** the server applies a mutation once, sealed and ordered. **Design:** §15.3, §15.5, §18.1. **Depends on:** 5.1.

**Technical:** `src/sync/apply.ts`: one short transaction per mutation that checks the stream is the account's, re-validates, seals, increments
`account_stream.seq`, stamps each changed row, records the mutation id (`applied_mutation`) so a replay writes nothing, and writes tombstones for
deletes; reverse lookup for a point-only check-in queued as a job after the transaction; refusals as a reason code and a sentence.

**Accepts when:** a mutation applies, a replay writes nothing, a mutation for another account's row is refused as not found, and the property test
(random sequences of creates, edits and deletes on two devices) ends with the same rows whatever the order of arrival.

#### 📋 5.3 — Photos

**Goal:** photos on check-ins. **Design:** §9.3. **Depends on:** 5.2, 3.2.

**Technical:** `checkin_photo` with order; the action references media by device-made id; the server accepts a mutation whose photo has not arrived
(`media.state = pending`) and shows a placeholder until it does; deleting a check-in or a photo deletes its files (3.2); thumbnails in lists, the full image
in the viewer.

**Accepts when:** a check-in with three photos round-trips; deleting it leaves no file on disk; a photo uploaded after its check-in attaches to it.

#### 📋 5.4 — Figures

**Goal:** counts read back from check-ins. **Design:** §9.5. **Depends on:** 4.1.

**Technical:** `src/figures/`, pure, over a person's check-ins and places: totals, per year, places, countries and regions, cities; per place (times,
first, last, trips once 9.1 is in); the next trip once 9.4 is in. Nothing that rewards.

**Accepts when:** every figure matches a hand-worked seed, and the same rows give the same figures on the device and the server.
