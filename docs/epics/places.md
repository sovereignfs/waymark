# Epic 4: Places and the map

## Status

📋 Planned.

## Overview

Places of a person and of a trip, found through the operator's place search from the server only, with their time zone known from their point; and the
tile service that lets the browser draw an OpenStreetMap map with nothing loaded from elsewhere. The `Map` component itself is built in `sovereign` (17.1).

## Related

[`DESIGN.md`](../../DESIGN.md) §7, §8, §25 Security

## Tasks

#### ✅ 4.1 — Places

**Goal:** a person's places, sealed, findable in memory. **Design:** §7.1, §18.1. **Depends on:** 3.1, 4.4.

**Technical:** `place` with exactly one of `account_id` and `trip_id` (trip places join with 9.2); name, point, address parts, category and source id
sealed; `tz` and `country_code` readable; operations: make, rename, recategorize, move, merge into another (moving check-ins), delete with no check-ins;
`src/places/match.ts`, the one rule for "the same place" (source id, or the same name within 50 metres), pure, used by copying a trip place (13.2), the
journal (11.5) and import (8.2); search over a person's places by name and distance, in memory after unsealing.

**Accepts when:** a second person gets not found for a place; merge moves every check-in; the match rule's fixtures hold, including two cafés of one name
60 metres apart.

**Done as:** `place` in both dialects (migration `0004_places`): `id`, `account_id`, `trip_id` (exactly one is set; only `account_id` is written from here, a trip's places come with 9.2), `source` (`manual`, `osm`, `import`), `tz`, `country_code`, `version`,
`seq`, `sealed` (name, point, address parts, category, source id: `SEALED.place`, as declared in 3.1), `created_at`, `updated_at`, indexed by owner and `seq`. `src/places/places.ts`, the one file that writes or reads `place.sealed`:
`makePlace` (finds the zone from the point, 4.4, and the country from the address; the device's own id makes a replay a no-op, and an id that is another account's is `id_taken`), `getPlace`, `listPlaces`, `findPlaceLike`, `updatePlace` with
`renamePlace`, `recategorizePlace` and `movePlace` (a move finds the zone again unless one is given; a zone a person corrected survives a rename; written against the `version` it read, so two changes at once lose neither),
`mergePlace` (every row of the person that names the first place names the second, and the first is deleted, in one transaction; both must be the person's), `deletePlace` (one statement with a `NOT EXISTS` for every table that names a place, so a
place with check-ins is `in_use`), `deletePlacesOf`. Every statement names `account_id`, so another person's place is `not_found`. `src/places/match.ts` is the one "same place" rule (`isSamePlace`, `findSamePlace`, `distanceMetres`,
`normalizeName`: no accents, case or punctuation); `src/places/search.ts` is the search by name, category and address, nearest first, in memory. `People.deletePerson` removes a person's places, and its test seeds two for each person and keeps a
table that is decided nowhere from passing. **What names a place** is `PLACE_REFERENCES` (empty until 5.2 makes `checkin`), and a test reads the schema and fails for a table with a `place_id` that is in neither it nor `TRIP_REFERENCES`: merging
and deleting are tested with a scratch table standing in for check-ins, and the real one joins the list in its own change. **Seen:** the second person gets `not_found` from get, update, merge (either side) and delete, and a replay of an id they
took; the stored row has no name, point or address in a column or readable in the envelope, and an envelope moved to another row does not open; the 50 m rule's fixtures, two cafés of one name 60 m apart among them; the whole suite on a `file:`
database, sqld and PostgreSQL (517 tests each). Each safeguard was taken out in turn and seen to fail its test (the owner in a read, the check for what points at a place, the owner on a merge's moves, both places being the person's). **Left out:**
`seq` is 0 until the one write path of sync assigns it (6.1), and there is no route or operation yet (the screens, 7.x, and sync, 6.x, call these); the export and import of places join the task that makes them (§22).

#### ✅ 4.2 — Finding a place

**Goal:** `/api/places` search and reverse lookup through the operator's provider. **Design:** §7.2. **Depends on:** 4.1, 1.7.

**Technical:** `WAYMARK_PLACES_PROVIDER` (`nominatim` default, `photon`, `off`) and `WAYMARK_PLACES_URL` (default the public Nominatim); adapters to one
candidate shape (name, point, address parts, category, source id); the person's places first, then the provider's; for the public Nominatim, one request a
second from the whole server (a claim in the database, so several processes share it), a User-Agent naming Waymark and `WAYMARK_URL`, results cached a day,
queries of three characters or more after a pause; through 1.7's outbound helper; provider down or `off` said plainly; a local fake for tests and
`pnpm dev`. No search text, name or point in a log.

**Accepts when:** against the fake, search and reverse return candidates in order; two processes searching at once keep to one request a second to the
public instance; with `off`, the manual way works and says why search does not.

**Done as:** the settings `WAYMARK_PLACES_PROVIDER` (`nominatim`, `photon`, `off`) and `WAYMARK_PLACES_URL`, in `src/places/config.ts` and `Config.places`: no address means the public instance of the provider (Nominatim's, or Photon's at
`photon.komoot.io`), **known by its host name**, so that writing its address with another scheme does not lift its policy, and http is refused for it; an address of the operator's own may be http and on a private network (the outbound helper's `allowHttp`
and `allowPrivate`, for that one host only), and lifts the policy. `src/places/providers.ts`, pure: the two adapters read each provider's answer into one **candidate** (name, point, address parts, category, `osm` and `node/123`-style id, **the same from either provider**,
so a place found by one is the same place as one found by the other), refusing an entry with no point, id or name, never more than eight, and an answer that is not one (a page of HTML from a proxy) is "unavailable" and not "nothing found". `src/places/finder.ts`:
`PlaceFinder.search` and `.reverse` through `outbound()`, to the configured host only; for the public instance **one request a second from the whole server** (a lease in `job_claim`, `claimJob`, so several processes share one clock, and a request that cannot
have its turn in eight seconds says the search is busy), **a day's cache** in memory under the asked text, **the same thing asked at once is one request**, a failure is never kept, and a User-Agent `Waymark (<WAYMARK_URL>)`, never a person. A search under three characters is not
sent (the pause before asking is the screen's, 7.2). `src/places/http.ts` and `app/api/places/route.ts`: `GET /api/places?q=` answers `{provider, status, mine, found}`, the person's own places first (searched in memory, nearest first if `lat` and `lng` are given, which are **not sent to the
provider**) and then the provider's without the ones the person has by the "same place" rule; `GET /api/places?lat=&lng=` answers what is at a point and the person's place that is the same; `status` is `ok`, `off`, `unavailable` or `too_short`, and `mine` is answered
whatever the provider did. For an account only (`accountRoute`, listed in `routes.ts`), sixty a minute each, `Cache-Control: no-store`. **The fake:** `src/places/fake.ts` answers as Nominatim and as Photon from six real places and reaches nothing; the tests start one,
and `pnpm places:fake` runs it on port 3990 for `pnpm dev` (`WAYMARK_PLACES_URL=http://127.0.0.1:3990`, in `.env.example`). The browser tests are given `off`, so none reaches a search on the internet. **Seen:** against the fake, search and reverse return candidates in the provider's order for
Nominatim and Photon; four searches from two finders sharing one database are at least 0.95 s apart and take at least 2.9 s; a second ask for the same thing sends nothing until a day has passed; a refused, failed or non-answer is "unavailable" and the next ask
goes out; `off` sends nothing and still answers the person's own places; a host that is not the configured one, and a private address that the operator did not name, are refused; a second person gets none of the first's places in `mine` or in what is found. Each safeguard was taken out in turn
and seen to fail its test (the turn, the cache, removing what the person has, the public host known by its name). **Left out:** the provider's own `Accept-Language`, and a bias of search toward the person's position (it would send a point to a third party, §7.2); the screen that searches is 7.2.

#### ✅ 4.3 — The tile service

**Goal:** style, tiles, glyphs and sprites served by Waymark. **Design:** §8.1, §8.2. **Depends on:** 1.10, 1.6.

**Technical:** `WAYMARK_MAP_SOURCE` (`proxy` default, `pmtiles`, `off`), `WAYMARK_MAP_UPSTREAM_URL`, `WAYMARK_MAP_PMTILES_PATH`, `WAYMARK_MAP_CACHE_MAX_MB` (2048);
`/api/map/style/<theme>.json` (Waymark's light and dark styles in `--sv-*` colours, pointing at Waymark's own URLs only), `/api/map/tiles/{z}/{x}/{y}`,
`/api/map/glyphs/…`, `/api/map/sprites/…`; proxy through 1.7's helper with a disk cache under `/data/map/cache`, pruned oldest-read first by a job;
PMTiles read by range from the file; signed in only, rate-limited per account; attribution in the style. **First:** read the candidate upstream's terms
(OpenFreeMap) and record the choice in the README; decide whether glyphs and sprites ship in the image or are proxied, by their size; check the fonts'
licence.

**Accepts when:** a map renders from each source with no request off the app's origin; the cache stays under its limit; with `off`, every map route
answers 404 and the app shows lists.

**Done as:** the settings `WAYMARK_MAP_SOURCE` (`proxy`, `pmtiles`, `off`), `WAYMARK_MAP_UPSTREAM_URL`, `WAYMARK_MAP_PMTILES_PATH` and `WAYMARK_MAP_CACHE_MAX_MB` (`src/map/config.ts`, `Config.map`; the public host is known by its name, so its address written another way is not the operator's own and is refused over http). **First, as the task said:** OpenFreeMap's terms
were read (openfreemap.org/tos): no stated request limit, no service level, bulk fetches must identify themselves, and **nothing about a server fetching and keeping tiles for its users**, so the default is chosen with that said plainly in the README's "The map" (use `pmtiles` or one's own server for
anything that matters; ask OpenFreeMap before relying on it) and in `DESIGN.md` §8.1 and §28 item 2, which stays open until they answer. **Glyphs and sprites, by their size:** a Noto Sans Regular and Bold pair for Latin, Greek, Cyrillic and punctuation is 1.2 MB and ships in the image (`src/map/assets/fonts`, taken from
OpenFreeMap's build, SIL OFL 1.1, whose `OFL.txt` is in the image); the rest of the scripts are tens of megabytes, so any other range is the default upstream's, proxied and cached like a tile, for `proxy` only, and a label in another script shows its Latin name, which the style prefers. **No sprites:** the style draws with shapes and
text alone, so there is nothing to serve and no `/api/map/sprites` route (a marker is the `Map` component's, 17.1). `src/map/style.ts`: a light and a dark style for the OpenMapTiles schema, every colour a design-system token written as its value, and `style.test.ts` reads the design system's own CSS and fails if one drifts; it names Waymark's own tile and glyph addresses and no one
else's, and carries the attribution (OpenStreetMap contributors, OpenMapTiles, and OpenFreeMap for the public tiles). `src/map/service.ts`: `proxy` reads the upstream's TileJSON (looked at again each hour, the last address that worked kept on disk so a restart while it is out of reach still serves what is kept; its tiles must be on the host the setting names), keys the cache by that address so a new planet is new
tiles, fetches a tile once and keeps it, collapses the same tile asked for at once to one request, and names Waymark and the instance in its User-Agent; `pmtiles` (`src/map/pmtiles.ts`, over the `pmtiles` package, BSD-3) reads by range from a file in the OpenMapTiles schema and asks no one; `off` serves nothing. `src/map/cache.ts`: keys cannot leave the directory, files are written whole and renamed, a read marks a file as read now,
and `prune` removes the files read longest ago down to 90 % of the limit; the `prune-map-cache` job runs it every ten minutes under a lease. Routes `/api/map/style/<theme>.json`, `/api/map/tiles/{z}/{x}/{y}` and `/api/map/glyphs/{fontstack}/{range}.pbf`: for an account only (`accountRoute`, in `routes.ts`), fifteen hundred a minute each, an empty tile is `204`, an upstream out of
reach is `503` with `Retry-After`, and with the map off every one is `404`. The standalone build carries the bundled glyphs (`outputFileTracingIncludes`). **Seen:** against a fake upstream, a tile is fetched once and then read from disk, a new version is kept apart, a failure or a missing tile is never kept, a TileJSON naming another host is refused, three asks at once are one request; a PMTiles file
made for the test (uncompressed, gzip inside, missing, not PMTiles, raster) is read with no request to anyone, and a file put there later starts to work; the cache stays under its limit and keeps what is read; **in a browser, on the built standalone server (`e2e/map.spec.ts`)**, a signed-in person gets both styles, a tile, an empty gap and the glyphs, a visitor gets 401, and nothing in any of it names another host. Each safeguard was taken out in turn and seen to fail its test (the host of a
TileJSON, the font list, the order of pruning, the path of a cache key, a colour that is not its token). **In the image:** built, with the fonts at `/app/src/map/assets/fonts` and `OFL.txt` under `/usr/share/licenses/noto-sans`, and `scripts/deploy-check.sh` ended `all setups ok` (amd64 only; the `image` job on GitHub is not run). **Left out:** the `Map` component that draws it is 17.1 in `sovereign`; the trip's tiles kept for offline are 13.5; the service worker keeps no tile yet.

#### ✅ 4.4 — Time zones from points

**Goal:** a point's IANA zone, on the server and the device, with no network. **Design:** §7.3. **Depends on:** 1.2.

**Technical:** a bundled boundary lookup (`tz-lookup` or a successor; licence and size checked), in `src/places/tz.ts`; pure helpers for a moment's local
date and offset in a zone (`Intl`), shared by auto-link (9.7), today (13.1) and the timeline.

**Accepts when:** fixtures hold for points either side of a zone border and the date line, and a moment at 23:59 and 00:01 local lands on the right date.

**Done as:** `src/places/tz.ts`, new (Tusk's `time.ts` is a different thing): `zoneOf(lat, lng)` over **`tz-lookup` 6.1.25** (CC0, 150 KB, pinned; no network, no types, so `types/tz-lookup.d.ts`), `undefined` for a point not on the globe;
`isZone`; and the pure helpers over `Intl`: `partsOf`, `localDate`, `localTime`, `offsetMinutes` (minutes east, quarter hours and changes of clock included), `inZone`, and `momentOf(date, time, zone)`, the inverse, taking the first of a
time that happens twice and the moment the clock reaches for one that never happens. None reads a clock. **Seen:** fixtures for Tokyo, Lisbon, Reykjavík, Sydney, Kathmandu and Honolulu; either side of the Portugal–Spain border (Elvas and
Badajoz); Kiritimati (+14) against Honolulu, Apia and Tongatapu, and Fiji's island that the 180th meridian crosses; sea, the poles and invalid points; 23:59 and 00:01 across Auckland's midnight in four zones; the clocks going back and
forward in New York; `pnpm test:zones` runs the module's tests under `TZ=UTC`, `Pacific/Auckland` and `America/Los_Angeles` and CI runs it. **Limits, said plainly:** (1) `tz-lookup` is a simplified boundary table: near a border and
in small territories it can be wrong (it answers `Pacific/Apia` for American Samoa, which is `Pacific/Pago_Pago`), so a place's zone is a default that a person can correct, and the fixtures hold only where the table is right. (2) Its data
is Evan Siroky's timezone-boundary-builder, which is ODbL: the package says CC0, and the attribution belongs in the README's notices when 16.3 writes them (`DESIGN.md` §25 Licence). (3) `Intl` knows the zones the runtime's ICU does.
