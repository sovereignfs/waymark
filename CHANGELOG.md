# Changelog

All notable changes to Waymark are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

Each release's section is also its GitHub release notes: the release workflow reads this file when a release is cut. Write the notes under
`## [Unreleased]` as you go; a release turns them into the version's section.

## [Unreleased]

### Added

- The repository's conventions: licence, contributing guide, pull request template, dependency updates, and the package that the app is built in.
- Settings, all named `WAYMARK_…`, checked when the server starts: a wrong or missing one stops it, naming every problem and no value. `WAYMARK_ENCRYPTION_KEY` is required.
- The database: sqld (the default), a SQLite file or PostgreSQL, chosen with `WAYMARK_DB_DIALECT`, provisioned and migrated when the server starts; it waits for a database that is still starting and stops, saying why, if it cannot use it. `/api/health` answers for it.
- Every page is sent with a strict Content-Security-Policy (a nonce for each request, nothing third-party, no inline script), and every response with the usual security headers; the app may ask where the device is, and nothing else about it.
- The app's frame: a header with the wordmark, a sidebar (Home, Check-ins, Map, Places) that is full or a rail and remembered on the device, and on a phone a footer and a navigation drawer, in light and dark. Each place is an empty page for now.
- Background jobs run in the web process (`WAYMARK_WORKER=off` turns them off in all but one process that shares a database) and stop when the server is told to; a job's work is claimed in the database, so two processes never do it twice.
- Waymark installs as an app, and a service worker keeps its own files and nothing of anyone's: no page, no answer, no place or note is ever in its cache. With no connection a page says it needs one.
- One image for all three database forms, with `/data` a volume in each of the three Compose setups (`deploy/`).
- Signing in with an email and password, when `WAYMARK_AUTH_LOCAL=1`: the first account is made on the sign-up page, and `WAYMARK_AUTH_SIGNUP=closed` (the default) refuses every later one; `open` lets anyone make one. With local sign-in off the sign-in pages and routes do not exist. With `WAYMARK_SMTP_HOST` set an address is confirmed by a link and a forgotten password is reset by one.
- Passkeys and an authenticator app are supported by the sign-in; setting them up is in Settings, which is to come.
- Sealed rows: every field that says where or what (a place's name and point, a note, a trip's name, a person's name and address) is written into one encrypted envelope per row, under `WAYMARK_ENCRYPTION_KEY`, bound to its table and row, so that a copy of the database holds none of it.
- Every account has a profile of its own: its name and address are kept by Waymark, sealed, from the day the account is made, and are what the app shows of a person; an address is seen only by its owner and, once there are trips, by a trip's Organizers.
- The front address is a short page about Waymark for a visitor, with a way to sign in (and to sign up, where the server takes sign-ups), and Home for someone signed in; Home's own address, `/home`, goes to `/`.
- Photos and files: an upload is judged by its bytes (an HTML page named `.jpg` is refused), an image is turned upright and re-encoded with its location and every other piece of metadata removed, and every file is sealed on disk under `/data/media`, served only to its owner. `WAYMARK_DATA_DIR` (default `/data`) and `WAYMARK_MEDIA_MAX_ACCOUNT_MB` (default 500) are new settings, and `/api/health` now needs the data directory to be writable.
- Deleting an account removes everything of it in one routine that can be run again: its files from disk and then their rows, its profile and counters, and its sign-in. It asks for the password (or, for an account that has none, a sign-in made in the last ten minutes) and says how many files go.
- Settings, from the avatar menu: your name, units (kilometres or miles) and the first day of the week; your password, authenticator app, passkeys and the devices you are signed in on; how much of your room your files use, and deleting your account. It needs a connection and says so when there is none.
- A point's time zone is found on the server and the device with no network, and the local date, time and offset of a moment in a zone are worked out in one place, so a check-in at 23:59 is on the right day on either side of the date line.
