# Epics

A domain-first map of the work. An epic groups the tasks of one domain. [`ROADMAP.md`](../../ROADMAP.md) is the same tasks in the order they are
built, with their priority and status. [`DESIGN.md`](../../DESIGN.md) is what they build; where a task and the design disagree, the design wins and
the task is corrected.

## Conventions

- **Task IDs are permanent:** `<epic>.<n>`, for example `4.3`. Use them in dependency lists and cross-references. They never appear in branch names,
  commit messages or PR titles, and an ID is never reused, even for a task that was superseded.
- **One task, one branch, one draft PR.** A task is done when its "Accepts when" holds and its PR is merged.
- **Every task** has a Goal, a Design reference, what it Depends on, Technical detail, and Accepts when. Once done it gains **Done as**: how it was
  done, where, and what was left out.
- **On completion,** the task's heading here and its row in `ROADMAP.md` are marked ✅ in the same PR, and a change in behaviour adds a line to
  `CHANGELOG.md`.
- **Every task holds these without saying so:** a data-layer test passes on sqld, a `file:` database and PostgreSQL; a new route, operation or
  mutation is in `src/access/routes.ts` with a test calling it as a second person, and each trip operation as each lower role (once 9.1 and 10.1 are in);
  every sensitive field of a new table is sealed through `src/crypto/sealed.ts` and listed in its table of what is sealed (once 3.1 is in); a new table is
  handled by `People.deletePerson` (once 2.5 is in) and by export and import (once 15.1 is in); a write of synced rows goes through the one path (once 5.2
  is in); a screen works with a keyboard, in light and dark, at a phone's width, and offline where `DESIGN.md` §15 says it does; no place name, point,
  note, title, search, name or address reaches a log; no request leaves the browser for another origin; a safeguard's test was seen to fail with it
  switched off.
- **Epic 17 is done in `sovereign`,** following that repository's conventions; its tasks here record what Roam needs and are marked done when the
  release that carries it is published. Where Tally needs the same, one build serves both.

_Status key: ✅ Done · ⏳ In progress · 📋 Planned · 🚧 Waits on a decision or an input · ➖ Superseded_

## Epics

| #   | Epic                                    | What it holds                                                                                    | Phase | Tasks |
| --- | --------------------------------------- | ------------------------------------------------------------------------------------------------ | ----- | ----- |
| 1   | [Foundation](foundation.md)             | Tooling, CI, configuration, the database, jobs, the shell, the image, the PWA                    | 1     | 11    |
| 2   | [Accounts and sign-in](accounts.md)     | Local and Sovereign sign-in, profiles, notices, deleting a person, the landing page, Settings    | 1     | 7     |
| 3   | [Encryption and media](encryption.md)   | Sealed rows, the media store, rotating the key                                                   | 1     | 3     |
| 4   | [Places and the map](places.md)         | Places, finding a place, the tile service, time zones                                            | 1     | 4     |
| 5   | [Check-ins](checkins.md)                | Actions and validators, the write path, photos, figures                                          | 1     | 4     |
| 6   | [Offline and sync](sync.md)             | The endpoint, the device's store, Couldn't sync, opening offline, photos waiting, trips, pruning | 1, 2  | 7     |
| 7   | [Check-in screens](screens.md)          | The shell's places, checking in, the timeline, the map, places, Home, the phone                  | 1     | 7     |
| 8   | [Import](import.md)                     | Import jobs, reading a Swarm export, the import screen                                           | 1     | 3     |
| 9   | [Trips](trips.md)                       | Trips and access, stops and days, items, status, attachments, links, auto-link                   | 2     | 7     |
| 10  | [Sharing](sharing.md)                   | Roles, invitations, sharing check-ins, leaving and handing over                                  | 2     | 4     |
| 11  | [Trip screens](trip-screens.md)         | Trips, a trip, the plan, the map, the journal, files and links, people, the phone                | 2     | 8     |
| 12  | [Notices](notices.md)                   | Notices and the bell, the mail outbox, preferences and email, Web Push                           | 1, 3  | 4     |
| 13  | [Trip Mode](trip-mode.md)               | Today, the screen, Directions, reminders, a trip offline                                         | 3     | 5     |
| 14  | [The suite](suite.md)                   | Core's bell, email, activity and directory                                                       | 1, 2  | 2     |
| 15  | [Portability](portability.md)           | Export and import, then trips in them                                                            | 1, 2  | 3     |
| 16  | [Release](release.md)                   | Seed, security reviews, documents, the three releases, hosting                                   | 1–3   | 7     |
| 17  | [Upstream, in `sovereign`](upstream.md) | `Map`, `AUTH_SIGNUP`, the port, `AvatarStack`, a floating button, a photo viewer, a date range   | 1, 2  | 7     |
