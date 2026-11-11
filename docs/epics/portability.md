# Epic 15: Portability

## Status

📋 Planned.

## Overview

A person can take what is theirs and bring it to another Waymark: one ZIP of JSON and files, built by a job. Phase 1 covers places and check-ins; phase 2 adds
trips. This is the app's own format, separate from the Swarm import (epic 8).

## Related

[`DESIGN.md`](../../DESIGN.md) §22

## Tasks

#### ✅ 15.1 — Export

**Goal:** a person's data in one file. **Design:** §22. **Depends on:** 5.3, 1.6.

**Technical:** a job builds a ZIP: `waymark.json` (`format`, `version`, profile, settings, places, check-ins with companions and links) and the photos as files;
stored sealed under `/data/exports`, downloadable from Settings > Data within a day, then deleted; no one else's email; noted on core's activity page once
14.1 is in.

**Accepts when:** an export of a seeded person holds every place, check-in and photo, and its JSON validates against the format's schema.

**Done as, for phase 1's data (trips join in 15.3):** **`src/portability/format.ts`**, the one definition of the file, used to write it and (15.2) to read it: `format: "waymark-export"` and a `version` first; the profile (name, units, first day of the week, sharing default: **no address**), the choices of what is emailed, `places`, `checkins` (with companions, source, the import's own id, and the ids of their photos) and `photos` (`{ id, file, type }`). `parseExport` checks a file **whole before anything is written**: the format and version first (a different format is "not a Waymark export"; a higher version is refused with "update Waymark, or export again from this version"), then **every place and check-in by the same rules a device's change meets** (`checkins/validate.ts`), then that it hangs together (ids that are ids and not repeated, every check-in at a place the file has, a photo on one check-in at most, every listed photo a file named `photos/<uuid>.<webp|jpg|png>` and named by a check-in, at most 500,000 of each), and its sentences repeat nothing of the file. **`export_job`** (migration `0013_export_job`: owner, status `queued`, `running`, `ready`, `failed` or `expired`, size, times and a lease; nothing in the row says what is in the file). **`src/portability/export.ts`**: a person asks (one at a time; a second while one is queued or running is "busy"), a worker **claims it by a lease** in one statement as the import's and the mail's are, and builds the ZIP **as a stream into a sealed file of its own** under `<data>/exports` (the same chunked sealing as an uploaded import, bound to the file's id and each chunk's place, so a decade of photos is never whole in memory and a file touched on disk does not open); **the photos are written first, each as the file it is, and `waymark.json` last, listing exactly what was written**, so a photo that went between the list and the file is never named and missing; a photo taken offline that has not reached the server is not in the file and its check-in still names it (an import tolerates that); the lease is kept every 25 photos. It is **ready for 24 hours** and then not downloadable even before the sweep, which deletes the file and marks it expired (the record stays a week); a file no request names is swept once it is an hour old; a build that throws ends as failed with its file removed and logs nothing of the data. `People.deletePerson` removes a person's exports, files and rows (the deletion test lists the table and seeds a built export for each of two people). **`/api/exports`** (`GET` list; `POST` asks, five an hour for an account, 409 with a sentence while one is being made) and **`/api/exports/[id]`** (`GET` streams the ZIP from the sealed file a chunk at a time as an attachment, `private, no-store`, `nosniff`, and a policy that lets nothing in it run; `DELETE`), for an account only, `Origin` checked on a write, with a test that calls each as a second person: **another person's export, one that is not ready, one that has run out and one that never was are the same answer, not found**. **Settings > Data** has an _Export my data_ button, a list that looks every three seconds while one is made, _Download_ and _Delete_. **My own ZIP writer and reader (`src/portability/zip.ts`), because the first one did not do what the format needs:** the streaming writer of the library tried first (`fflate`) writes the number of entries in 16 bits and no ZIP64 end record, so an archive of 70,000 files read back with 4,464 (found by writing 70,000 and asking `zipinfo -h`, and the system `unzip` found them all only by scanning), which would have silently dropped photos from the exports of the people with the most. The writer stores a file whole (so its size and checksum are known and no data descriptor is needed), stores photos and deflates the JSON, and writes the ZIP64 end record for more than 65,535 entries and a directory or offset past 4 GB; the reader opens a file on disk by its directory, never whole in memory, reads ZIP64, **refuses encryption, any method but stored and deflate, a repeated name and a directory that points past the file, refuses an entry larger than the caller allows before expanding it, bounds what an entry may expand to (a zip bomb whose small stored size hides a huge one is refused), and checks every size and checksum**; 15.2 and the Swarm reader (8.2) use it. `fflate` stays as a **development dependency** only, an independent reader and writer to check this one against. **Seen** on a `file:` database, sqld and PostgreSQL (230 tests in the data-layer files on each; 32 in `src/portability`): the file holds every place, check-in and photo of a seeded person and its JSON passes `parseExport`; a photo's bytes equal what the server holds; the photo that never uploaded is named and not in the list; **the file holds nothing of a second person (their places, notes, photo, name or address) and no address at all, the person\'s own included**, and the second person\'s own export holds hers and none of the first\'s; the file on disk is unreadable and not a ZIP without the key; one at a time for a person and another not held up; two workers at once build it once; owner only, ready only, within the day only; deleted at once by the owner and by no one else; removed with the person; a build that cannot be made ends failed with no file; the ZIP written and read back, read by `fflate` and found sound by `unzip -t`, an archive written by another writer read, **70,000 entries written with the ZIP64 end record and read back whole, and `zipinfo` says 70,000**, a changed byte caught by the checksum, a bomb, an over-large claim, encryption, an unknown method and a repeated name refused; **in Chromium (`e2e/export.spec.ts`):** a person checks in, asks in Settings > Data, waits for it, downloads `waymark-export-<date>.zip`, and the JSON holds that place and check-in and no address; then deletes it. Each safeguard was taken out in turn and seen to fail its test (the ZIP64 record, the owner in the download). **Found while doing it:** a browser test of the notices that built "yesterday" as 1.2 days ago failed between midnight and 05:00, when that is the day before; it uses yesterday at noon. **Left out:** a line on core\'s activity page (14.1), trips (15.3), and offsets past 4 GB, which the writer and reader handle by the format but which no test writes (it would need 4 GB of data); WebKit was not run.

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
