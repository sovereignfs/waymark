# Epic 15: Portability

## Status

📋 Planned.

## Overview

A person can take what is theirs and bring it to another Waymark: one ZIP of JSON and files, built by a job. Phase 1 covers places and check-ins; phase 2 adds
trips. This is the app's own format, separate from the Swarm import (epic 8).

## Related

[`DESIGN.md`](../../DESIGN.md) §22

## Tasks

#### 📋 15.1 — Export

**Goal:** a person's data in one file. **Design:** §22. **Depends on:** 5.3, 1.6.

**Technical:** a job builds a ZIP: `waymark.json` (`format`, `version`, profile, settings, places, check-ins with companions and links) and the photos as files;
stored sealed under `/data/exports`, downloadable from Settings > Data within a day, then deleted; no one else's email; noted on core's activity page once
14.1 is in.

**Accepts when:** an export of a seeded person holds every place, check-in and photo, and its JSON validates against the format's schema.

#### 📋 15.2 — Import

**Goal:** a file made into new rows. **Design:** §22. **Depends on:** 15.1.

**Technical:** upload a Waymark ZIP; validated whole before anything is written; places and check-ins made new for the importer, skipping ones already there
by id, photos through 3.2; a newer version refused with a sentence; a job for large files, with 8.1's resumable shape.

**Accepts when:** export, import into a second account, export again: the two exports match but for ids and times; importing the same file twice creates
nothing the second time.

#### 📋 15.3 — Trips in export and import

**Goal:** phase 2's data in the file. **Design:** §22. **Depends on:** 15.2, 9.6, 10.3.

**Technical:** trips where the person is an Organizer or Traveler, whole (stops, days, items, trip places, links, attachments as files; members by name
only; the person's own and shared check-ins as the journal shows them); import makes each a new trip with the importer as sole Organizer, the other members'
names kept in its description.

**Accepts when:** a trip round-trips with its plan and files, and no other member's email or unshared check-in is in the file.
