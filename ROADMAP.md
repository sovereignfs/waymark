# Roadmap

The order of work. **This file tracks progress; it does not define behaviour.** [`DESIGN.md`](DESIGN.md) says what Waymark does, and where it disagrees with
this file, this file is stale and should be corrected. The detail of every task, with its technical notes and what makes it done, is in
[`docs/epics/`](docs/epics/). How a task is run is in [`AGENTS.md`](AGENTS.md).

State as of 2026-11-09: **Milestone A in progress** (1.1, 1.2 done). The developer assigns each task; the first row not done, with its dependencies met, is what the order
recommends.

_Status key: ✅ Done · ⏳ In progress · 📋 Planned · 🚧 Waits on a decision or an input · ➖ Superseded_

_Priority:_ **P0** nothing else can stand without it · **P1** the product · **P2** needed before the phase's release · **P3** can follow the release if it
must

## How this is ordered

Three phases, each a release (`DESIGN.md` §2): **check-ins** (0.1.0), **trips** (0.2.0), **Trip Mode** (0.3.0). Within phase 1, Tusk's order (building-an-app
§14): conventions, configuration, database, sign-in, the shell, then the product, then the image and the release. Within the product:

1. **Sealing before any table of the product** (B), so that no place or note is ever written in plain text, not even in a first draft.
2. **Places and the map before check-ins** (C): a check-in points at a place, and the map needs its tile service and its component.
3. **The write path and offline before the screens** (D), because the screens read the device's store: building them on server reads first would mean
   building them twice. This is Tally's order.
4. **The screens** (E), then **the Swarm import and notices** (F), which fill the screens with history and say when it is done.
5. **The suite and portability** (G), then the release. Sign-in through core is P0 but can come late, as in Tusk, Ledger and Tally: nothing before it
   depends on it.

Phase 2 builds trips and their data first (H), then sharing (I), then the trip screens (J). Phase 3 builds today's plan as a pure function before its screen,
and Web Push before reminders (L).

**Epic 17 is work in `sovereign`**, tracked here because Waymark waits on it: the map component, a photo viewer, a date range picker, `AvatarStack` and a
floating button (the last two shared with Tally), and the `invite` sign-up value (shared with Tally). Each is started early enough to be released before the
task that needs it.

## Phase 1 — Check-ins (0.1.0)

### Milestone A — Foundation

The repository can hold the app. Nothing a person would notice. **Done when** an empty database boots on all three forms from the image, with `/data`
writable, and CI proves it.

| #   | ID                               | Task                             | Priority | Depends on | Status |
| --- | -------------------------------- | -------------------------------- | -------- | ---------- | ------ |
| 1   | [1.1](docs/epics/foundation.md)  | Repository conventions           | P0       | —          | ✅     |
| 2   | [1.2](docs/epics/foundation.md)  | Format, lint and test tooling    | P0       | 1.1        | ✅     |
| 3   | [1.3](docs/epics/foundation.md)  | Continuous integration           | P0       | 1.2        | 📋     |
| 4   | [1.4](docs/epics/foundation.md)  | Configuration and start-up       | P0       | 1.2        | 📋     |
| 5   | [1.5](docs/epics/foundation.md)  | The database layer               | P0       | 1.4        | 📋     |
| 6   | [1.8](docs/epics/foundation.md)  | Design system boundary and shell | P0       | 1.2        | 📋     |
| 7   | [1.7](docs/epics/foundation.md)  | Security headers                 | P0       | 1.4        | 📋     |
| 8   | [1.6](docs/epics/foundation.md)  | The job runner                   | P0       | 1.5        | 📋     |
| 9   | [1.9](docs/epics/foundation.md)  | Browser tests                    | P0       | 1.5        | 📋     |
| 10  | [1.10](docs/epics/foundation.md) | The image and deployment setups  | P0       | 1.5, 1.6   | 📋     |
| 11  | [1.11](docs/epics/foundation.md) | The PWA                          | P1       | 1.8        | 📋     |

### Milestone B — Accounts and sealed data

A person signs in, and everything sensitive they will write is sealed and their files are stored safely. **Done when** a raw read of the database shows no
name in plain text, and deleting a person leaves nothing of them.

| #   | ID                              | Task                             | Priority | Depends on | Status |
| --- | ------------------------------- | -------------------------------- | -------- | ---------- | ------ |
| 12  | [2.1](docs/epics/accounts.md)   | Local sign-in                    | P0       | 1.5, 1.8   | 📋     |
| 13  | [3.1](docs/epics/encryption.md) | Sealed rows                      | P0       | 1.5        | 📋     |
| 14  | [2.7](docs/epics/accounts.md)   | Profiles                         | P0       | 2.1, 3.1   | 📋     |
| 15  | [2.2](docs/epics/accounts.md)   | Landing page and the address `/` | P1       | 2.1        | 📋     |
| 16  | [3.2](docs/epics/encryption.md) | The media store                  | P0       | 3.1, 1.6   | 📋     |
| 17  | [2.6](docs/epics/accounts.md)   | Settings                         | P1       | 2.7, 1.8   | 📋     |
| 18  | [2.5](docs/epics/accounts.md)   | Deleting a person                | P0       | 2.7, 3.2   | 📋     |

### Milestone C — Places and the map

Places can be found and made, and a map can be drawn with nothing loaded from elsewhere. **Done when** a place is found through the configured search, a
map of it renders in light and dark from Waymark's own tiles, and the browser made no request off the app's origin.

| #   | ID                             | Task                   | Priority | Depends on | Status |
| --- | ------------------------------ | ---------------------- | -------- | ---------- | ------ |
| 19  | [17.1](docs/epics/upstream.md) | `Map` (`sovereign`)    | P0       | —          | 📋     |
| 20  | [4.4](docs/epics/places.md)    | Time zones from points | P0       | 1.2        | 📋     |
| 21  | [4.1](docs/epics/places.md)    | Places                 | P0       | 3.1, 4.4   | 📋     |
| 22  | [4.2](docs/epics/places.md)    | Finding a place        | P0       | 4.1, 1.7   | 📋     |
| 23  | [4.3](docs/epics/places.md)    | The tile service       | P0       | 1.10, 1.6  | 📋     |

### Milestone D — Check-ins and offline

Check-ins are written through the one path, on the device first. **Done when** a check-in with a photo made with the network off reaches the server once
back online, appears on a second device of the same account, and a replay writes nothing.

| #   | ID                            | Task                                | Priority | Depends on | Status |
| --- | ----------------------------- | ----------------------------------- | -------- | ---------- | ------ |
| 24  | [5.1](docs/epics/checkins.md) | Actions and validators              | P0       | 4.1        | 📋     |
| 25  | [5.2](docs/epics/checkins.md) | Applying a mutation                 | P0       | 5.1        | 📋     |
| 26  | [5.3](docs/epics/checkins.md) | Photos                              | P0       | 5.2, 3.2   | 📋     |
| 27  | [6.1](docs/epics/sync.md)     | The sync endpoint                   | P0       | 5.2        | 📋     |
| 28  | [6.2](docs/epics/sync.md)     | The device's store, outbox and loop | P0       | 6.1        | 📋     |
| 29  | [6.3](docs/epics/sync.md)     | Couldn't sync                       | P1       | 6.2        | 📋     |
| 30  | [6.5](docs/epics/sync.md)     | Photos waiting                      | P1       | 6.2, 5.3   | 📋     |
| 31  | [6.4](docs/epics/sync.md)     | Opening offline                     | P1       | 6.2, 1.11  | 📋     |
| 32  | [5.4](docs/epics/checkins.md) | Figures                             | P1       | 4.1        | 📋     |
| 33  | [6.7](docs/epics/sync.md)     | Keeping the history small           | P2       | 6.1, 1.6   | 📋     |

### Milestone E — The check-in screens

The interface of `DESIGN.md` §20 for phase 1, on the device's data. **Done when** a person can check in by each way, read their timeline, find a place and
see everything on the map, at desktop and phone widths, with the keyboard, in light and dark.

| #   | ID                             | Task                                        | Priority | Depends on     | Status |
| --- | ------------------------------ | ------------------------------------------- | -------- | -------------- | ------ |
| 34  | [17.4](docs/epics/upstream.md) | `AvatarStack` (`sovereign`, with Tally)     | P1       | —              | 📋     |
| 35  | [17.5](docs/epics/upstream.md) | A floating button (`sovereign`, with Tally) | P1       | —              | 📋     |
| 36  | [17.6](docs/epics/upstream.md) | A photo viewer (`sovereign`)                | P1       | —              | 📋     |
| 37  | [7.1](docs/epics/screens.md)   | The shell's places                          | P1       | 6.2            | 📋     |
| 38  | [7.2](docs/epics/screens.md)   | Checking in                                 | P1       | 7.1, 4.2, 17.1 | 📋     |
| 39  | [7.3](docs/epics/screens.md)   | The timeline and a check-in                 | P1       | 7.2, 17.6      | 📋     |
| 40  | [7.4](docs/epics/screens.md)   | The map                                     | P1       | 7.3, 4.3, 17.1 | 📋     |
| 41  | [7.5](docs/epics/screens.md)   | Places and a place                          | P1       | 7.3            | 📋     |
| 42  | [7.6](docs/epics/screens.md)   | Home                                        | P1       | 7.3, 5.4, 17.4 | 📋     |
| 43  | [7.7](docs/epics/screens.md)   | The phone                                   | P1       | 7.6, 17.5      | 📋     |

### Milestone F — History and notices

Years of Swarm history arrive, and people hear when they do. **Done when** a real Swarm export imports with its photos, survives a restart halfway, and a
second run creates nothing; and the bell and email say it finished.

| #   | ID                            | Task                   | Priority | Depends on | Status |
| --- | ----------------------------- | ---------------------- | -------- | ---------- | ------ |
| 44  | [8.1](docs/epics/import.md)   | Import jobs            | P1       | 3.2, 1.6   | 📋     |
| 45  | [8.2](docs/epics/import.md)   | Reading a Swarm export | P1       | 8.1, 5.2   | 🚧     |
| 46  | [8.3](docs/epics/import.md)   | The import screen      | P1       | 8.2, 7.1   | 📋     |
| 47  | [12.1](docs/epics/notices.md) | Notices and the bell   | P1       | 7.1        | 📋     |
| 48  | [12.2](docs/epics/notices.md) | The mail outbox        | P1       | 1.6        | 📋     |
| 49  | [12.3](docs/epics/notices.md) | Preferences and email  | P1       | 12.1, 12.2 | 📋     |

8.2 waits on a real Swarm export from the owner (`DESIGN.md` §28); its job and screens do not.

### Milestone G — The suite, the person's data, and 0.1.0

Part of the suite, and a person can take their data and leave. **Done when** it signs in through core, honours both notices, a person's check-ins and
photos round-trip through a file, and 0.1.0 is published and hosted on the live instance.

| #   | ID                                | Task                                      | Priority | Depends on      | Status |
| --- | --------------------------------- | ----------------------------------------- | -------- | --------------- | ------ |
| 50  | [2.3](docs/epics/accounts.md)     | Sign-in through core                      | P0       | 2.1, 2.7        | 📋     |
| 51  | [2.4](docs/epics/accounts.md)     | Core's notices                            | P0       | 2.3, 2.5        | 📋     |
| 52  | [14.1](docs/epics/suite.md)       | Core's bell, email, activity              | P2       | 2.3, 12.3       | 📋     |
| 53  | [15.1](docs/epics/portability.md) | Export                                    | P2       | 5.3, 1.6        | 📋     |
| 54  | [15.2](docs/epics/portability.md) | Import                                    | P2       | 15.1            | 📋     |
| 55  | [3.3](docs/epics/encryption.md)   | Rotating the key                          | P2       | 3.1, 3.2        | 📋     |
| 56  | [16.1](docs/epics/release.md)     | Development seed                          | P1       | 5.3, 4.1        | 📋     |
| 57  | [17.3](docs/epics/upstream.md)    | Waymark's port in the guide (`sovereign`) | P3       | —               | 📋     |
| 58  | [16.3](docs/epics/release.md)     | Documents                                 | P2       | 1.10, 4.3       | 📋     |
| 59  | [16.2](docs/epics/release.md)     | Security review, phase 1                  | P2       | 8.3, 15.2, 14.1 | 📋     |
| 60  | [16.4](docs/epics/release.md)     | Release 0.1.0                             | P2       | 16.2, 16.3      | 📋     |
| 61  | [16.5](docs/epics/release.md)     | Hosting on an instance                    | P2       | 16.4            | 📋     |

## Phase 2 — Trips (0.2.0)

### Milestone H — Trips and the plan

Trips of stops, days and items, on the server and on the device. **Done when** a trip is planned, marked ready, re-dated without losing an item silently,
and its check-ins link themselves by the rule of `DESIGN.md` §12.

| #   | ID                         | Task                        | Priority | Depends on    | Status |
| --- | -------------------------- | --------------------------- | -------- | ------------- | ------ |
| 62  | [9.1](docs/epics/trips.md) | Trips, members and access   | P0       | 2.7, 4.1      | 📋     |
| 63  | [9.2](docs/epics/trips.md) | Stops, days and trip places | P0       | 9.1, 4.4      | 📋     |
| 64  | [9.3](docs/epics/trips.md) | Items                       | P0       | 9.2           | 📋     |
| 65  | [9.4](docs/epics/trips.md) | Ready and status            | P1       | 9.2           | 📋     |
| 66  | [6.6](docs/epics/sync.md)  | Trips on the device         | P0       | 9.3, 6.2      | 📋     |
| 67  | [9.7](docs/epics/trips.md) | Auto-link                   | P1       | 9.2, 6.6, 5.2 | 📋     |
| 68  | [9.5](docs/epics/trips.md) | Attachments                 | P1       | 9.1, 3.2      | 📋     |
| 69  | [9.6](docs/epics/trips.md) | Links                       | P1       | 9.1           | 📋     |

### Milestone I — Sharing

Trips with the people going and the people following. **Done when** an Organizer invites a Traveler and a Follower who accept, each can do exactly what
their role allows and nothing more, and a check-in reaches the trip only when shared.

| #   | ID                             | Task                                                  | Priority | Depends on       | Status |
| --- | ------------------------------ | ----------------------------------------------------- | -------- | ---------------- | ------ |
| 70  | [17.2](docs/epics/upstream.md) | `AUTH_SIGNUP` by invitation (`sovereign`, with Tally) | P1       | —                | 📋     |
| 71  | [10.1](docs/epics/sharing.md)  | Roles                                                 | P0       | 9.1              | 📋     |
| 72  | [10.2](docs/epics/sharing.md)  | Invitations                                           | P1       | 10.1, 12.2, 17.2 | 📋     |
| 73  | [10.3](docs/epics/sharing.md)  | Sharing check-ins with a trip                         | P1       | 10.1, 6.6, 9.7   | 📋     |
| 74  | [10.4](docs/epics/sharing.md)  | Leaving, removing and handing over                    | P1       | 10.1, 10.3       | 📋     |
| 75  | [14.2](docs/epics/suite.md)    | Core's directory                                      | P2       | 2.3, 10.2        | 📋     |

### Milestone J — The trip screens

The trip page the plugin deferred. **Done when** a trip goes from a name to a completed journal in a browser, as each role, at desktop and phone widths.

| #   | ID                                 | Task                              | Priority | Depends on       | Status |
| --- | ---------------------------------- | --------------------------------- | -------- | ---------------- | ------ |
| 76  | [17.7](docs/epics/upstream.md)     | A date range picker (`sovereign`) | P1       | —                | 📋     |
| 77  | [11.1](docs/epics/trip-screens.md) | Trips                             | P1       | 9.4, 6.6, 7.1    | 📋     |
| 78  | [11.2](docs/epics/trip-screens.md) | A trip and its overview           | P1       | 11.1, 17.4       | 📋     |
| 79  | [11.3](docs/epics/trip-screens.md) | The plan                          | P1       | 11.2, 9.3, 17.7  | 📋     |
| 80  | [11.4](docs/epics/trip-screens.md) | The trip's map                    | P1       | 11.2, 17.1       | 📋     |
| 81  | [11.5](docs/epics/trip-screens.md) | Planned versus actual             | P1       | 11.2, 10.3       | 📋     |
| 82  | [11.6](docs/epics/trip-screens.md) | Files and links                   | P1       | 11.2, 9.5, 9.6   | 📋     |
| 83  | [11.7](docs/epics/trip-screens.md) | People                            | P1       | 11.2, 10.2, 10.4 | 📋     |
| 84  | [11.8](docs/epics/trip-screens.md) | The phone, for trips              | P1       | 11.3–11.7        | 📋     |

### Milestone K — 0.2.0

**Done when** 0.2.0 is published and hosted.

| #   | ID                                | Task                              | Priority | Depends on       | Status |
| --- | --------------------------------- | --------------------------------- | -------- | ---------------- | ------ |
| 85  | [15.3](docs/epics/portability.md) | Trips in export and import        | P2       | 15.2, 9.6, 10.3  | 📋     |
| 86  | [16.6](docs/epics/release.md)     | Security review and release 0.2.0 | P2       | 11.8, 15.3, 14.2 | 📋     |

## Phase 3 — Trip Mode (0.3.0)

### Milestone L — Trip Mode

Today on a trip. **Done when** on a mocked clock across a date line, Trip Mode shows the right day and next item, Directions opens the device's maps, a
reminder arrives by Web Push once, and the day's plan and map open offline.

| #   | ID                              | Task                 | Priority | Depends on      | Status |
| --- | ------------------------------- | -------------------- | -------- | --------------- | ------ |
| 87  | [13.1](docs/epics/trip-mode.md) | Today                | P0       | 9.3, 4.4        | 📋     |
| 88  | [13.2](docs/epics/trip-mode.md) | The Trip Mode screen | P1       | 13.1, 11.4, 7.2 | 📋     |
| 89  | [13.3](docs/epics/trip-mode.md) | Directions           | P1       | 13.2            | 📋     |
| 90  | [12.4](docs/epics/notices.md)   | Web Push             | P1       | 12.3, 1.11      | 📋     |
| 91  | [13.4](docs/epics/trip-mode.md) | Reminders            | P1       | 13.1, 12.4      | 📋     |
| 92  | [13.5](docs/epics/trip-mode.md) | A trip offline       | P1       | 13.2, 6.6, 1.11 | 📋     |

### Milestone M — 0.3.0

| #   | ID                            | Task                              | Priority | Depends on       | Status |
| --- | ----------------------------- | --------------------------------- | -------- | ---------------- | ------ |
| 93  | [16.7](docs/epics/release.md) | Security review and release 0.3.0 | P2       | 13.3, 13.4, 13.5 | 📋     |

## Later — candidates

None committed (`DESIGN.md` §26): reordering a day by distance, then by routing; GPX, KML, GeoJSON, CSV and Google Takeout importers; live updates.
