# Epic 5: Check-ins

## Status

📋 Planned.

## Overview

A check-in is written through one path: a pure action makes a mutation, and the server applies it, re-checking, sealing and ordering it in one short
transaction. Photos join it through the media store. Figures are read back from check-ins, never stored. The shape is Tally's write path (its epic 5).

## Related

[`DESIGN.md`](../../DESIGN.md) §9, §15.2, §15.3, §18

## Tasks

#### 📋 5.1 — Actions and validators

**Goal:** every check-in change as a pure function from intent to a mutation. **Design:** §9.1, §9.4, §15.2. **Depends on:** 4.1.

**Technical:** `src/actions/` for check-ins and places: create (by place, by a new place, by a point alone named later), edit, delete; the mutation shape
(id made by the device, stream `account`, `baseVersion` on an edit); `src/checkins/validate.ts`, one module for the browser and the server (sizes, a moment
not in the future, a valid zone, at most 10 photos); the auto-link hook point, empty until 9.7.

**Accepts when:** each action's output is fixed by fixtures, and the validator refuses each bad input with a sentence.

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
