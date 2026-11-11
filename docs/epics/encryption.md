# Epic 3: Encryption and media

## Status

📋 Planned.

## Overview

Everything in Waymark that says where someone was or what they wrote is sealed at rest under the app's key, and every file is Waymark's own, sealed on disk.
**Server-side envelope encryption** (the owner's decision): Tusk's envelope, copied, with one `sealed` column per row and one data key per row or file.
This epic comes before any product table, so that no place or note is ever written in plain text.

## Related

[`DESIGN.md`](../../DESIGN.md) §9.3, §18, §24.3 · Tusk's `src/crypto/`

## Tasks

#### ✅ 3.1 — Sealed rows

**Goal:** a table's sensitive fields written and read only as one envelope. **Design:** §18.1, §18.2. **Depends on:** 1.5.

**Technical:** copy Tusk's `src/crypto/` (the instance key from `WAYMARK_ENCRYPTION_KEY`, envelope encryption, binding to row and purpose, its tests);
`src/crypto/sealed.ts`: a typed declaration per table of what it seals, `seal(table, id, fields)` and `unseal(table, id, envelope)`, and a lint or test
that fails if a sealed field appears as a column or in a query condition; the table of §18.1 as the declaration's test.

**Accepts when:** a row round-trips; an envelope moved to another row's id or another table fails to open; a test reading the raw database finds no
sealed field in plain text.

**Done as:** `src/crypto/keys.ts` was 1.4's. `src/crypto/envelope.ts` and its test are copied from Tusk (the text form, kept for a credential such as core's refresh token, 2.3) and
**extended with a binary form**: `sealBytes`, `openBytes`, `rewrapBytes` and `fingerprintOfEnvelope`, an envelope of `0x01`, the key's fingerprint, the wrapped data key's length, the wrapped
key and the payload, with a domain of its own (`waymark:sealed:…`) and the table and row id in the authenticated data of both layers; it is what a `sealed` column and (3.2) a sealed file
hold. `src/crypto/sealed.ts` is new: `SEALED` declares, for every table of §24.3 that has sealed fields (phase 1's six, and phase 2 and 3's declared ahead of their tables), each field and its kind
(`string`, `number`, `strings`, `json`, optional or not), `Sealer.seal(table, id, fields)` and `unseal(table, id, envelope)` check against it both ways and bind the envelope to the table and the id, and
the field types are derived from the declaration. `src/crypto/server.ts` is the server's sealer from the required instance key. **Tests** (`sealed.test.ts`): every table round-trips with all its fields and
with only the required ones, an envelope does not open as another row or another table, a field the table does not seal or a value of the wrong kind is refused naming the field and never the value,
and the declaration is held to the words after `(s)` in `DESIGN.md` §24.3 (it fails if the design is edited and the declaration is not); the schemas of both dialects are held to it (a table has a `sealed`
column only if it is declared, no sealed field is ever a column, the `sealed` column is in no index or key), the source is read for a `sql` template that puts `sealed` in a `WHERE`, `ORDER BY`,
`GROUP BY`, join or index, and the raw database is read on each form (a row written through the sealer holds none of its words, in the rows as returned and, on a file, in the file and its log).
**Seen to fail:** with the payload layer's binding removed (the layer's own test), with a planted table whose sealed field is a column, and the source reading against planted statements; 403 tests pass on a `file:`
database, sqld and PostgreSQL. Left out: the credential store of Tusk's `store.ts` and `tables.ts` (the `credential` table comes with 2.3), and the rotation (3.3).

#### ✅ 3.2 — The media store

**Goal:** photos, attachments and uploads stored, sealed and served by Waymark. **Design:** §9.3, §10.6, §18.3. **Depends on:** 3.1, 1.6.

**Technical:** `media` and `/data/media`; upload routes judging files by their bytes (an allow-list per kind), `sharp` for images (orient, strip every
piece of metadata, WebP at 2,560 px and a 480 px thumbnail; HEIC and AVIF read), PDFs kept as they are; each file sealed with its own data key, named by a
random id; `/api/media/<id>` after an access check passed in by the caller's domain (own rows now; trips with 9.5 and 10.3), with `Cache-Control:
private`, `nosniff`, a sandboxing CSP for a PDF; `WAYMARK_MEDIA_MAX_ACCOUNT_MB` (default 500, a setting like every limit, §10.8) counted on what is stored; delete by owner and id; an orphan
sweep job. Uploads accept a device-made id (6.5) and are idempotent on it.

**Accepts when:** an HTML file named `.jpg` is refused; a JPEG's location metadata is gone after upload; a file on disk is unreadable without the key; a
second person gets not found for a file; going over the limit is refused with a sentence; an orphan is swept.

**Done as:** written for Waymark (Tusk has no media): `src/media/detect.ts` (the allow-list by bytes: JPEG, PNG, WebP, GIF, AVIF, HEIC for a photo; those and PDF for an attachment; ZIP for an import; a thumbnail is
never uploaded), `images.ts` (`sharp`: upright by orientation, every piece of metadata gone, WebP at most 2,560 px, a 480 px thumbnail, decoding bounded to 100 megapixels), `files.ts` (`<data>/media/<uuid>`,
one envelope per file under a data key of its own, bound to the id; written to a temporary name and moved), `service.ts` (`putMedia` idempotent on a device-made id and refused as not found for another owner's, the 15 MB
cap and the account's limit counted on what is stored including thumbnails, `readMedia` and `deleteMedia` with the owner in the statement, `sweepOrphans`), `http.ts` (a body cut off at the limit whatever its
`Content-Length` said, the headers a file is served with: the stored type, `nosniff`, `private`, `default-src 'none'; sandbox`), and the routes `POST /api/media?kind=`, `PUT /api/media/<id>?kind=`, `GET` and
`DELETE /api/media/<id>`, each an `accountRoute` limited to 60 uploads a minute and in `src/access/routes.ts`. `media` is the app store's `0003_media` (owner, kind, type, bytes, state; its file's id is the row's and
a photo's thumbnail's is derived from it, `thumbIdOf`). A `sweep-media` job runs hourly under a lease. **A new setting, `WAYMARK_DATA_DIR`** (default `/data`; and `WAYMARK_MEDIA_MAX_ACCOUNT_MB`, default 500), in the
config, `.env.example`, `DESIGN.md` §25 and the e2e instances; **`/api/health` now answers 503 unless the data directory is writable**, and `boot-check` gives it a temporary one. `sharp` is installed (the
install script was allowed in 1.10), and its and libvips's licences are collected in the image (the Dockerfile stops if either is missing; **not yet built**, see 1.10). **Seen to fail** with the allow-list removed, with the orientation
step swapped for one that keeps metadata, and (in the earlier test) with the binding removed; 451 tests pass on a `file:` database, sqld and PostgreSQL; the browser tests add a photo, read it back as WebP with the
right headers, refuse an HTML page named `.jpg` with a sentence, replay a device-made id (201 then 200), and give a visitor 401 and a foreign origin or none 403. **Decisions and limits:** (1) **HEIC:** sharp's prebuilt
libvips carries AVIF's decoder and not HEIC's (HEVC is patent-encumbered and left out), so a HEIC file is recognised by its bytes and refused with the sentence "share it as a JPEG"; iOS Safari converts a photo to JPEG when a person chooses it
in a file input, so the phone's own path is unaffected, and the design's "HEIC read" is open until a build that decodes it is chosen (`DESIGN.md` §28). (2) The limit is checked, then the row made: two uploads at once can pass it together by one file. (3) What
a photo is referenced by (a check-in's photo list) is not known here, so the sweep removes only rows that never got their file and files with no row; the reference joins with 5.3 and 9.5. (4) Another person's file is tested at the
service, where a second account can be made; the browser instance is closed to one.

#### ✅ 3.3 — Rotating the key

**Goal:** a new instance key without losing anything. **Design:** §18.1. **Depends on:** 3.1, 3.2.

**Technical:** `WAYMARK_ENCRYPTION_KEY_PREVIOUS` read beside the key; a job re-wraps every row's and file's data key under the new key, in batches, with a
cursor; health says when rotation is in progress; the README's procedure.

**Accepts when:** after a rotation and the old key removed, every row and file opens; a rotation interrupted halfway resumes and finishes.

**Done as:** `WAYMARK_ENCRYPTION_KEY_PREVIOUS` was read beside the key since 1.4 (`KeyRing.previous`); this is the job that uses it. **`src/crypto/rotate.ts`** moves everything sealed from the old key to the new **without opening any of it**: an envelope is a data key wrapped under the instance key and a payload sealed under the data key, so only the wrapping is done again, bound to the same row or file, and the payload (most of the bytes) is not read, changed or logged. It walks, in order, the `sealed` column of **every table that has one** (profile, place, check-in, notice, mail outbox, import job: a test holds the list to `SEALED`'s), then the **files under `/data/media`**, then the **sealed files of imports and exports**, which are chunked and are moved a chunk at a time into a file of their own (each chunk keeps its binding, its place and whether it is the last), in batches of 200 rows or files by the order of their key. **An envelope is replaced only if the row is still as it was read**: by a plain column that changes whenever the row is written (`version` for places and check-ins, `updated_at` for a profile and an import), a row the app writes meanwhile being sealed under the new key already, so **it is never overwritten with the older version** (tested with a person renaming a place after the job read it and before it wrote; the test fails without the check); a file is replaced only if its modification time is what it was when read. The envelope itself is never in a condition (the guard test that keeps a sealed field out of any `WHERE` found a first draft that compared the old bytes, and is why the plain columns are used). **Progress is in `key_rotation`** (migration `0014_key_rotation`: the fingerprint of the key being rotated to, the one it is rotating from, `running` or `done`, the phase and the place in it, how many were moved and how many could not be opened): the job (`rotate-keys`, every 30 seconds and at the start, under a lease so that one process of several does it, doing nothing without a previous key) saves after every batch, so **a stop, a crash or a deploy carries on from there and not from the start**; a finished rotation is not run again. **What cannot be moved is counted and does not stop the rest:** an envelope under a key that is neither the old nor the new is `unopenable`, in the count the log gives and the table keeps. **Health:** `GET /api/health` says `"keyRotation": "in_progress"` while a previous key is given and the rotation is not done, and `"complete"` when it is (the cue that the previous key can be removed), and says nothing of keys otherwise; the log says how many were moved and, at the end, that the previous key can be removed. **The README has the procedure** (the steps, not to start another rotation before one is complete since the ring holds two keys, and to keep the old key as long as a backup made before the rotation is kept). **Seen** on a `file:` database, sqld and PostgreSQL (243 tests in the data-layer files on each; 7 in `src/crypto/rotate.test.ts`): everything seeded under the old key (a profile, a place, a check-in with its note and companions, a notice, mail waiting, an import with its file, a photo, and a file of three chunks) opens with the old key and not with the new, and with both in the ring; a rotation **stopped after four batches of one** has some under the new key, everything opens with the two keys, and a later run finishes it; afterwards **every envelope names the new key, and everything opens with the old key removed** (the chunked file's every frame included, and it is byte for byte what it was); a second run and a run with no previous key do nothing; a row sealed under a third key is counted and the rest moves. **Left out:** the credential store (core's refresh token, phase 2) joins the phases when it exists; health is not tried in a browser against an instance given a previous key (the state is tested, and the route adds one field to its answer); and a rotation begun before another is complete is a mistake the README says not to make and the job cannot undo.
