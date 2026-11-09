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
