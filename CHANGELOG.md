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
