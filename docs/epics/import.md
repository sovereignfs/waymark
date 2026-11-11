# Epic 8: Import

## Status

📋 Planned.

## Overview

Years of history brought in from Swarm, so that Waymark starts full. A resumable job that reads the export, makes places and check-ins, links them, and then
fetches their photos from Foursquare's servers only. The job is general, so that later importers (`DESIGN.md` §26.2) are a reader each.

## Related

[`DESIGN.md`](../../DESIGN.md) §16, §25 Security

## Tasks

#### ✅ 8.1 — Import jobs

**Goal:** a resumable import job. **Design:** §16. **Depends on:** 3.2, 1.6.

**Technical:** `import_job` (status, cursor, counts, sealed errors); the uploaded file stored sealed under `/data/imports` (3.2, kind `import`, up to
200 MB); a job that claims one import, works in steps of a bounded size, writes the cursor after each, and carries on after a restart; cancel; the file
deleted at the end; `import_finished` raised once 12.1 is in. A reader is an interface: a stream of check-ins with their places and photo addresses.

**Accepts when:** killing the process halfway and restarting finishes the import with nothing twice.

**Done as, with no reader yet (8.2 adds Swarm's, so an upload is refused as "not available" until then):** `import_job` in both dialects (migration `0011_import_job`): the owner, `source`, `status` (`queued`, `running`, `done`, `failed`, `cancelled`), `phase` and `cursor`, the counts the screen shows (check-ins done and skipped, places made, photos done and failed), the file's size, a lease (`claimed_until`) and the times; **what went wrong is sealed** (`SEALED.import_job`, a sentence of ours and a count, never a line of the file). **`src/import/files.ts`: an upload is sealed in chunks of 1 MiB as it arrives** (the media store seals a file whole and holds it in memory, which is right for a photo and wrong for 200 MB), each chunk `[length][envelope]` **bound to the file's id, its place and whether it is the last, so a chunk moved, repeated, dropped, or a file cut at a chunk, or a changed byte, another key or another id does not open** (tested each way); the size is counted as it comes and the write stops, keeping nothing, the moment it passes the limit whatever the request said; a source that fails half way leaves nothing under an id; `materializeImport` opens it into a plain 0600 file chunk by chunk for a reader that must seek (a ZIP's index is at its end), which the reader removes. Files are at `<data>/imports`, made on demand inside the `/data` volume, so **the Dockerfile and `.dockerignore` are unchanged**. **`src/import/job.ts`**: a reader is an interface (`ImportReader.checkins({ file, cursor, limit })` returns items with their place, the next cursor and whether it is done), so a later importer is a reader added to `readers.ts` and nothing else. **The job claims an import by a lease in the database in one statement** (conditions in the subquery and the update, as the mail outbox's), works it in steps of 25, **renews the lease at every step and stops when the import is no longer `running`** (cancelled, or taken), and gives the lease up at the end of its 25-second budget so that the next run, or another process, carries on; it runs at the start of the process, so an import a deploy interrupted carries on at once. **A step applies its batch through the one write path (`sync/apply.ts`), as one mutation, before it moves the cursor**, so a stop or crash between the two applies the batch again, and again is harmless: **a place and a check-in have ids made from the account and the service's own id** (`idFor`), the mutation's id is made from the job and the cursor (a replay writes nothing), and **what is already here, or was deleted by the person since (the tombstone is read), is not made again**, so a second run of the same export by another job creates nothing, and **a place the person renamed keeps their name and a check-in they deleted stays deleted** (tested; the tombstones are kept 90 days, 6.7). An item that is not a valid place or check-in (a point off the globe, no id, a moment in the future) is skipped and counted; a mutation the write path refuses skips its items, and the import goes on. **Ending:** done raises one `import_finished` notice for the importer (by email too where they want it and there is mail, 12.3) and a reader that cannot read the file ends the import as failed with a sentence ("The file could not be read. Check that it is the export that service sent you…"), also told; both delete the file, **in the transaction that ends the import**. **`src/import/service.ts`**: `createImport` (one import at a time for a person, "busy" with a sentence that says to wait or cancel; a source with no reader is refused before anything is stored), `listImportsOf`, `cancelImport` (stops a waiting or running import and deletes its file; what was imported stays), `deleteImportsOf` (called by `People.deletePerson`: the files, then the rows, safe to run twice; the deletion test lists the table and seeds an import with a file for each of two people), and `sweepImports` (in the media sweep: a file no row names once an hour old, a waiting import whose file is gone ended as failed, and finished imports older than 90 days). **`/api/imports`** (`GET`: `{ available, imports }`; `POST ?source=swarm` with the file as the body, limited to ten an hour for an account, 413 for a length over 200 MB said up front and a stream cut off at the limit) and **`/api/imports/[id]`** (`DELETE` cancels), for an account only, `Origin` checked, with a test that calls each as a second person. **Seen** on a `file:` database, sqld and PostgreSQL (263 tests in the data-layer files on each; 29 in `src/import`): 60 items are three steps, seven places and sixty check-ins with the service's ids, the stream numbered seventeen changes for ten check-ins at seven places (a device pulls them), one notice; a second import of the same file creates nothing and keeps a rename and a deletion; invalid items skipped; **a stop during the second step carries on from the cursor in the next run, reading nothing twice, and the whole is made once; a worker that died after applying a batch and before writing the cursor has its batch applied again with nothing twice and the counts of what was new**; two workers at once working one import, each step once; a held import not taken until its lease ends; cancel at the next step, before it begins, and by no one but the owner; a failed read ending with a sentence, the file gone, and nothing of the error in the row or the notice; a service with no reader; the uploads refused in each way; and the files and rows removed with the person. Each safeguard was taken out in turn and seen to fail its test (the check for what is already here, the check for what was deleted). **Changed by 15.2:** a reader is opened once for a run (`open`/`checkins`/`close`), items carry their own source and photos, a reader may refuse a file with its own sentence, and a read may hold places with no check-in; see 15.2. **Left out, said plainly:** the reader itself and the photos (8.2: the table's `phase` is where photos will go, and the file is kept until the last phase ends); the screen (8.3); **a crash between applying a batch and writing its cursor makes the counts of that batch read as "already here"** (the data is right and the count is short; the alternative, one transaction with the write path, would make the write path's own transaction nest); and the cancel check in `renew` is repeated by the cursor update, on purpose.

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
