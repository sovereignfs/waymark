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

#### 📋 3.1 — Sealed rows

**Goal:** a table's sensitive fields written and read only as one envelope. **Design:** §18.1, §18.2. **Depends on:** 1.5.

**Technical:** copy Tusk's `src/crypto/` (the instance key from `WAYMARK_ENCRYPTION_KEY`, envelope encryption, binding to row and purpose, its tests);
`src/crypto/sealed.ts`: a typed declaration per table of what it seals, `seal(table, id, fields)` and `unseal(table, id, envelope)`, and a lint or test
that fails if a sealed field appears as a column or in a query condition; the table of §18.1 as the declaration's test.

**Accepts when:** a row round-trips; an envelope moved to another row's id or another table fails to open; a test reading the raw database finds no
sealed field in plain text.

#### 📋 3.2 — The media store

**Goal:** photos, attachments and uploads stored, sealed and served by Waymark. **Design:** §9.3, §10.6, §18.3. **Depends on:** 3.1, 1.6.

**Technical:** `media` and `/data/media`; upload routes judging files by their bytes (an allow-list per kind), `sharp` for images (orient, strip every
piece of metadata, WebP at 2,560 px and a 480 px thumbnail; HEIC and AVIF read), PDFs kept as they are; each file sealed with its own data key, named by a
random id; `/api/media/<id>` after an access check passed in by the caller's domain (own rows now; trips with 9.5 and 10.3), with `Cache-Control:
private`, `nosniff`, a sandboxing CSP for a PDF; `WAYMARK_MEDIA_MAX_ACCOUNT_MB` (default 500, a setting like every limit, §10.8) counted on what is stored; delete by owner and id; an orphan
sweep job. Uploads accept a device-made id (6.5) and are idempotent on it.

**Accepts when:** an HTML file named `.jpg` is refused; a JPEG's location metadata is gone after upload; a file on disk is unreadable without the key; a
second person gets not found for a file; going over the limit is refused with a sentence; an orphan is swept.

#### 📋 3.3 — Rotating the key

**Goal:** a new instance key without losing anything. **Design:** §18.1. **Depends on:** 3.1, 3.2.

**Technical:** `WAYMARK_ENCRYPTION_KEY_PREVIOUS` read beside the key; a job re-wraps every row's and file's data key under the new key, in batches, with a
cursor; health says when rotation is in progress; the README's procedure.

**Accepts when:** after a rotation and the old key removed, every row and file opens; a rotation interrupted halfway resumes and finishes.
