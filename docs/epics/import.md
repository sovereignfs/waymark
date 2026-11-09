# Epic 8: Import

## Status

📋 Planned.

## Overview

Years of history brought in from Swarm, so that Waymark starts full. A resumable job that reads the export, makes places and check-ins, links them, and then
fetches their photos from Foursquare's servers only. The job is general, so that later importers (`DESIGN.md` §26.2) are a reader each.

## Related

[`DESIGN.md`](../../DESIGN.md) §16, §25 Security

## Tasks

#### 📋 8.1 — Import jobs

**Goal:** a resumable import job. **Design:** §16. **Depends on:** 3.2, 1.6.

**Technical:** `import_job` (status, cursor, counts, sealed errors); the uploaded file stored sealed under `/data/imports` (3.2, kind `import`, up to
200 MB); a job that claims one import, works in steps of a bounded size, writes the cursor after each, and carries on after a restart; cancel; the file
deleted at the end; `import_finished` raised once 12.1 is in. A reader is an interface: a stream of check-ins with their places and photo addresses.

**Accepts when:** killing the process halfway and restarting finishes the import with nothing twice.

#### 🚧 8.2 — Reading a Swarm export

**Goal:** Swarm's ZIP into places, check-ins and photos. **Design:** §16. **Depends on:** 8.1, 5.2.

**Waits on:** a real Swarm export from the owner (`DESIGN.md` §28). The mapping is fixed against it, not inferred.

**Technical:** the ZIP read in a stream, never whole in memory; check-ins and venues mapped (venue to a place, de-duplicated by Foursquare venue id within
the person's places; `createdAt` and `timeZoneOffset` to the moment and zone, the zone confirmed from the point with 4.4; `shout` to the note; `with` to
companions; the Foursquare check-in id as `external_id`); fields Waymark does not keep counted and reported; each check-in through the write path with
`source = import:swarm` and auto-link (once 9.7 is in, re-run for earlier imports); photos fetched through 1.7's helper from `*.4sqi.net` and
`*.foursquare.com` over HTTPS only, redirects within them only, size-capped, two at a time, backoff, judged and re-encoded by 3.2, a failure recorded and
skipped.

**Accepts when:** the real export imports; re-running it creates nothing; a photo address on another host, a redirect off the allow-list, and a private
address are each refused; a 404 photo does not stop the job.

#### 📋 8.3 — The import screen

**Goal:** `/import`. **Design:** §16, §20.3. **Depends on:** 8.2, 7.1.

**Technical:** what an export is and how to ask Foursquare for one; upload with `FileDropzone` and `Progress`; progress while open (check-ins done,
photos fetched and failed), polled; cancel; past imports with their counts and what was not kept; reached from Settings > Data and the Check-ins empty
state; online only.

**Accepts when:** a small export imports in a browser with progress shown to the end, and the timeline shows the check-ins after.
