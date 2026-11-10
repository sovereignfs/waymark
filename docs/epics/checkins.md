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

#### ✅ 5.2 — Applying a mutation

**Goal:** the server applies a mutation once, sealed and ordered. **Design:** §15.3, §15.5, §18.1. **Depends on:** 5.1.

**Technical:** `src/sync/apply.ts`: one short transaction per mutation that checks the stream is the account's, re-validates, seals, increments
`account_stream.seq`, stamps each changed row, records the mutation id (`applied_mutation`) so a replay writes nothing, and writes tombstones for
deletes; reverse lookup for a point-only check-in queued as a job after the transaction; refusals as a reason code and a sentence.

**Accepts when:** a mutation applies, a replay writes nothing, a mutation for another account's row is refused as not found, and the property test
(random sequences of creates, edits and deletes on two devices) ends with the same rows whatever the order of arrival.

**Done as:** migration `0005_checkins` (both dialects): `checkin` (plain: owner, `place_id`, `at`, `tz`, `offset_min`, `trip_id`, `link_source`, `share`, `source`, `external_id`, `version`, `seq`; **sealed: the note and the companions**; indexed by `(account_id, at)`, `(account_id, seq)`, trip and place, and **unique by `(account_id, external_id)`** so importing again adds
nothing twice), `account_stream` (the counter), `applied_mutation` (key: account and mutation id) and `tombstone` (table, id, `seq`, no content), and `place.unnamed`. **`src/sync/apply.ts`, `applyMutation(deps, accountId, input)`:** one short transaction for each mutation, in which (1) the mutation id is taken first, and one already taken is a **replay that writes nothing**; (2) the input is parsed again with
5.1's `parseMutation`; (3) one statement takes a number in the account's stream for every change, so two mutations at once cannot share one, and each change is stamped with its own (the row's `seq`, or its tombstone's); (4) rows are sealed through `Sealer`; (5) the first change that is wrong **rolls back the whole mutation, the number and the id too**, and answers with a reason and a sentence, so a mutation
mended and sent again under its id is applied. A put makes the row or **replaces it whole** (the later edit stands whatever `baseVersion` it carried; one for a row deleted meanwhile restores it and takes its tombstone away); a delete of a row that is not there or not the person's **does nothing and says no more than that**; a put on another person's id is `missing`, **not found**; a check-in must be at a place of the same
person's, which may be made earlier in the same mutation (`place_missing`); a place is deleted by one statement with a `NOT EXISTS` for its check-ins, so one that has some is `in_use`, and the check-in and then the place in one mutation works; an import's own id on another check-in is `duplicate`. `places.ts` now lists check-ins in `PLACE_REFERENCES`, so 4.1's merge and delete see them. **Naming a place made from a point alone** (`src/places/naming.ts`,
the job `name-places`, every minute, under a lease): the mutation marks it, and the job asks the place search what is there, writes the name **through the stream** (the counter, the row's version and number), only to a place that is still marked, so **a name the person typed meanwhile stands**; nothing found, or no search, stops asking; a search out of reach is tried again, six times in all. **`People.deletePerson` removes the check-ins, the stream, the applied mutations and the tombstones**, and its
test seeds them for both people. **Seen:** a place and a check-in apply, sealed (the note is in no column and not readable in the envelope), stamped 1 and 2; a replay, and three at the same time, write nothing and exactly one applies; eight mutations of three changes at the same time take twenty-four distinct numbers with none missing; another person's row cannot be edited, restored or deleted, and their stream does not move; a mutation with one wrong change leaves no row, number or id behind;
the future, a long note, a place with no name and a key the format does not have are refused here though the device did not; the later of two edits stands, whole. **The property test** (`property.test.ts`, 20 seeds, on all three databases): two devices start from the same three places and five check-ins and each do twelve random things with the real actions; their outboxes arrive in a random interleaving that keeps each device's own order, a quarter of them twice; the server's
places, check-ins and tombstones are exactly what a plain model of the rules gives for that order, the stream ends where the changes say, no two rows share a number, and replaying everything changes nothing. Each safeguard was taken out in turn and seen to fail (the numbers, another person's row, the replay check, a place with check-ins, the tombstone of a restored row). **Left out:** the server's second run of auto-link
(§12; it joins when 9.7 makes the rule, and the hook is `ctx.link` on the device side already); **merging two places** (4.1's `mergePlace`) moves check-ins without taking numbers in the stream, so a device would not hear of it: it is an online operation of 7.x's, which stamps what it moves; and pull, the endpoint and the device's store are 6.1 and 6.2.

#### ✅ 5.3 — Photos

**Goal:** photos on check-ins. **Design:** §9.3. **Depends on:** 5.2, 3.2.

**Technical:** `checkin_photo` with order; the action references media by device-made id; the server accepts a mutation whose photo has not arrived
(`media.state = pending`) and shows a placeholder until it does; deleting a check-in or a photo deletes its files (3.2); thumbnails in lists, the full image
in the viewer.

**Accepts when:** a check-in with three photos round-trips; deleting it leaves no file on disk; a photo uploaded after its check-in attaches to it.

**Done as:** migration `0006_checkin_photos` (both dialects): `checkin_photo` (`id` is **the media id the device made**, so a photo is on one check-in at most and moving it is writing it again; `checkin_id`, `account_id`, `position`, `seq`). **A check-in row carries `photos`**, ids in order, at most ten, **each a UUID** (it names the file on disk, so nothing else gets through; `FILE_ID` is now one definition in `src/sync/format.ts`, which `media/files.ts` uses too), validated by 5.1's
`validatePhotos` and carried by the actions (`photos` when checking in, `photos` in a change, which sends the list again to add, remove or reorder). **In `applyMutation`** a put makes the check-in's photos what its row says: a photo **whose file has not arrived is accepted** (the check-in shows a placeholder until it does; the device asks `/api/media/<id>` and gets not found, so nothing needs to tell it), one whose file is **another person's**, or that is on **another person's**
check-in, is `photos`, refused with nothing kept; one no longer listed leaves the check-in, and a delete takes all of a check-in's photos. The files of what left are removed **after the transaction commits** (`ApplyDeps.release`, `releasePhotos` over 3.2's `deleteMedia`, thumbnail with it): a file cannot be rolled back, and a failure to remove one leaves the mutation applied and the file to the sweep. **The sweep** (`src/checkins/photos.ts`, in the hourly `sweep-media` job) removes a photo
uploaded more than **thirty days** ago that no check-in names, since an upload may come well before its check-in (it waits in the device's store, §15.6) and a person may be offline for days (the thirty days are mine). `People.deletePerson` removes the photo rows (their files were already its first step). **Seen:** three photos round-trip in order and each is readable by its owner and by no one else; reordering and taking one away works and removes its file and its thumbnail; deleting a check-in leaves **no file on
disk** and no `media` row; a photo uploaded after its check-in attaches; another person's file, and a photo on another person's check-in, are refused; eleven, a non-UUID and a repeat are refused with a sentence; a release that fails does not undo the mutation, and the sweep takes the file once the wait is over; a photo that is attached, or recent, stays. **Left out:** thumbnails in lists and the full image in the viewer are the screens' (7.x), and the upload of a photo taken offline is the device's (6.5).

#### 📋 5.4 — Figures

**Goal:** counts read back from check-ins. **Design:** §9.5. **Depends on:** 4.1.

**Technical:** `src/figures/`, pure, over a person's check-ins and places: totals, per year, places, countries and regions, cities; per place (times,
first, last, trips once 9.1 is in); the next trip once 9.4 is in. Nothing that rewards.

**Accepts when:** every figure matches a hand-worked seed, and the same rows give the same figures on the device and the server.
