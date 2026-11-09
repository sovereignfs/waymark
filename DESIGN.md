# Waymark — design

**Status:** draft, written on 2026-11-09 from the legacy `sovereign-plugin-travellog` (manifest 0.28.0), Tusk's and Tally's designs, and the owner's
direction in planning. Nothing is built. Where this file and a contract Sovereign publishes disagree, the contract wins (`AGENTS.md`, Source of truth).
§28 holds what is still waiting on an input, and §29 what has been decided and why.

[`ROADMAP.md`](ROADMAP.md) puts the work in order, and [`docs/epics/`](docs/epics/) holds each task's detail.

---

## 1. Purpose

Waymark is where you have been and where you are going. You **check in** at a place, whenever you like, and Waymark keeps the log: when, where, a note, a
photo, how many times you have been back, and a map of all of it. You **plan a trip** as stops, days and things to do, with the people going and the
people following along, and when the trip comes, Waymark shows you today's plan and tells you what is next. It is the job Swarm does for the log and
Wanderlog does for the plan, on a server its people chose, with nothing to collect and nothing to sell.

The idea it is built around, carried over from the plugin unchanged:

> **Checking in is always available and stands on its own. A trip is a folder that check-ins fall into when the dates match.**

Planners die the day the trip ends; check-in apps know nothing of the future. Waymark is the whole lifecycle: plan, go, look back. It is an app of the
Sovereign suite exactly as Tusk, Tally and Ledger are: a program of its own, which an instance can host, and which needs no instance to run.

Waymark replaces the legacy plugin `sovereign-plugin-travellog`. Its behaviour is the starting point; none of its code is carried over and none of its data
is migrated (§29). Its interface is designed anew (§20).

What it must not give up, whatever the convenience:

- **It works alone.** Every feature works on a Waymark with no Sovereign instance: its own accounts, its own people, its own mail, its own notices, its own
  files, its own map. An instance adds a way to sign in, a directory to find people in, and core's bell and email; never what a feature depends on
  (§19).
- **Checking in is never held up.** It works with no network, answers at once, and syncs in the background (§15). A check-in never needs a trip.
- **Location history is the most sensitive thing it holds.** Everything that says where someone was is encrypted at rest (§18); check-ins are private
  to their author unless shared with a trip (§11.3); nothing about a place leaves the server except to the place search the operator chose (§7.2).
- **No third party in the browser.** The map, its tiles and its fonts are served by Waymark itself (§8).
- **The log is legible, not a game.** Counts, the map and "you've been here 4 times" are the log read back. No points, badges, streaks, mayorships or
  leaderboards, ever in phase 1, 2 or 3.
- **A person can leave.** One file holds what is theirs (§22); deleting the account removes everything of theirs (§23).

What it is not: a booking site, a navigation app (it hands off to the device's maps), an expense splitter (that is Tally, which a trip links to), or a
public travel blog.

## 2. Phases

The owner's direction: **all three parts are planned now and built one after another,** each a release.

| Phase                     | Release | What it delivers                                                                                                                                                                                                                                                                        |
| ------------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **1, Check-ins**          | 0.1.0   | On the web, responsive and installable: sign-in, locally and through core; places with search; the map; checking in by search, GPS or hand, with a note and photos, offline too; the timeline; a place's page; figures; importing a Swarm export; notices; export, import and deletion. |
| **2, Trips**              | 0.2.0   | Trips of stops, days and itinerary items; planning until ready; attachments; a link to the trip's Tally group; sharing with Organizers, Travelers and Followers by invitation; check-ins shared with a trip; auto-link; the trip page with its map and planned versus actual.           |
| **3, Trip Mode**          | 0.3.0   | Today on a trip: the day's plan, where you are, what is next and when, a hand-off to the device's maps, reminders through the bell, email and Web Push, and the day's plan and map offline.                                                                                             |
| **Later, none committed** | —       | Reordering a day by distance, then by real routing; importers for GPX, KML, GeoJSON, CSV and Google Takeout; live updates; §26 outlines each.                                                                                                                                           |

### 2.1 What is carried over

The plugin's task numbers are not used here. This table is how to check nothing was lost.

| Plugin                                                                             | Here                                                                                                                          |
| ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| One `place` table shared by visits and itinerary items                             | §7.1: places of a person and places of a trip, one shape; **changed** because trips are now shared and deletion must be clean |
| Place search: own places, then OSM Nominatim, configurable; manual places          | §7.2, from the server only; Photon as well as Nominatim                                                                       |
| Visit with UTC time, IANA zone and offset; note; photos; companions; source        | §9.1                                                                                                                          |
| Check-in by search, GPS or hand; mobile only                                       | §9.2, **everywhere**, the web included                                                                                        |
| Timeline grouped by day, filters, detail, unlink                                   | §20.6                                                                                                                         |
| Per-place counts, unique places and countries, "next trip in N days"               | §9.5, a place's page (§20.8), Home (§20.4)                                                                                    |
| Map of visits (deferred: no map component)                                         | §8, **in phase 1**, built on OpenStreetMap                                                                                    |
| Swarm ZIP import, resumable, photos fetched only from Foursquare                   | §16                                                                                                                           |
| Trip of ordered stops, dates derived from stops                                    | §10.1, §10.3                                                                                                                  |
| Status derived from dates                                                          | §10.2: **planning until marked ready**, then derived                                                                          |
| Trip days generated from a stop's dates; asked before a day with items goes        | §10.4                                                                                                                         |
| Itinerary items: place or title, planned time, fixed or flexible, notes, order     | §10.5                                                                                                                         |
| Attachments on a trip or a day: receipt, booking, accommodation                    | §10.6                                                                                                                         |
| Companions as free-text tags on a trip                                             | §11: **real shared access**, with roles                                                                                       |
| Auto-link by local date, narrower range wins, manual link sticks                   | §12, with a stop's distance first                                                                                             |
| Planned versus actual, full trip page (deferred)                                   | §13, §20.10, **designed now**                                                                                                 |
| Trip Mode: today, position, next with countdown, maps hand-off, reminders, offline | §14                                                                                                                           |
| Field encryption of the note (RFC 0092)                                            | §18: **every field that says where or what**, under the app's own key                                                         |
| Portability hooks through `sdk.portability`                                        | §22, §23, as the app's own                                                                                                    |
| `sdk.storage`, `sdk.jobs`, `sdk.notifications`                                     | Waymark's own files (§18.3), jobs (§5) and notices (§17)                                                                      |
| `ThreeColumnLayout` with Trips, Check-ins, Planner, Settings                       | §20: designed anew; the Planner is a trip's _Plan_ view                                                                       |
| Tenants, `sdk.db`, the plugin manifest, `shell: minimal`                           | Gone with the legacy runtime (§19, §24)                                                                                       |
| No reward mechanics                                                                | Kept (§1)                                                                                                                     |
| Route optimization 2a and 2b                                                       | Later (§26.1)                                                                                                                 |

## 3. User journeys

1. **First visit, alone.** Someone runs the image (§25). They make the first account and land on Home, which offers two things: _Check in_ and _Plan a
   trip_.
2. **First visit, on an instance.** They open Waymark from the launcher and sign in through core. The same Home.
3. **A coffee on a Tuesday.** Kasun presses _Check in_ on his phone. Waymark knows where he is and offers the places nearby, his own first; he picks _Café
   Nero_, adds "flat white, finally sunny", and saves. No trip is involved, and nothing asks about one.
4. **Ten years of history.** Kasun uploads his Swarm export on the web. Check-ins appear within a minute; their photos arrive over the next hour, and the
   bell says when it is done. The map is full the same day.
5. **Looking back.** He opens _Lisbon_ on the map, sees he has been to _Time Out Market_ four times, and opens the place to see each visit.
6. **Planning with others.** Kasun creates _Japan 2027_, adds stops Tokyo (12–16 April), Kyoto (16–20) and Osaka (20–22), and invites Thulana as a
   Traveler and his mother as a Follower. Thulana adds things to do in Kyoto. The trip stays _Planning_.
7. **Ready.** Bookings done, Kasun marks the trip ready. It becomes _Upcoming_; on 12 April it becomes _Ongoing_ by itself.
8. **Offline in a temple.** Thulana checks in at _Fushimi Inari_ with no signal. It shows at once with a small clock mark, links itself to _Japan 2027_
   because the date and the Kyoto stop match, and syncs when she is back on the network. She shares her check-ins with the trip, so Kasun and his mother
   see it.
9. **Today.** On the morning of 17 April, Kasun opens Trip Mode: the day's plan, his position, _Kinkaku-ji in 40 min_, and _Directions_, which opens his
   phone's maps. Twenty minutes before the fixed 19:00 dinner, his phone shows a reminder.
10. **The money.** The trip's page links to its Tally group, where the expenses are.
11. **After.** Back home, the trip is _Completed_. Its _Journal_ shows each day's plan beside what actually happened: two things skipped, three places
    found on the way.
12. **Leave.** Thulana deletes her account. Her check-ins and photos are gone, including the ones she shared; the plan she helped write stays with the
    trip.

## 4. Terminology

| Term                                      | Meaning                                                                                                                                          |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Account**                               | Someone who can sign in. In code, `account_id` is the better-auth user id (as in Tusk)                                                           |
| **Profile**                               | Waymark's own copy of an account's name and email (§6.1)                                                                                         |
| **Place**                                 | Somewhere with a name and a point: a person's own, or a trip's (§7.1)                                                                            |
| **Check-in**                              | Being at a place at a moment, with a note and photos (§9). Code says `checkin`; the plugin's `visit` is not used                                 |
| **Trip**                                  | A plan of stops, its people, its files and links (§10)                                                                                           |
| **Stop**                                  | A place and a range of dates within a trip: where you sleep, roughly (§10.3)                                                                     |
| **Day**                                   | One date of one stop, with a title and notes (§10.4)                                                                                             |
| **Item**                                  | Something planned on a day: a place or a title, an optional time, fixed or flexible (§10.5). On screen, "plan item" only where "item" is unclear |
| **Fixed**, **flexible**                   | An item with a commitment at its time (a reservation), or not                                                                                    |
| **Organizer**, **Traveler**, **Follower** | A person's role in a trip, by how they take part in it (§11.1)                                                                                   |
| **Member**                                | Anyone with a role in a trip                                                                                                                     |
| **Ready**                                 | A trip whose planning is done, by an Organizer's say (§10.2)                                                                                     |
| **Link** (to a trip)                      | A check-in's place in a trip, suggested or chosen (§12)                                                                                          |
| **Shared** (check-in)                     | A check-in its author lets the trip's members see (§11.3)                                                                                        |
| **Journal**                               | A trip's days, plan beside what happened (§13)                                                                                                   |
| **Trip Mode**                             | Today on an ongoing trip (§14)                                                                                                                   |
| **Notice**                                | Something a person is told, in the bell (§17)                                                                                                    |
| **Outbox**                                | Changes made on a device and not yet accepted by the server (§15)                                                                                |

User-facing text says "check in", "check-in", "place", "trip", "stop", "day", "plan", "Organizer", "Traveler", "Follower", "share with the trip",
"app"; never "visit", "plugin", "tenant", "geocode", "POI", "log spine", "plan spine" or "client".

## 5. Architecture

```
            browser (a PWA)                                       server (one image, one process)
 ┌───────────────────────────────────────┐              ┌──────────────────────────────────────────────────┐
 │ UI (React 19, @sovereignfs/ui)        │              │ Next.js: the shell, routes, server actions        │
 │ the map (MapLibre, in the DS)         │  /api/sync   │ better-auth (§19)                                 │
 │ reads and writes the device's store:  │ ◀──────────▶ │ sync: checks, orders, seals and stores (§15)      │
 │   IndexedDB, one database per account │              │ /api/ops: trips, stops, people (online)           │
 │ actions, figures, auto-link,          │  /api/ops    │ the same pure modules                             │
 │   today, journal: pure, shared        │ ◀──────────▶ │ /api/places: search, reverse (§7.2)               │
 │ service worker: the shell, tiles of   │  /api/media  │ /api/map: style, tiles, glyphs, sprites (§8)      │
 │   a trip, Background Sync             │  /api/map    │ /api/media: photos and files, sealed (§18)        │
 └───────────────────────────────────────┘              │ jobs: import, reminders, mail, push, pruning     │
                                                        └──┬──────────┬─────────┬──────────┬──────────┬────┘
                                                   SQLite (sqld   files under  place      map tiles   SMTP, core,
                                                   or a file) or  /data,       search     (upstream   push services
                                                   PostgreSQL     sealed       (Nominatim or PMTiles)
                                                                               or Photon)
```

- **Offline first for what is recorded, online for what is decided.** Check-ins, and a trip's items and day notes, are written to the device and synced
  (§15), as Tally's expenses are. Trips, stops, roles, invitations, attachments and ready are changes the server decides at once, so they are online
  operations (`/api/ops`).
- **The server is the referee and the only one that talks to the world.** It checks every change against membership and limits, seals it (§18), orders
  it, and hands it to the devices that should see it. It is the one place search, map tiles, SMTP, core and push services are reached from. **The browser
  talks only to its own server.**
- **The server reads every field,** which is why Waymark is encrypted at rest and not end to end (§29): it must search places, link check-ins, send
  reminders and fetch import photos.
- **What can be pure is pure:** the figures, the auto-link, the journal, today's plan, the time zone of a moment, building a mutation from an action.
  They take rows and the time as arguments, and the same module runs in the browser and on the server.
- **Next.js with React 19**, a long-running server, because of the jobs.
- **SQLite by default, in production too, and PostgreSQL if the operator prefers** (§24).
- **Jobs run in the web process** on a timer from `instrumentation.ts`, with `WAYMARK_WORKER=off` for all but one process if several share a database;
  every job claims its work in the database, so two running it is safe anyway (Tusk §5).

### 5.1 Where things go

As Tusk's and Tally's: `app/` for routes, `src/` for everything else, tests beside the code.

| Path                      | What                                                                                                                         |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `app/`                    | Routes: the landing page, sign-in, the invitation page, the signed-in area, `/api/*`                                         |
| `src/db/`                 | Configuration, clients, schemas per dialect, migrations at start-up (§24) — **copied from Tusk**                             |
| `src/auth/`               | better-auth, its settings, the sign-up policy, the screens, the fake Sovereign for tests (§19) — **copied from Tusk**        |
| `src/access/`             | Every page, route and operation with who may use it; the conditions for an account's rows and a trip's roles (§5.2)          |
| `src/crypto/`             | The instance key, envelope encryption, sealed rows and sealed files (§18) — envelope **copied from Tusk**, sealing Waymark's |
| `src/media/`              | Uploads judged by their bytes, re-encoding, thumbnails, the store under `/data/media`, serving (§18.3)                       |
| `src/places/`             | Places, the place search adapters, reverse lookup, time zones from coordinates (§7)                                          |
| `src/map/`                | The tile service: upstream proxy and cache, PMTiles, style, glyphs, sprites (§8)                                             |
| `src/checkins/`           | Check-ins, their photos, their actions and validators (§9)                                                                   |
| `src/trips/`              | Trips, stops, days, items, attachments, links, status, the operations (§10)                                                  |
| `src/sharing/`            | Roles, invitations, sharing check-ins, leaving and handing over (§11)                                                        |
| `src/autolink/`           | Choosing the trip a check-in falls into (§12) — pure                                                                         |
| `src/journal/`            | Planned versus actual (§13) — pure                                                                                           |
| `src/today/`              | Today's plan, next and countdown (§14) — pure                                                                                |
| `src/figures/`            | Counts, places, countries, years (§9.5) — pure                                                                               |
| `src/sync/`               | The protocol, `/api/sync`, applying a mutation, cursors, tombstones (§15) — the shape **from Tally**                         |
| `src/local/`              | The device's store, the outbox, the sync loop, Couldn't sync, photos waiting to upload (§15) — browser only, **from Tally**  |
| `src/import/`             | Import jobs and the Swarm reader (§16)                                                                                       |
| `src/notices/`            | Notices, preferences, delivery, reminders, Web Push (§17)                                                                    |
| `src/portability/`        | The file format, export and import (§22)                                                                                     |
| `src/sovereign/`          | Core's notices, `People.deletePerson`, the bell, email, activity and directory calls (§19, §23) — **from Tusk**              |
| `src/jobs/`, `src/mail/`  | The runner and claims; the SMTP mailer and the mail outbox — **copied from Tusk**, the outbox **from Tally**                 |
| `src/sw/`                 | The service worker: the shell by allow-list, the offline shell page, a trip's tiles, Background Sync — **from Tusk**         |
| `src/screens/`, `src/ui/` | The signed-in screens and the shell                                                                                          |
| `migrations/`, `deploy/`  | Generated SQL (`sqlite/`, `postgres/`, `auth/`); the Compose setups                                                          |

**Copied** (building-an-app §15: until the kit is published, an app copies, and says which files): from Tusk, `src/db/`, `src/jobs/`, `src/auth/` and its
fake Sovereign, `src/sovereign/`, `src/crypto/`'s envelope, `src/mail/`, `src/config/`, `src/security/` and `proxy.ts`, `src/limits/`, `src/sw/`,
`src/theme/`, `scripts/`, the Dockerfile and `deploy/`; from Tally (once built), the sync's shape with a counter per stream, the mail outbox, the profile
copy of name and email, invitations, and notice delivery. Each is renamed to `WAYMARK_` and trimmed of what Waymark does not use; none is changed in
behaviour without saying so in its task.

### 5.2 Access

**The permission is in the statement**, as in every app of the suite. A refusal reads as not found.

- **A person's own rows** (check-ins, their photos, their places, their import jobs, notices, settings) carry `account_id`, and every read and write names
  it: `… WHERE id = ? AND account_id = ?`.
- **A trip's rows** (stops, days, items, attachments, trip places, links, members) carry `trip_id`, and every read and write names it together with
  membership and the role the operation needs: `… WHERE trip_id = ? AND EXISTS (SELECT 1 FROM trip_member m WHERE m.trip_id = ? AND m.account_id = ? AND
m.role IN (…) AND m.left_at IS NULL)`. One SQL fragment per role set, in `src/access/`.
- **A shared check-in** is read by another member only through the trip: the check-in's `trip_id` is the trip, its sharing is on (§11.3), and the reader
  is an active member of that trip, in one statement.
- **Followers never reach attachments** (§11.1); the attachment statements require Organizer or Traveler.
- **Sync applies the same rule per mutation** (§15.5); pull hands a device only its own rows and the trips it is a member of.
- `src/access/routes.ts` lists every page, route and operation with who may use it; a test calls each as a second signed-in person, and each trip
  operation as a member of each lower role, and expects not found.

## 6. People and accounts

### 6.1 A profile

`profile` is Waymark's own copy of an account's **name and email**, made with the account and kept in step from Settings, as Tally keeps `person`: names
shown to a trip's other members are read from `profile`, never from the auth store or from core, so no feature depends on core for who someone is.
Waymark has **no placeholders**: everyone in a trip has an account, since a role is something one signs in to use; someone without one is invited (§11.2).

- **A name** is seen by everyone who shares a trip with the person. **An email** is seen by the person themselves and by the Organizers of a trip they are
  in; never by Travelers or Followers, never in a notice and never in someone else's export. One visibility function, used by every read that returns a
  profile.
- Avatars are initials: no picture is loaded from elsewhere.

### 6.2 Who may sign up

`WAYMARK_AUTH_SIGNUP` decides who may make a local account, one policy in better-auth's user-creation hook, as Tally's §6.4:

| Value                  | Local sign-up                                                            |
| ---------------------- | ------------------------------------------------------------------------ |
| `invite` (**default**) | The first account, and anyone holding a valid invitation (§11.2)         |
| `open`                 | Anyone                                                                   |
| `closed`               | The first account only; an invitation can be accepted only by signing in |

**Signing in through core always gets an account,** whatever the value (`app-manifest.md` §4). `invite` waits on the same change to `contracts/env.md`
that Tally waits on (§27); until it lands, Waymark offers `open` and `closed`, and phase 1, which has no invitations, needs nothing else.

## 7. Places

### 7.1 A place

A name, a point (latitude and longitude), an optional category, an address in parts (street, city, region, country, country code, postal code, the
shape a Swarm export has), where it came from (`manual`, `osm`, `import`) with the source's id, and its time zone (§7.3).

**A place belongs to a person or to a trip,** never both, one table with exactly one of `account_id` and `trip_id` set:

- **A person's places** are the ones they checked in at, picked on a map, or imported. Only they see them. Their check-ins point at them.
- **A trip's places** are its stops' and items' places. Every member of the trip sees them; they go with the trip.
- **Checking in at a trip's place** (from Trip Mode or the plan) copies it into the person's places, or reuses one they already have with the same source
  id, or the same name within 50 metres. **Planned versus actual** (§13) matches the same way, so "I went where we planned" is found without one row
  being shared by two owners.

This replaces the plugin's one shared table (§29): with shared trips and complete deletion, a place someone else's check-ins point at could not be
deleted with the trip, nor a person's place with the person. The plugin's goal, "I finally went there, twice" as one record, holds within a person's
places, which is where a count is read.

### 7.2 Finding a place

One field, on the server only (`/api/places`), the browser never reaching a third party:

1. **The person's own places** (and, inside a trip, the trip's), matched by name in memory after unsealing (§18), nearest first when a point is known.
2. **The operator's place search** (`WAYMARK_PLACES_PROVIDER`: `nominatim` by default, `photon`, or `off`) at `WAYMARK_PLACES_URL` (by default the public
   OpenStreetMap Nominatim). For the public instance Waymark keeps its usage policy: at most one request a second from the whole server, a User-Agent naming
   the software and the instance's address (never a person's), results cached for a day, no autocomplete on every keystroke (a search runs after a pause
   and at least three characters). Pointing it at one's own Nominatim or Photon lifts all of that.
3. **"Add a new place"**: a name and a point picked on the map, or the person's position. Always offered, so place search is never required.

**Reverse lookup** (what is at this point) is the same provider's, used to name a GPS check-in and offered when picking on the map. With the provider
`off` or unreachable, both say so and the manual way still works.

Search text leaves the server to the provider; the setting's help says so, and self-hosting is how to keep it in. Logs never hold a search, a name or a
point.

### 7.3 Time zones

A place's time zone is found **from its point, on the server, with no network** (a bundled boundary table, chosen in the task: `tz-lookup`'s kind, its
licence checked). A check-in's zone is the device's when it is made live, and the place's when imported or entered for another time; a stop's zone is
its place's, and its items' times are in it (§10.5). So a trip across the date line, and a check-in at 23:59, are on the right day.

## 8. Maps

The map is built on **OpenStreetMap** data and drawn in the browser with **MapLibre GL JS** (BSD-3-Clause), from **vector tiles served by Waymark
itself.** The browser loads nothing from elsewhere: style, tiles, fonts (glyphs) and icons (sprites) all come from `/api/map/*`.

### 8.1 Where the tiles come from

`WAYMARK_MAP_SOURCE`, chosen by the operator:

| Value             | What Waymark serves                                                                                                                                    |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `proxy` (default) | Tiles fetched by the server from `WAYMARK_MAP_UPSTREAM_URL`, a free, keyless vector tile service built from OpenStreetMap, and kept in a cache on disk |
| `pmtiles`         | Tiles read from a Protomaps PMTiles file at `WAYMARK_MAP_PMTILES_PATH` (under `/data/map`): a region or the planet, with no request to anyone, ever    |
| `off`             | No map: every map view shows its list instead, and picking a point is by the person's position only                                                    |

- **The default upstream** is chosen in the task that builds the service (4.3), after reading its terms: OpenFreeMap is the candidate (free, no key, no
  stated limit, OpenStreetMap data). The choice and its terms are written in the README.
- **The cache** is `/data/map/cache`, bounded by `WAYMARK_MAP_CACHE_MAX_MB` (default 2048), oldest-read first out, pruned by a job. It holds tiles and
  nothing about who asked for them. It is not encrypted: it is public map data.
- **The style** is Waymark's own, in the suite's tokens: a light and a dark one, chosen by the theme, so the map follows dark mode. Glyphs and sprites for
  it ship in the image, or are proxied and cached like tiles, decided in 4.3 by their size.
- **Attribution** to OpenStreetMap contributors (and the tile service where its terms ask) is on every map, as the licence requires.
- Serving tiles is a route like any other: signed in only, rate-limited per account.

### 8.2 The map in the interface

A `Map` component in `@sovereignfs/ui`, built there first (§20.11): MapLibre with the suite's styling, markers, clusters, a line through points, fitting
to a set of points, picking a point, and the user's position. Where Waymark uses it:

- **Map** (§20.7): every check-in, clustered; filtered by year, trip and category; a marker opens the check-in or the place.
- **A place** (§20.8): its point, small.
- **Checking in** (§20.5): picking a point for a new place.
- **A trip's map** (§20.10): the stops joined in order, the selected day's items numbered, shared check-ins as a second kind of marker.
- **Trip Mode** (§14): the day's items and the person's position; **offline** from the tiles kept for the trip (§14.5).

### 8.3 What it does not do

No routing, no directions, no turn-by-turn: _Directions_ hands off to the device's maps (§14.3). No satellite imagery. No search inside the map other
than Waymark's place search.

## 9. Check-ins

### 9.1 A check-in

A place (§7.1), the moment (milliseconds since the epoch, UTC), its IANA time zone and its offset then, a note (up to 2,000 characters, plain text), up to
10 photos (§9.3), companions (free-text names, as tags: who was there; kept from a Swarm import, editable, never an account), its trip link if any (§12)
and how it was made (`auto`, `manual`), its sharing (§11.3), and where it came from (`live`, `manual`, `import:swarm`, with the import's id for
de-duplication).

**It belongs to the person who made it,** and to nobody else. A trip is never required.

### 9.2 Ways to check in

From _Check in_, which is one press from anywhere (§20.2):

- **Here:** the device's position (`navigator.geolocation`, asked for when first used, never needed). The nearest of the person's places, then the place
  search's places nearby (§7.2), are offered; or _New place here_, named by reverse lookup or typed.
- **Search:** type a name; the person's places first, then the place search.
- **On the map:** pick a point, name it.
- **Another time:** the moment defaults to now and can be changed, to the past only; the time zone follows the place. This is how a forgotten check-in is
  added later, on the web or the phone.
- **Offline:** the person's places are searchable from the device; a new place can be made by name and position, and a GPS check-in with no name is saved
  as _A place near …_ with the point, named by reverse lookup when it syncs (the person can rename it).

Denied or unavailable location never blocks checking in; it removes _Here_ and says why.

### 9.3 Photos

Taken or chosen on the device, attached to a check-in, up to 10, each up to 15 MB as uploaded.

- **Judged by their bytes, not their name or declared type:** JPEG, PNG, WebP, HEIC, AVIF. Anything else is refused.
- **Re-encoded on the server** (with `sharp`): oriented, **every piece of metadata removed**, location included, since a photo may be shared with a trip;
  stored as WebP at most 2,560 px on the long side, with a 480 px thumbnail. The original is not kept (§29).
- **Sealed on disk** (§18.3) and served only through `/api/media/<id>` to who may see the check-in.
- **Offline,** a photo waits in the device's store and uploads when there is a network (§15.6); the check-in shows it at once from the device.

### 9.4 Editing and deleting

The author can change everything of a check-in: place, moment, note, photos, companions, link, sharing. Changing the moment or place re-runs the
auto-link unless the link was set by hand (§12). **Delete removes it for good,** with its photos, after a confirmation; there is no history and no
restore. A check-in is one person's record, and deleting it is that person's right.

### 9.5 Figures

Pure functions in `src/figures/`, over the person's check-ins on the device, so they work offline. **Never stored**: read back from check-ins, so an
imported decade gives exactly the figures a lived one would.

- Check-ins in total, this year and per year; places; countries and regions (from the place's country code); cities.
- Per place: how many times, first and last, and which trips.
- Trips: how many by status; the next one and its distance in days.
- Nothing that rewards: no streak, no rank, no "you beat last year".

## 10. Trips

### 10.1 A trip

A name, an optional description, a colour (one of the design system's accent tokens, the trip's dot), a cover (one of the trip's places, shown as a map
thumbnail, never a picture from elsewhere), **its dates, derived from its stops** (the first stop's arrival to the last stop's departure, cached on the
trip so lists sort without joining), whether it is ready (§10.2), its members (§11), stops, days, items, attachments and links.

### 10.2 Status

**A trip is _Planning_ until an Organizer marks it ready** (the owner's decision); then its dates decide:

| Status        | When                                                                |
| ------------- | ------------------------------------------------------------------- |
| **Planning**  | Not marked ready                                                    |
| **Upcoming**  | Ready, and today (in the first stop's zone) is before the first day |
| **Ongoing**   | Ready, and today is within the trip's dates                         |
| **Completed** | Ready, and today is after the last day                              |

- **Marking ready** needs at least one stop with dates. An Organizer can **move it back to planning** at any time; the trip says so to its members.
- Status is computed, never stored: `ready_at` is the only field.
- A trip still planning whose dates have passed shows _Planning_ with "these dates have passed" and a button to mark it ready, which is how a trip
  planned and never marked still reaches its journal.
- **Auto-link** (§12) and the journal use a trip's dates whatever its status. **Trip Mode and its reminders** need _Ongoing_, so they come only once a trip
  is ready.

### 10.3 Stops

A place (the trip's, §7.1), an arrival date and a departure date (`YYYY-MM-DD` in the place's zone), an optional note, and an order.

- **In order of dates.** Stops may not overlap, except that one stop's departure may be the next one's arrival: a travel day belongs to both. A stop may
  have no dates yet while planning; it sorts after dated ones and makes no days.
- **At most 90 days a stop, 365 a trip,** checked by the server.
- **Adding, re-dating, reordering or removing a stop** recomputes the trip's dates in the same transaction.
- Stops are online operations (§15.7) for Organizers and Travelers.

### 10.4 Days

Each date of a dated stop is a **day**, with an optional title ("Arashiyama") and notes. **Days follow the stop's dates:** made when a stop gets dates,
removed when they shrink. A travel day shared by two stops is two days, one in each, and Trip Mode shows both (§14.1).

**Shrinking a stop's dates over a day that has items is never silent:** the server refuses, naming the days, and the screen offers to move their items to
another day of the trip or delete them, then retries. Every other removal cascades.

### 10.5 Items

Something planned on a day: a place (the trip's) or a title, at least one of them; a kind (Sight, Food, Stay, Transport, Activity, Other, each with an
icon); an optional start time and end time (`HH:mm`, in the stop's zone); **fixed** or **flexible**; notes (up to 2,000 characters); and an order within
the day.

- **Fixed needs a time.** A fixed item is a commitment (a 19:00 reservation): it keeps its time, Trip Mode shows it as such, and a reminder before it is
  on by default (§14.4). A flexible item can still have a time, as a guide.
- **Order** is the day's order as dragged (a fractional position, as Tusk's cards), independent of times; the plan shows timed items by time and untimed
  ones where they were put. Later reordering by distance moves only flexible items (§26.1).
- **Moving an item** to another day, or another stop's day, is a drag or a menu.
- Items and day notes **sync offline** for Organizers and Travelers (§15): a plan is edited on the road.

### 10.6 Attachments

A receipt, a booking, an accommodation record, a ticket, or other: a file (PDF, or an image as in §9.3, up to 15 MB), a title and a kind, on the trip or
on one day.

- Judged by their bytes; a PDF is kept as it is (not re-encoded), an image as photos are. Sealed on disk; served as a download, or a PDF inline with a
  sandboxing CSP, never as HTML.
- **Seen and added by Organizers and Travelers, never Followers** (§11.1): bookings carry names, numbers and addresses.
- Uploaded online only (§15.7).

### 10.7 Links

A trip has a short list of links (up to 10): a title and an `https` address. **The first kind is _Expenses in Tally_** (the owner's decision): pasting a
Tally group's address shows it with Tally's name, as the trip's place for money. Waymark never fetches a link, shows no preview, and knows nothing of Tally
beyond the address: no app imports another. Followers see links; any member may open them.

### 10.8 Limits

Checked by the server and said in a sentence when reached. **Every limit is a setting** (the owner's decision), with these defaults:

| Setting                          | Default | Limits                         |
| -------------------------------- | ------- | ------------------------------ |
| `WAYMARK_LIMIT_TRIP_MEMBERS`     | 30      | Members of a trip              |
| `WAYMARK_LIMIT_TRIP_STOPS`       | 50      | Stops of a trip                |
| `WAYMARK_LIMIT_DAY_ITEMS`        | 200     | Items on a day                 |
| `WAYMARK_LIMIT_TRIP_ATTACHMENTS` | 100     | Attachments of a trip          |
| `WAYMARK_LIMIT_ACCOUNT_TRIPS`    | 300     | Trips an account is in         |
| `WAYMARK_MEDIA_MAX_ACCOUNT_MB`   | 500     | Files an account holds (§18.3) |

Lowering a limit never deletes anything: what is over it stays, and only adding more is refused.

## 11. Sharing

### 11.1 Roles

**A role says how a person takes part in the trip,** not a permission level (the owner's direction); what they may do follows from it:

| Role          | Who                                                            | May                                                                                                                                                       |
| ------------- | -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Organizer** | Plans the trip and is responsible for it; there may be several | Everything: the trip's name, colour, links; stops, days, items, attachments; invite and remove people, change roles; mark ready and back; delete the trip |
| **Traveler**  | Is going                                                       | Read everything; edit stops, days, items, attachments and links; link and share their own check-ins (§11.3); Trip Mode and its reminders; leave           |
| **Follower**  | Is not going, but follows along (family, a friend at home)     | Read the plan, the dates, the map, the links and the check-ins Travelers share; **not attachments**; no editing, no Trip Mode, no reminders; leave        |

- **Organizers go too, unless they say otherwise:** an Organizer is a Traveler as well, with a "Not going" switch for one who only organizes; the
  journal and planned versus actual count the Travelers and the going Organizers.
- **The creator is the first Organizer. A trip always has an Organizer:** the last one cannot leave, be removed or become another role until someone else
  is made Organizer.
- **Only Organizers invite and change roles.** Travelers can ask through the trip's people view ("Ask an Organizer to invite"), which does nothing more
  than say so.

### 11.2 Inviting

From the trip's _People_ view, by an Organizer, choosing the role:

- **Typing a name** offers people the Organizer already shares a trip with; **on an instance with the directory,** core's directory too (§19.4): choosing
  someone found there makes their invitation, delivered by core's bell, and their first sign-in through core takes it.
- **Typing an email:** an account here with that email is invited by a notice; any other address gets an invitation by email. Telling the two apart is
  limited per account and per hour, as Tusk's is.
- **A link** can always be made instead, to copy and send any other way. With no mail set up, the dialog says the link is the only way.

**An invitation** is to one trip with one role: a random 32-byte token, stored only as its hash, compared in constant time, valid 14 days, single-use,
revocable; resent at most once an hour. `/invite/<token>` shows the trip's name, its dates and who invited, nothing else, and offers to sign in or
create an account (which `invite` sign-up allows, §6.2). **Whoever holds the link can accept it,** as in Tally; the inviter is told who did. Accepting
when already a member changes nothing and says so.

**Invitations are online** (§15.7).

### 11.3 Check-ins on a shared trip

**A check-in is private to its author by default, even when it is linked to a shared trip** (confirmed by the owner, §29):

- **A choice per trip:** the first time one of a Traveler's check-ins links to a trip that has other members, Waymark asks once, on the check-in: _Share
  your check-ins on Japan 2027 with its 3 members?_ The answer is that Traveler's setting for that trip, changeable on the trip's page.
- **A choice per check-in,** overriding it: _Share with the trip_ or _Keep private_.
- **Who sees a shared check-in:** every active member of the trip, Followers included: its place, moment, note, photos and companions. Not its other
  trips, not its author's other check-ins.
- **Only Travelers' check-ins link and share** (Followers are not there). A Follower's check-ins never link to that trip.
- **Unlinking, unsharing or leaving** removes it from the trip at once; the check-in stays in the author's log.

### 11.4 Leaving and handing over

- **Leave** is any member's. An Organizer who is the last must name another first. Leaving unlinks and unshares their check-ins from the trip (§11.3);
  what they wrote in the plan stays, as the trip's.
- **Remove** is an Organizer's, with the same effect on the removed person.
- **Delete the trip** is an Organizer's, after a confirmation naming what goes: every stop, day, item, attachment, link, trip place and invitation; check-ins
  linked to it are unlinked, not deleted.
- **When an account is deleted** (§23): a trip where they were the only Organizer passes to its longest-standing Traveler, then Follower, who is told; a
  trip with nobody else is deleted.

## 12. Auto-link

Pure, in `src/autolink/`, run on the device when a check-in is made or changed (so it works offline) and again by the server when it applies it (§15).
The draft's rule, at the owner's request:

1. **Candidates:** trips where the person is a Traveler (or a going Organizer) whose dates contain the check-in's **local** date (its moment in its own
   zone, not the UTC instant). A trip still planning counts if it has dates.
2. **The nearest stop wins:** among candidates, the one whose stop on that date is nearest to the check-in's place (a travel day counts both stops).
3. **Then the shorter trip:** if distance does not decide (no points, or within 1 km of each other), the trip with the fewer days. Then the trip made
   first, so every device decides the same.
4. **No candidate, no link.**

- **Always a suggestion:** the link is shown on the check-in with _Change_ and _Unlink_. A link set or removed by hand is `manual`, and **nothing
  automatic ever changes a manual link** again. An automatic link is re-decided when the check-in's moment or place changes, or a trip's stops change
  dates.
- **Importing** (§16) links every imported check-in the same way, in the job.
- A newly dated trip picks up the person's existing check-ins in its dates the same way, in the background, never touching manual links.

## 13. Planned versus actual

The trip's **Journal** (§20.10): each day, the plan beside what happened. Pure, in `src/journal/`, over the trip's rows and the check-ins the reader may see
(their own linked ones and the shared ones).

- **Done:** an item whose place matches a check-in on that day by a going member (the same source id, or the same name within 50 metres, §7.1).
- **Skipped:** an item with a place that nothing matched, once its day has passed.
- **Found on the way:** a check-in on that day that matches no item.
- **Untimed or placeless items** show as planned, never judged.
- A day reads as a sentence and a list: "5 planned, 3 done, 1 skipped, 2 found on the way", then the items and check-ins in time order, each with who
  checked in (initials) and their photos.
- Figures for the whole trip on its overview: days, stops, places planned and visited, check-ins by everyone who shared.

## 14. Trip Mode

### 14.1 Today

Pure, in `src/today/`, from the trip's rows and the moment: **today's date in the current stop's zone**; the day or days (a travel day has two, departing
then arriving); their items in plan order with timed ones by time; **next**: the first item not yet done whose start is after now, or the first untimed
one after the last done; a countdown to a timed next item; and an empty day as an empty day, not an error. "Done" here is the journal's (§13), plus a
person's own _Done_ press on an item, kept on the device and synced.

Tested across a date line, at 23:59 and 00:01 local, on a travel day, and with a device zone different from the stop's.

### 14.2 The screen

`/t/<id>/today`, for Travelers and going Organizers, on an **Ongoing** trip; reached from Home, from the trip, and from a notice. Outside the trip's dates
it says when the trip starts or that it has ended, and links to the plan. Phone first, the same screen wider:

```
┌──────────────────────────────────────┐
│ ← Japan 2027          Kyoto · day 2  │
│ ┌──────────────────────────────────┐ │
│ │            (the map)             │ │  ← the day's items numbered, you as a dot
│ └──────────────────────────────────┘ │
│  NEXT  Kinkaku-ji          in 40 min │
│        [ Directions ]  [ Check in ]  │
│  ─────────────────────────────────── │
│  ✓ 08:30  Fushimi Inari              │
│  ○ 11:00  Kinkaku-ji                 │
│  ○        Nishiki Market             │
│  ● 19:00  Dinner, Gion       fixed   │
└──────────────────────────────────────┘
```

- **Check in** here pre-fills the next item's place (copied into the person's places, §7.1) and links to the trip.
- **Done** on an item marks it for today without checking in.
- The plan is the plan exactly as ordered; nothing reorders it in phase 3 (§26.1).

### 14.3 Directions

**Directions** opens the device's own maps with the item's point and name: `geo:` on Android, `maps://` (Apple Maps) on iPhone and iPad, and an
`https://www.openstreetmap.org/directions` link elsewhere. One convention, decided by the device, documented; nothing is fetched by Waymark for it.

### 14.4 Reminders

A job on a one-minute tick, for Ongoing trips (and the eve of Upcoming ones):

| Reminder      | When                                                         | Default                                              |
| ------------- | ------------------------------------------------------------ | ---------------------------------------------------- |
| `trip_starts` | 18:00 the day before the first day, in the first stop's zone | On, bell and email                                   |
| `item_soon`   | A lead time before a timed item's start                      | On for **fixed** items, 30 minutes; off for flexible |
| `day_plan`    | 08:00 each trip day, the day's plan in one line              | Off                                                  |

- Lead time and which kinds are per person and per trip, in the trip's settings, and the channels per kind in Settings (§17).
- **Once per item, per person,** recorded in `reminder_sent`; an item edited to a new time can remind again. No reminder for an untimed item.
- Reaches the person through the bell, **Web Push** (§17.3), email if they chose it, and core's bell when hosted.

### 14.5 Offline

Before an Upcoming trip and each day of it, the device keeps what Trip Mode needs: the trip's rows (always, by sync, §15) and **the map tiles around
each stop** to a street level, fetched through Waymark into the service worker's tile cache (a bounded number per trip, removed after the trip ends).
_Download for offline_ on the trip lets a person do it at once on Wi-Fi. Position needs no network. **Push needs a network;** offline, nothing reminds.

## 15. Offline and sync

The design goal is Tusk's and Tally's: **a person does not feel any of this.** Recording never waits, shows no conflict dialog and no "saving". The shape
is Tally's (§11 of its design), with two kinds of stream.

### 15.1 The model

- **The device holds**, in IndexedDB through `idb`, one database per account (`waymark-<account id>`): **the person's own stream** (their places,
  check-ins with photo records, settings and the per-trip sharing choices) and **one stream per trip they are a member of** (the trip, its members' names,
  stops, days, items, trip places, links, the attachments' records for those who may see them, and the shared check-ins). Screens read from it, and
  figures, auto-link, the journal and today are computed from it, so everything already seen is readable offline.
- **The device holds plain text,** as the screens need. It is deleted at sign-out (§15.8). Encryption at rest is the server's (§18).
- **A recorded action is written to the device at once** and, in the same IndexedDB transaction, to the outbox. The sync loop sends it.

### 15.2 Mutations

An action is a pure function in `src/actions/` that turns intent into a **mutation**: one or more row changes, with an id made by the device, a stream
(`account` or `trip:<id>`), and for an edit the `baseVersion`. The validators are one module, run by the browser before it queues and by the server
before it applies.

**What syncs offline:** creating, editing and deleting check-ins and the person's places; the per-trip sharing choice; a person's _Done_ marks; and, for
Organizers and Travelers, creating, editing, moving and deleting items and editing day titles and notes. Everything else is online (§15.7).

### 15.3 The endpoint

`POST /api/sync`, with the session cookie and `Origin` checked. A request carries the outbox in order and a cursor per stream; the answer carries what
was applied, what was refused and why, the account's current trips, and the changes since each cursor.

- **Order is a counter per stream** (`account.seq`, `trip.seq`), incremented in the short transaction that applies a mutation, stamped on each changed row,
  with the mutation id recorded so a replay writes nothing.
- **Pull** returns rows past each cursor, paged; a new stream starts at zero, its snapshot; a trip the account left is named as gone, and the device
  deletes its copy.
- **A shared check-in travels in the trip's stream** as a copy for readers, written when it is shared or changed, removed when it is unshared: the author's
  stream holds the original.
- **A device syncs** after a write (debounced), on load, on focus, on coming online, every 30 seconds while visible, and through Background Sync where
  there is one; one tab at a time (Web Locks), others told (BroadcastChannel). A protocol version travels with each request; a device too old is told to
  update and keeps its outbox.

### 15.4 Conflicts

Resolved by rule, nothing asked:

| What happened                                    | What results                                                                                              |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| A person edits a check-in on two devices         | The edit that reached the server later stands, whole                                                      |
| Two members edit one item                        | The later stands, whole; the earlier author gets a notice that their edit was replaced, with what it said |
| One member edits an item another deleted         | The edit restores it                                                                                      |
| An item's day disappears (its stop was re-dated) | Refused (§10.4 keeps this from happening online); an offline item for a gone day goes to Couldn't sync    |
| Both delete                                      | Deleted                                                                                                   |

Items have no history beyond the replaced notice (§29).

### 15.5 What the server refuses, and what the person sees

The server re-checks everything: the stream is the account's, or a trip it is a member of with the role the change needs; the day and place are the
trip's; the sizes and limits; a check-in's moment is not in the future. **A refused change is not thrown away:** it goes to **Couldn't sync** (Settings,
and a mark on the avatar) with the reason in a sentence ("You're now a Follower of Japan 2027", "Day 17 April was removed"), from where it can be fixed and
sent, or discarded. A refused check-in is never lost.

### 15.6 Photos waiting

A photo taken offline is kept in the device's store and uploaded to `/api/media` (with its device-made id) when there is a network, before or after the
check-in's mutation; the check-in shows it from the device meanwhile, and a check-in synced before its photo arrives shows a placeholder to others. A
photo that cannot be uploaded (too large, not an image) goes to Couldn't sync with the check-in.

### 15.7 What needs a network

Stated in the app and in the documentation: signing in and the first load; searching the place search and reverse lookup (own places work offline);
**trips, stops, ready, members, roles, invitations, attachments and links**, which are online operations (`/api/ops`, answering at once, undone with a
toast on a refusal, as a Tusk board is); importing; export; settings; notices; map tiles not already kept (§14.5). On iPhone, sync happens only while Waymark is
open. Persistent storage is requested (`navigator.storage.persist()`); a browser could still evict unsent changes.

### 15.8 First load, sign-out, an ended session, keeping it small

As Tally's §11.7 and §11.8: the first load pulls snapshots in pages, the person's stream first and newest check-ins first; signing out deletes the
device's database and kept tiles after trying to send the outbox; an ended session shows sign-in and keeps the outbox for the same account. Tombstones
and applied-mutation records go after 90 days, and a device behind that gets a fresh snapshot after sending its outbox.

## 16. Import from Swarm

From **Settings > Data > Import from Swarm** (and the Check-ins empty state), on the web.

- **Upload** the ZIP Foursquare emails (up to 200 MB). It is sealed onto disk under `/data/imports` and read by a job, never in the request.
- **Check-ins first:** the job reads the check-ins and venues, makes places (de-duplicated by Foursquare venue id within the person's places) and
  check-ins with their moments and zones, companions from `with`, notes from `shout`, and links them (§12). **Re-running the same export creates nothing
  twice** (the check-in's Foursquare id).
- **Then photos,** which in an export are addresses on Foursquare's image servers: fetched **only from `*.4sqi.net` and `*.foursquare.com` over HTTPS**,
  never another host the file names, redirects followed only within those hosts, size-capped, judged by their bytes, re-encoded as §9.3; two at a time,
  retried with backoff, a failed one recorded and skipped.
- **Resumable:** the job keeps a cursor in `import_job`; a restart, a crash or a deploy carries on from it. **Progress** (check-ins done, photos fetched,
  failed) shows on the import screen, live while open, and the bell says when it is finished (§17). The ZIP is deleted when the job ends.
- **The mapping is checked against a real export before it is fixed** (the plugin's mapping was inferred and never verified): the task that builds the
  reader starts from one, which the owner provides (§28). Fields the export has and Waymark does not are counted and reported, not silently dropped.

## 17. Notices

### 17.1 Kinds

A row per person told, written in the change's transaction, **never for what a person did themselves:**

| Kind                                   | Who is told                                                              | Phase |
| -------------------------------------- | ------------------------------------------------------------------------ | ----- |
| `import_finished`                      | The importer                                                             | 1     |
| `invited`                              | An account invited to a trip                                             | 2     |
| `invite_accepted`                      | Whoever invited                                                          | 2     |
| `role_changed`                         | The person whose role changed, or who was removed                        | 2     |
| `trip_ready`                           | Every member, also when moved back to planning                           | 2     |
| `trip_dates`                           | Every member, when the trip's dates change                               | 2     |
| `checkin_shared`                       | Members who chose it (off by default): a Traveler shared a check-in      | 2     |
| `edit_replaced`                        | The author of an item edit replaced in a conflict (§15.4)                | 2     |
| `organizer_passed`                     | A member who became Organizer because the last one's account was deleted | 2     |
| `trip_starts`, `item_soon`, `day_plan` | Travelers and going Organizers (§14.4)                                   | 3     |

- **The bell** left of the avatar, as Tusk's and Tally's: unread count up to "99+", `NotificationsPanel`, each opening where it points;
  `/notifications`, the whole list by day. Kept 90 days, at most 500 a person. A notice about a trip the person left is not shown.

### 17.2 Delivery

The bell always. Beyond it, per kind and channel in Settings (`notice_pref`):

| Channel         | Alone                             | Hosted, person linked to core                            |
| --------------- | --------------------------------- | -------------------------------------------------------- |
| **Email**       | Waymark's mail (`WAYMARK_SMTP_*`) | Core's email (`email:send`), or Waymark's if not granted |
| **Core's bell** | —                                 | `notifications:send`, a link back to the notice          |
| **Web Push**    | Phase 3 (§17.3)                   | Phase 3                                                  |

Mail goes through `mail_outbox` in the background, never logged with its address or content (Tally's). Each send to core carries a `key`; no core, or an
older one, sends nothing and changes nothing else. With no channel beyond the bell, Settings says so.

### 17.3 Web Push

In phase 3, because reminders on a trip are worth little without it (§29). Keys generated once by the instance (`generate`:
`WAYMARK_VAPID_PRIVATE_KEY`; the public key derived), a subscription per device in `push_subscription`, sent by a job with the same claims as mail, a
payload that says what and where without a place name, note or person's name in it (the push service carries it). Browser push services cost nothing.
On iPhone only once Waymark is on the home screen; Settings says so. The design is Tally's §21.4, so the two apps share it.

## 18. Encryption and media

### 18.1 What is encrypted

**Server-side envelope encryption at rest** (the owner's decision, §29), under `WAYMARK_ENCRYPTION_KEY`: Tusk's envelope (a random data key per row, wrapped
under the instance key, bound to the row's id and purpose), copied. Everything that says **where or what** is sealed; only what the database must sort,
join or count stays readable:

| Sealed                                                                                                                                                                                                                                                            | Readable                                                                                            |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Place: name, point, address, category, source id; check-in: note, companions, the place's point copy; trip: name, description; stop and day: notes, titles; item: title, notes; attachment and link: title, address; profile: name, email; import job: its errors | Ids, owners, `trip_id`, moments, dates and times, zones, kinds, order, sharing, roles, `seq`, sizes |
| Every photo and attachment file, and an uploaded import ZIP                                                                                                                                                                                                       | The file's size and type                                                                            |

- **A sealed row has one `sealed` column** holding its sensitive fields as one envelope, rather than a column each: one data key per row, one place to
  read them. Code reads and writes rows only through `src/crypto/sealed.ts`, which a test holds to the table of what each table seals.
- **Search, distance, the map and the figures** work on unsealed rows in memory, on the device or on the server for the person's or trip's own rows: a
  person's data is thousands of rows, not millions. No sealed field is ever in a `WHERE`, `ORDER BY` or index.
- **Dates stay readable** (they order the timeline and find auto-link candidates); what they say alone, without a place, is accepted (§29).
- **Rotation:** a new key with the old as `WAYMARK_ENCRYPTION_KEY_PREVIOUS`; a job re-wraps every data key, then the old key can go.
- **What it protects against:** a copied database, a backup, a disk, an operator reading tables. **What it does not:** someone in control of the running
  server, which holds the key and reads everything to do its work. The README says so, plainly.

### 18.2 Sharing and encryption

The server unseals for whoever may read a row (§5.2), so sharing a trip or a check-in needs no key exchange. A trip's rows are sealed under the trip's
row keys, not a member's, so a member leaving or an account being deleted changes no other row. **End-to-end encryption is not in any phase** (§29):
place search, auto-link on import, reminders and photo fetching all need the server to read.

### 18.3 Files

Waymark's own, never core's (the suite's rule): under `/data/media` (declared in the manifest's `data`), one file per photo, thumbnail and attachment, named
by a random id, sealed with its own data key. Served by `/api/media/<id>` after the access check, with `Cache-Control: private`, a `Content-Type` from
the stored type, `X-Content-Type-Options: nosniff`, and for a PDF a sandboxing CSP. **Limits:** 15 MB a file; `WAYMARK_MEDIA_MAX_ACCOUNT_MB` per account
(default 500, §10.8), counted on what is stored, said in a sentence when reached. Deleting a check-in, trip or account deletes its files in the same job that
deletes the rows' last trace; an orphan sweep finds any left by a crash.

## 19. Sign-in and core

### 19.1 Sign-in

**As Tusk's §6, with `WAYMARK_` for `TUSK_`:** better-auth in a store of its own; local accounts (password, passkey, authenticator app with backup codes) when
`WAYMARK_AUTH_LOCAL=1`; a Sovereign core through `genericOAuth` with PKCE when `WAYMARK_CORE_*` are set; either or both, from one image, both allowed when
hosted. Email is verified and passwords reset only with mail set up. A person is their better-auth user id; a `sub` is identity, an email is never
matched to an account at sign-in; no implicit linking.

### 19.2 Core's notices

Back-channel logout at `/api/sovereign/backchannel-logout` and account deleted at `/api/sovereign/account-deleted` (running `People.deletePerson`,
answering `200` only once done), verified by the SDK, replays refused (`notice_seen`). Copied from Tusk.

### 19.3 The manifest

```json
{
  "manifest": 2,
  "prefix": "waymark",
  "name": "Waymark",
  "description": "Check in where you are, plan trips with the people going, and look back on everywhere you have been",
  "icon": "/icons/icon.svg",
  "port": 3005,
  "health": "/api/health",
  "launch": "/",
  "signIn": {
    "redirect": ["/api/auth/callback/sovereign"],
    "backChannel": "/api/sovereign/backchannel-logout",
    "accountDeleted": "/api/sovereign/account-deleted",
    "scopes": ["openid", "profile", "email", "offline_access", "directory"]
  },
  "database": true,
  "data": ["/data"],
  "generate": [
    "WAYMARK_AUTH_SECRET",
    { "name": "WAYMARK_ENCRYPTION_KEY", "bytes": 32 },
    "WAYMARK_VAPID_PRIVATE_KEY"
  ],
  "core": ">=0.57.0 <1.0.0"
}
```

- **`data`:** photos, attachments, imports, the map cache and a PMTiles file live under `/data`. The SQLite file form keeps its database there too.
- **`directory` and `offline_access`** are for finding people in core's directory as the person (Tally's §14.4): the refresh token is a credential, kept
  only through `src/crypto/`. If the scopes are refused, inviting works exactly as alone. They are added in phase 2, when invitations are built; phase 1's
  manifest asks for `openid`, `profile` and `email` only.
- **`WAYMARK_VAPID_PRIVATE_KEY`** joins `generate` in phase 3; whether `generate` can make a VAPID key (an EC key, not random bytes) is checked then (§27).
- **The `core` floor** is raised, if needed, to the first release with the directory scope and the app scopes Waymark calls.
- `pooling` is not set: the jobs take locks.

### 19.4 Core's services

| What                            | Hosted                                                                   | Alone                        |
| ------------------------------- | ------------------------------------------------------------------------ | ---------------------------- |
| Sign-in                         | Core, and local accounts if `WAYMARK_AUTH_LOCAL=1`                       | Local accounts               |
| Finding people to invite        | Waymark's own, and core's directory (§11.2)                              | Waymark's own                |
| Notices                         | Waymark's bell, and core's bell (`notifications:send`)                   | Waymark's bell               |
| Email                           | Core's (`email:send`) for linked accounts; Waymark's for other addresses | Waymark's (`WAYMARK_SMTP_*`) |
| Export, import, account deleted | A line on the person's activity page (`activity:write`)                  | Nothing                      |
| Files, map, place search, push  | **Waymark's own, always**                                                | Waymark's own                |

## 20. Interface

Designed anew; the plugin's three columns and separate Planner are not carried over.

### 20.1 Principles

`@sovereignfs/ui` throughout, imported directly; `--sv-*` tokens only, the map's style included; Hanken Grotesk served by the app. **Screens paint from the
device** (§15.1): after the first load nothing shows a spinner for what was already seen. Every surface has an empty state that says what to do next. A
check-in not yet synced shows a small clock mark and nothing more. Times are shown in the zone they happened or are planned in, with the zone named when it
is not the reader's. Everything a map shows is also a list, for a screen reader and for anyone who prefers it.

### 20.2 The shell

Two rows, as Tusk's and Tally's: the header, and the sidebar beside the content.

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ ☰  waymark.                                                      (bell) (avatar) │
├────────────────────────┬─────────────────────────────────────────────────────┤
│ [ ⊕ Check in ]         │                                                     │
│ ⌂ Home                 │                                                     │
│ ◷ Check-ins            │                     content                         │
│ ◎ Map                  │                                                     │
│ ⚑ Places               │                                                     │
│                        │                                                     │
│ TRIPS                  │                                                     │
│  ● Japan 2027  ongoing │                                                     │
│  ● Lisbon     planning │                                                     │
│  ○ Iceland   completed │                                                     │
│  All trips · + New trip│                                                     │
│                    ⇤   │                                                     │
└────────────────────────┴─────────────────────────────────────────────────────┘
```

- **Header:** the sidebar's toggle and the wordmark; the bell and the avatar (`UserMenu`: name and email, Settings, Notifications, Sign out, a way back to
  core when set, and Couldn't sync when anything is there).
- **Sidebar:** _Check in_ first, always one press away; Home, Check-ins, Map, Places; then **Trips**, ongoing first, then upcoming, planning and the latest
  three completed, each with its dot and status; _All trips_ and _New trip_ last. Full or a rail, remembered on the device. Phase 1 shows the Trips
  section only once phase 2 ships.

### 20.3 Screens and addresses

| Address                   | What                                                                                            | Phase |
| ------------------------- | ----------------------------------------------------------------------------------------------- | ----- |
| `/`                       | The landing page for a visitor; Home when signed in (§20.4)                                     | 1     |
| `/checkins`               | The timeline (§20.6), filters in the query; `/c/<id>` one check-in                              | 1     |
| `/map`                    | Every check-in on the map (§20.7)                                                               | 1     |
| `/places`, `/places/<id>` | The person's places by visits; one place (§20.8)                                                | 1     |
| `/trips`                  | Every trip by status (§20.9)                                                                    | 2     |
| `/t/<id>`                 | A trip (§20.10), its view in `?view=` (`overview`, `plan`, `map`, `journal`, `files`, `people`) | 2     |
| `/t/<id>/today`           | Trip Mode (§14.2)                                                                               | 3     |
| `/import`                 | Import from Swarm and its progress (§16)                                                        | 1     |
| `/notifications`          | Every notice (§17)                                                                              | 1     |
| `/settings`               | Settings (§21)                                                                                  | 1     |
| `/invite/<token>`         | An invitation (§11.2), for anyone                                                               | 2     |
| `/sign-in`, `/sign-up`    | As Tusk's                                                                                       | 1     |

The check-in sheet opens over any page (`?checkin=new`, with `&t=` and `&item=` from a trip), so links and the back button behave.

### 20.4 Home

Where the person is, then what is next:

1. **Now:** on an Ongoing trip, its Trip Mode card (the stop, next item and countdown, _Open Trip Mode_); otherwise _Check in_, large, with the nearest of
   their places when the position is known.
2. **Next trip:** its name, dates, "in 23 days", status, members' initials (`AvatarStack`).
3. **Recently:** the last ten check-ins, with photos.
4. **Figures** (§9.5): check-ins this year, places, countries, and a small map of the year.

A new person sees two empty states side by side: _Check in where you are_, and _Plan a trip_, with _Import from Swarm_ under the first.

### 20.5 Checking in

The interaction everything else is built to make quick. `Sheet` on a wide screen, `Drawer` on a narrow one, the same content:

```
┌───────────────────────────────────────────────┐
│  Check in                                 ✕   │
│  [ Here ] [ Search ] [ On the map ]           │  ← Here first when position is allowed
│                                               │
│  ◉ Café Nero              your place · 40 m   │  ← own places, then search results
│  ○ Monmouth Coffee                    120 m   │
│  ○ New place here…                            │
│  ───────────────────────────────────────────  │
│  Now ▾      🔗 Japan 2027 (suggested)  ✕       │  ← moment; the auto-link, changeable
│  Note…                                        │
│  [📷 Add photos]   With… (tags)               │
│  Share with the trip  ◐                       │  ← only when linked to a shared trip
│                               [ Check in ]    │
└───────────────────────────────────────────────┘
```

- Picking a place and pressing Enter checks in; everything below is optional. Saving closes the sheet at once: the check-in is on the device (§15).
- From Trip Mode or an item, the place and the trip are filled in.
- `C` opens it from anywhere when no field has focus; `Esc` closes it.

### 20.6 Check-ins

The timeline: every check-in (the owner's decision), newest first, grouped by day with the day's place count, each row the place, its category's icon, the
time in its zone, the note's first line, the first photo, and the trip's dot and name when linked (with "shared" when it is). **Filters** in the query:
trip, year, category, country, and a search over place names and notes (on the device). On a wide screen a selected check-in opens beside the list
(`SplitPane`); on a narrow one, `/c/<id>` is a page. A check-in's page: the place (linking to its page), the moment, the note, the photos (a viewer, §20.11),
companions, the trip link with _Change_ and _Unlink_, sharing, Edit and Delete.

### 20.7 Map

Every check-in on the map, clustered, coloured by trip where linked; filters as the timeline's; a selected marker shows the place, how many times and the
last visit, opening the place or the check-in. Beside it on a wide screen, the list of what is in view. With the map `off`, the list alone.

### 20.8 A place

Its name, category, address, a small map, **"You've been here 4 times"**, first and last visit, the trips it was part of, and its check-ins newest first.
Rename, recategorize, move its point, merge into another of the person's places (their check-ins move with it), delete (only with no check-ins). `/places`
lists them by visits, with a search.

### 20.9 Trips

`/trips`: status chips (All, Planning, Upcoming, Ongoing, Completed) and a search; trips grouped by status, ongoing first, then upcoming by date, planning,
completed newest first. Each a card: the dot and name, dates and days, the stops' names in order ("Tokyo → Kyoto → Osaka"), status, members' initials, and
one action by status: **Continue planning**, **View plan**, **Open Trip Mode**, **Open journal**. _New trip_ opens a dialog: name, colour, and optionally
the first stop.

### 20.10 A trip

The page the plugin deferred, designed now. A header (dot, name, dates, status, members' initials, the person's role, **Mark ready** or **Back to
planning** for Organizers, _Open Trip Mode_ when ongoing, and a menu), then views as tabs:

- **Overview:** the stops in order with their dates on a map (`StepStrip` for the order), the trip's figures (§13), the next thing for the person, links
  (Tally's first), and for Travelers their sharing choice.
- **Plan:** the plugin's Planner, one workspace: **the stops across the top** (reorderable, re-datable, _Add a stop_ at the end); **the selected stop's
  days below**, each a column on a wide screen or a section on a narrow one, with its title and notes and its items (drag within and between days; _Add_
  at the foot of each). An item opens beside the plan (`SplitPane`) or as a sheet: place or title, kind, times, fixed or flexible (fixed disabled until a
  time is set), notes, the day it is on. Followers see the same, read-only.
- **Map:** the trip's map (§8.2), a day picker to show one day's items, shared check-ins as their own markers.
- **Journal:** §13, day by day, from the first day to today (or the last).
- **Files:** attachments by day and kind, upload by dropping (`FileDropzone`); hidden from Followers.
- **People:** members by role with their initials and names (emails for Organizers), each person's "going" for Organizers, invitations pending,
  **Invite**, role changes and removal for Organizers, **Leave** for everyone.

On a wide screen, _Plan_ and _Map_ can stand side by side (`SplitPane`); the address and data are the same, only what is rendered forks.

### 20.11 Design system

Available and used: layouts, `Header`, `UserMenu`, `NotificationsPanel`, `Sheet`, `Drawer`, `Dialog`, `ConfirmDialog`, `Tabs`, `NavTabs`,
`SegmentedControl`, `SplitPane`, `Combobox`, `SuggestionInput`, `DatePicker`, `Calendar`, `TagInput`, `StepStrip`, `FileDropzone`, `Progress`,
`DragHandleRow`, `Avatar`, `Badge`, `StatusBadge`, `EmptyState`, `Toast`, `Menu`, `CopyButton`, `QrCode`, `MobileFooter`, `MobileHeader`,
`MobileAppsDrawer`, `OfflineGate`, `Auth`, with `@dnd-kit` for dragging.

**Missing, and built in `@sovereignfs/ui` in `sovereign` first, released, then used** (epic 17):

- **`Map`:** MapLibre GL in the suite's style (§8.2), pointed at a style URL the app gives; markers with token colours, clusters, a line, fit to points,
  pick a point, the user's position, attribution; keyboard reachable, with a list alternative the app supplies. Possibly its own entry point
  (`@sovereignfs/ui/map`), so apps without a map do not carry MapLibre.
- **A photo viewer:** a grid of thumbnails opening a full-screen viewer with swipe and keys.
- **A date range picker,** if `DatePicker` and `Calendar` cannot pick a range (checked first): for a stop's arrival and departure.
- **`AvatarStack`** and **a floating action button**, which Tally needs too (its 14.2 and 14.3): one build serves both.

### 20.12 Phone and PWA

**One responsive tree** (the guide's rule): the same routes and decisions at every width, only rendering forked.

- **`MobileFooter`:** Home and Check-ins left of the launcher, Map and Trips right. **Check in** is a floating button above it, opening the drawer. Places,
  Notifications, Import and Settings are in the avatar menu; the bell stays in the header.
- A trip's views are tabs; a check-in, a place and an item are full pages or drawers with a back link. Trip Mode is phone first (§14.2).
- **Installable as a PWA,** as Tusk's §17.9: the service worker keeps the shell by allow-list and the one shell page; offline, a signed-in address is
  answered by the shell, which reads the device's store. **No person's data is ever in the service worker's cache** — except map tiles, which are public
  data, kept for a trip (§14.5). The worker runs Background Sync.

## 21. Settings

`/settings`, from the avatar menu:

- **Profile:** name and email (§6.1); units (kilometres or miles) and the first day of the week.
- **Check-ins:** whether new check-ins on shared trips ask, share or keep private by default (asking is the default, §11.3).
- **Notifications:** each kind (§17) by channel, with what is unavailable said; Trip Mode's default lead time (phase 3); this device's Web Push on or off.
- **This device:** last synced, Couldn't sync, kept tiles and their size, "Reset this device".
- **Sign-in:** password, passkeys, two-factor, linking core, as Tusk's.
- **Data:** import from Swarm (§16), export and import (§22), delete account (§23), storage used against the limit.

## 22. Export and import

- **Export:** one ZIP: a JSON file of the person's places, check-ins with companions and links, settings, and every trip where they are an Organizer or
  Traveler whole (stops, days, items, trip places, links; members by name only; their own and shared check-ins as the journal shows them), with the photos
  and attachments they may see as files beside it. A `format` and `version` at the top. Built by a job, downloaded from Settings > Data within a day, then
  deleted. Other people's emails are never in it. Noted on core's activity page when hosted.
- **Import** makes **new rows** for the importer: places and check-ins (skipping ones already there by id), and trips as new trips with the importer as
  sole Organizer, without the other members (their names kept in the trip's description). Validated whole before anything is written; a file from a
  newer version refused with a sentence.
- **A round trip is a test.**

## 23. Account deletion

**`People.deletePerson`** (`src/sovereign/people.ts`, as Tusk's) removes everything of an account. One routine, safe to run again; the `sub` link goes last.

- **Removed:** their profile, places, check-ins (shared ones included, so they vanish from trips), photos and their files, import jobs and files, settings
  and sharing choices, notices for them, their preferences, push subscriptions, reminders sent, invitations they made (revoked) and to them, their stored
  core token, rate counters, mail queued to them, and better-auth's rows.
- **Their trip memberships end.** A trip where they were the only Organizer passes to the longest-standing Traveler, then Follower, who is told
  (`organizer_passed`); a trip with no other member is deleted with all it holds (§11.4).
- **What they wrote in a shared plan stays,** as the trip's: items, days, attachments, links. `created_by` on those rows is cleared, so nothing points at
  them.

A test seeds one row of every table for the person and for a second person sharing a trip with them, and finds nothing of the first after, the second's
trip intact. A new table that holds something of a person fails it until it is decided.

Reached from **Settings > Data**, after the password or a fresh session, saying what goes; and from **core's account-deleted notice** (§19.2), answered
`200` only once rows and files are gone. The device's database is deleted; other devices find out at their next sync.

## 24. Data model and database

### 24.1 Database

**As Tusk's §23.1, with `WAYMARK_`:** `WAYMARK_DB_DIALECT` is `sqld` (default; namespaces `waymark` and `waymark_auth`), `sqlite` (`file:/data/waymark.db`,
`waymark_auth.db` beside it) or `postgres` (schemas `waymark` and `waymark_auth`). Drizzle, a schema and a migration set per dialect, generated, applied at
start-up under a lock; a parity test across dialects. Standard SQL, values bound; no `LISTEN/NOTIFY`, trigger, extension or foreign key; every deletion
names what it deletes, in a transaction; no sealed column in a condition. Tests run on all three and read `WAYMARK_TEST_*` only.

### 24.2 Representations

As Tusk's column vocabulary: UUIDs, **made by the device for synced rows** (checked, and refused if the id belongs to another owner's row) and by the server
otherwise; moments `epochMs` (`bigint` on PostgreSQL); dates `YYYY-MM-DD`; times `HH:mm`; zones IANA names; order a fractional position; `sealed` a
binary envelope (§18.1).

### 24.3 Tables

Beyond better-auth's, in the auth store. `(s)` marks what is in `sealed`.

| Table                                                   | Columns                                                                                                                                                                                                        | Phase |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| `profile`                                               | `account_id` (key), `core_sub`, `units`, `week_start`, `share_default`, (s) name, email, `created_at`, `updated_at`                                                                                            | 1     |
| `place`                                                 | `id`, `account_id` or `trip_id`, `source`, `tz`, `country_code`, `version`, `seq`, (s) name, lat, lng, address parts, category, source id, `created_at`, `updated_at`                                          | 1     |
| `checkin`                                               | `id`, `account_id`, `place_id`, `at`, `tz`, `offset_min`, `trip_id`, `link_source`, `share` (`trip`, `on`, `off`), `source`, `external_id`, `version`, `seq`, (s) note, companions, `created_at`, `updated_at` | 1     |
| `checkin_photo`                                         | `id`, `checkin_id`, `account_id`, `media_id`, `position`, `seq`                                                                                                                                                | 1     |
| `media`                                                 | `id`, `account_id` or `trip_id`, `kind` (`photo`, `thumb`, `attachment`, `import`), `type`, `bytes`, `state` (`pending`, `ready`), `created_at`                                                                | 1     |
| `account_stream`                                        | `account_id` (key), `seq`                                                                                                                                                                                      | 1     |
| `import_job`                                            | `id`, `account_id`, `source`, `status`, `media_id`, `cursor` (JSON), counts, (s) errors, `created_at`, `updated_at`                                                                                            | 1     |
| `trip`                                                  | `id`, `color`, `start_date`, `end_date`, `ready_at`, `cover_place_id`, `seq`, `created_by`, (s) name, description, `created_at`, `updated_at`                                                                  | 2     |
| `trip_member`                                           | `trip_id`, `account_id` (the key), `role` (`organizer`, `traveler`, `follower`), `going`, `share_checkins` (`ask`, `on`, `off`), `added_by`, `joined_at`, `left_at`, `seq`                                     | 2     |
| `stop`                                                  | `id`, `trip_id`, `place_id`, `arrive`, `depart`, `position`, `version`, `seq`, (s) note, `created_at`, `updated_at`                                                                                            | 2     |
| `day`                                                   | `id`, `trip_id`, `stop_id`, `date`, `version`, `seq`, (s) title, notes                                                                                                                                         | 2     |
| `item`                                                  | `id`, `trip_id`, `day_id`, `place_id`, `kind`, `start`, `end`, `fixed`, `position`, `version`, `seq`, `created_by`, `updated_by`, (s) title, notes, `created_at`, `updated_at`                                 | 2     |
| `attachment`                                            | `id`, `trip_id`, `day_id`, `kind`, `media_id`, `seq`, `created_by`, (s) title, `created_at`                                                                                                                    | 2     |
| `trip_link`                                             | `id`, `trip_id`, `kind` (`tally`, `other`), `position`, `seq`, (s) title, url                                                                                                                                  | 2     |
| `shared_checkin`                                        | `checkin_id` (key), `trip_id`, `account_id`, `seq`, (s) the reader's copy (§15.3)                                                                                                                              | 2     |
| `invitation`                                            | `id`, `trip_id`, `role`, `token_hash` (unique), `invitee_account_id` or (s) email, `core_sub`, `created_by`, `expires_at`, `sent_at`, `accepted_by`, `accepted_at`, `revoked_at`                               | 2     |
| `item_done`                                             | `item_id`, `account_id` (the key), `trip_id`, `at`, `seq`                                                                                                                                                      | 3     |
| `reminder_sent`                                         | `account_id`, `kind`, `subject_id`, `at_key` (the key), `sent_at`                                                                                                                                              | 3     |
| `push_subscription`                                     | `id`, `account_id`, (s) endpoint and keys, `created_at`                                                                                                                                                        | 3     |
| `notice`, `notice_pref`, `mail_outbox`                  | As Tally's, with Waymark's kinds; addresses and content in (s)                                                                                                                                                 | 1     |
| `applied_mutation`, `tombstone`                         | As Tally's, by stream                                                                                                                                                                                          | 1     |
| `credential`, `notice_seen`, `job_claim`, `rate_bucket` | As Tusk's                                                                                                                                                                                                      | 1     |

Indexes follow the queries: check-ins by `(account_id, at)` and `(account_id, seq)`, by `trip_id`; places by owner and `seq`; members by account; stops,
days, items by `(trip_id, seq)` and items by day; shared check-ins by trip; media by owner; notices by account and time; the outbox by
`next_attempt_at`; reminders by key.

## 25. Security, deployment, testing

### Security

As Tusk's §24: a strict CSP with a per-request nonce, `connect-src 'self'` (the map's tiles, glyphs and sprites come from `/api/map`, so MapLibre needs
nothing more, and its web worker is served from the app: `worker-src 'self' blob:` checked in 17.1), no `'unsafe-inline'`; nothing third-party loads; what
people write is rendered as text. **Logs hold no place names, points, notes, titles, search text, names or addresses:** an id and a kind of failure.
Every route, operation and mutation finds the session and carries the permission in its statement (§5.2); a write checks `Origin`. **Server-side
requests** (place search, tiles, import photos, push) go only to configured hosts or the import's allow-list, with timeouts, size caps and no redirect to
elsewhere, and never to a private address. **Uploads** are judged by their bytes. **Rate limits:** place search, tiles, uploads, invitations and the
email lookup, sign-up, sync. A security review is written up before each phase's release, with access, sharing, encryption, files and the server's
outbound requests at its centre.

### Licence

AGPL-3.0-or-later, since it bundles `@sovereignfs/ui`. MapLibre GL (BSD-3), `sharp` and libvips (Apache-2.0 and LGPL-3.0, as a dynamically linked
library), the time-zone table, and the map's fonts are checked for compatibility in the tasks that add them, and their licences shipped in the image.
OpenStreetMap data is ODbL: the attribution is shown on every map.

### Deployment

One image (Debian, for libSQL and `sharp`), not root, on port 3005, and three Compose setups in `deploy/`:

```bash
docker run -v waymark:/data -e WAYMARK_DB_DIALECT=sqlite -e WAYMARK_SQLITE_URL=file:/data/waymark.db \
  -e WAYMARK_URL=https://waymark.example.com -e WAYMARK_AUTH_LOCAL=1 -e WAYMARK_AUTH_SECRET=… -e WAYMARK_ENCRYPTION_KEY=… ghcr.io/sovereignfs/waymark
```

- **Settings:** the shared names of `contracts/env.md`, and Waymark's own: `WAYMARK_WORKER`; `WAYMARK_PLACES_PROVIDER`, `WAYMARK_PLACES_URL`; `WAYMARK_MAP_SOURCE`,
  `WAYMARK_MAP_UPSTREAM_URL`, `WAYMARK_MAP_PMTILES_PATH`, `WAYMARK_MAP_CACHE_MAX_MB`; the limits of §10.8 (`WAYMARK_LIMIT_*`, `WAYMARK_MEDIA_MAX_ACCOUNT_MB`); `WAYMARK_VAPID_PRIVATE_KEY` (phase 3). Each declared
  once in `@sovereignfs/config`, in `.env.example` and in the README.
- **Hosted:** `sv app add waymark`, from the manifest; the operator grants the three app scopes, sets `WAYMARK_SMTP_*` to email people not on the instance and
  `WAYMARK_AUTH_LOCAL=1` to let them make an account, and chooses the map source.
- **A PMTiles file** is the operator's to place under `/data/map`; the README says where to get one (Protomaps' builds) and how large a region is.
- **Releases** as Tusk's: `scripts/release.sh`, a `vX.Y.Z` tag publishes amd64 and arm64 to `ghcr.io`; a patch has no migration.
- `/api/health` answers `200` once the database is ready and `/data` is writable.

### Testing

- **Vitest, pure:** time zones from points and across the date line; auto-link with every tie; the journal; today at the day's edges; figures; with
  hand-worked fixtures.
- **Sealing:** every sealed field of every table round-trips; no sealed field reaches a column in plain text (a test reads the raw database); rotation
  re-wraps and the old key can then go.
- **Sync:** the person's stream and a trip's, two members editing one item, an edit against a delete, a replay, a lost answer, a role lowered between
  syncs (landing in Couldn't sync), a trip left, a photo uploaded after its check-in.
- **Access:** every route, operation and mutation as a second person, and each trip operation as each lower role; a Follower never receives an attachment
  row or file; an unshared check-in never reaches another member's device.
- **Outbound requests:** the import refuses every host outside its allow-list, a redirect out of it, and a private address; the place search keeps one
  request a second to the public instance.
- **Uploads:** an HTML file named `.jpg` refused; a JPEG's location metadata gone after re-encoding.
- **The data layer** on sqld, a `file:` database and PostgreSQL; **jobs** twice and from two processes, doing the work once; the import resumes after a
  kill.
- **Sign-in** against the fake Sovereign, **notices** against `createFakeCore`, **mail** against a fake SMTP server, **place search** and **tiles** against
  local fakes, so no test reaches the internet.
- **Playwright** in Chromium and WebKit, at desktop and phone widths, with location mocked: check in here, offline, with a photo; import a small export;
  plan a trip, invite, accept as each role; a shared check-in seen by a Follower; Trip Mode on a mocked clock.
- **A seed** (`pnpm seed`): accounts in each role, a decade of check-ins across countries, a planning, an upcoming, an ongoing (relative to today) and a
  completed trip with a journal, attachments, a Tally link, and a pending invitation.

## 26. Later, in outline

### 26.1 Reordering a day

**By distance:** _Reorder by distance_ in Trip Mode resequences the day's **flexible** items with a point by straight-line distance from where the person
is, leaving fixed ones at their times, as the plugin planned (its phase 2a). **By routing:** travel time over a road network, from a routing service the
operator runs (OSRM, Valhalla) behind the server, with a travel mode on the day (its phase 2b).

### 26.2 More importers

GPX, KML, GeoJSON and CSV into check-ins or a trip's places; Google Takeout's location history and saved places; the same job, cursor and de-duplication as
Swarm's.

### 26.3 Live updates

Server-sent events per trip in place of the 30-second pull, so a Traveler's check-in reaches a Follower in seconds.

### 26.4 Others noted and not planned

A public page for a trip; parsing booking emails; transport items with departure and arrival places; weather. Not designed; recorded so that they are not
mistaken for decisions.

## 27. Not settled in the platform

- **`AUTH_SIGNUP`'s `invite`** (§6.2) is not in `contracts/env.md`; it is the same task in `sovereign` that Tally waits on (Tally 14.5, here 17.2).
- **The directory as a person** needs the SDK's `tokenStore` fed from better-auth's `genericOAuth`, as Tally's §22; whichever app builds it first settles
  it for both.
- **A VAPID key in `generate`:** the manifest's `generate` makes random secrets; whether it can make an EC P-256 key, or Waymark derives one from a random
  secret, is checked in 12.4, and a gap raised in `sovereign` if needed. Tally's push plan has the same question.
- **`Map` in the design system** brings MapLibre (and its worker) into `@sovereignfs/ui`; whether it is an entry point of its own is the design system's
  call (17.1).
- The kit of research 0004 is not published, so the infrastructure is copied (§5.1).
- `AUTH_LOCAL` accepts `1` and `true` until the contract and the apps agree.
- **Port 3005** is added to building-an-app §2's table.

## 28. Open questions

The eleven choices the first draft made on its own were reviewed by the owner on 2026-11-09 and are in §29. What is left waits on an input, not a decision:

1. **A real Swarm export** is needed before 8.2 fixes the mapping (§16); the owner provides one later.
2. **The default tile upstream** is chosen in 4.3 after reading its terms (§8.1); OpenFreeMap is the candidate.

## 29. Decision log

| Date       | Decision                                                                                                                    | Why                                                                                      |
| ---------- | --------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| 2026-11-09 | An app of its own, Tusk's shape: local and core sign-in, three database forms; **every feature works alone**                | The owner's golden rule for every app                                                    |
| 2026-11-09 | Name **Waymark** (renamed from Roam), prefix `waymark`, port 3005                                                           | Renamed from Roam by the owner; the port is unchanged, and 3004 is Tally's               |
| 2026-11-09 | The plugin's idea kept: **check-ins stand alone; a trip is a folder they fall into by date**                                | It is what makes the product more than a planner or a log                                |
| 2026-11-09 | **All three parts planned now, built one after another** (check-ins, trips, Trip Mode), a release each                      | The owner's direction                                                                    |
| 2026-11-09 | **A map in phase 1,** on OpenStreetMap, drawn with MapLibre from tiles **served by Waymark** (proxy and cache, or PMTiles)  | The owner wants a map now; the suite allows no third-party request from the browser      |
| 2026-11-09 | Place search **from the server only**, Nominatim or Photon, the public instance used within its policy                      | No browser request elsewhere; self-hosting keeps search text in                          |
| 2026-11-09 | **Real shared trips** with invitations, replacing companion tags                                                            | The owner's decision                                                                     |
| 2026-11-09 | Roles by **how one takes part**: Organizer, Traveler, Follower                                                              | The owner asked for real-life roles, not permission levels                               |
| 2026-11-09 | **Check-in from the web** as well as the phone                                                                              | The owner's decision; one responsive app                                                 |
| 2026-11-09 | **Swarm import first;** other importers later                                                                               | The owner's decision                                                                     |
| 2026-11-09 | A trip is **Planning until marked ready,** then its dates decide; it can go back                                            | The owner's decision, replacing the plugin's purely derived status                       |
| 2026-11-09 | The timeline shows **every check-in**, with its trip                                                                        | The owner's decision                                                                     |
| 2026-11-09 | **Auto-link:** local date, then the nearest stop, then the shorter trip; a manual link is never changed                     | Left to the draft by the owner; the plugin's rule with distance added                    |
| 2026-11-09 | Keep the words **"stop"** and **"check-in"**                                                                                | The owner's decision                                                                     |
| 2026-11-09 | The **trip page** and **planned versus actual** designed now; the Planner becomes a trip's Plan view                        | The owner's decision                                                                     |
| 2026-11-09 | A trip **links to its Tally group** by address, nothing more                                                                | The owner's decision; no app imports another                                             |
| 2026-11-09 | **Encryption at rest on the server** (envelope under `WAYMARK_ENCRYPTION_KEY`), sealing places, points and words, and files | The owner chose it over end to end and per-trip keys; sharing then needs no key exchange |
| 2026-11-09 | **Check-ins private by default** on shared trips, shared by choice                                                          | Left to the draft by the owner; location history is the most sensitive data              |
| 2026-11-09 | **Waymark keeps its own profile** (name, email); no placeholders                                                            | No dependence on core for who someone is; every member signs in to use a role            |
| 2026-11-09 | **Files are Waymark's own,** under `/data`                                                                                  | The suite's rule: file storage is the app's concern, never core's                        |
| 2026-11-09 | **No reward mechanics** in any phase                                                                                        | Carried over from the plugin                                                             |
| 2026-11-09 | **No migration** from the plugin; interface designed anew                                                                   | No data needs to move; the owner's direction                                             |
| 2026-11-09 | **Places belong to a person or a trip,** one shape, replacing the plugin's one shared table                                 | Shared trips and complete deletion; a count is read within a person's places             |
| 2026-11-09 | **Only Organizers invite** and change roles                                                                                 | The trip's people stay under its Organizers' control                                     |
| 2026-11-09 | **Followers never see attachments**                                                                                         | Bookings carry names, numbers and addresses                                              |
| 2026-11-09 | Sharing check-ins **asked once per trip,** overridable per check-in; Followers see shared ones                              | Private by default, without asking on every check-in                                     |
| 2026-11-09 | **Check-ins, items and day notes sync offline;** trips, stops, roles and attachments are online; items keep no history      | A plan is edited on the road; stop dates reshape days, which the server must decide      |
| 2026-11-09 | Photos **re-encoded with all metadata removed;** the original is not kept                                                   | A photo may be shared with a trip; location in its metadata must not travel              |
| 2026-11-09 | **Web Push in phase 3,** with reminders                                                                                     | It matters most for Trip Mode's reminders                                                |
| 2026-11-09 | **Dates and times stay readable;** places, points and words are sealed                                                      | The database orders the timeline and finds auto-link candidates                          |
| 2026-11-09 | **Every limit is a setting;** files default to **500 MB an account**                                                        | The owner's decision; operators size their own server                                    |
