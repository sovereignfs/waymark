# Epic 4: Places and the map

## Status

📋 Planned.

## Overview

Places of a person and of a trip, found through the operator's place search from the server only, with their time zone known from their point; and the
tile service that lets the browser draw an OpenStreetMap map with nothing loaded from elsewhere. The `Map` component itself is built in `sovereign` (17.1).

## Related

[`DESIGN.md`](../../DESIGN.md) §7, §8, §25 Security

## Tasks

#### 📋 4.1 — Places

**Goal:** a person's places, sealed, findable in memory. **Design:** §7.1, §18.1. **Depends on:** 3.1, 4.4.

**Technical:** `place` with exactly one of `account_id` and `trip_id` (trip places join with 9.2); name, point, address parts, category and source id
sealed; `tz` and `country_code` readable; operations: make, rename, recategorize, move, merge into another (moving check-ins), delete with no check-ins;
`src/places/match.ts`, the one rule for "the same place" (source id, or the same name within 50 metres), pure, used by copying a trip place (13.2), the
journal (11.5) and import (8.2); search over a person's places by name and distance, in memory after unsealing.

**Accepts when:** a second person gets not found for a place; merge moves every check-in; the match rule's fixtures hold, including two cafés of one name
60 metres apart.

#### 📋 4.2 — Finding a place

**Goal:** `/api/places` search and reverse lookup through the operator's provider. **Design:** §7.2. **Depends on:** 4.1, 1.7.

**Technical:** `WAYMARK_PLACES_PROVIDER` (`nominatim` default, `photon`, `off`) and `WAYMARK_PLACES_URL` (default the public Nominatim); adapters to one
candidate shape (name, point, address parts, category, source id); the person's places first, then the provider's; for the public Nominatim, one request a
second from the whole server (a claim in the database, so several processes share it), a User-Agent naming Waymark and `WAYMARK_URL`, results cached a day,
queries of three characters or more after a pause; through 1.7's outbound helper; provider down or `off` said plainly; a local fake for tests and
`pnpm dev`. No search text, name or point in a log.

**Accepts when:** against the fake, search and reverse return candidates in order; two processes searching at once keep to one request a second to the
public instance; with `off`, the manual way works and says why search does not.

#### 📋 4.3 — The tile service

**Goal:** style, tiles, glyphs and sprites served by Waymark. **Design:** §8.1, §8.2. **Depends on:** 1.10, 1.6.

**Technical:** `WAYMARK_MAP_SOURCE` (`proxy` default, `pmtiles`, `off`), `WAYMARK_MAP_UPSTREAM_URL`, `WAYMARK_MAP_PMTILES_PATH`, `WAYMARK_MAP_CACHE_MAX_MB` (2048);
`/api/map/style/<theme>.json` (Waymark's light and dark styles in `--sv-*` colours, pointing at Waymark's own URLs only), `/api/map/tiles/{z}/{x}/{y}`,
`/api/map/glyphs/…`, `/api/map/sprites/…`; proxy through 1.7's helper with a disk cache under `/data/map/cache`, pruned oldest-read first by a job;
PMTiles read by range from the file; signed in only, rate-limited per account; attribution in the style. **First:** read the candidate upstream's terms
(OpenFreeMap) and record the choice in the README; decide whether glyphs and sprites ship in the image or are proxied, by their size; check the fonts'
licence.

**Accepts when:** a map renders from each source with no request off the app's origin; the cache stays under its limit; with `off`, every map route
answers 404 and the app shows lists.

#### 📋 4.4 — Time zones from points

**Goal:** a point's IANA zone, on the server and the device, with no network. **Design:** §7.3. **Depends on:** 1.2.

**Technical:** a bundled boundary lookup (`tz-lookup` or a successor; licence and size checked), in `src/places/tz.ts`; pure helpers for a moment's local
date and offset in a zone (`Intl`), shared by auto-link (9.7), today (13.1) and the timeline.

**Accepts when:** fixtures hold for points either side of a zone border and the date line, and a moment at 23:59 and 00:01 local lands on the right date.
