# Changelog

All notable changes to Waymark are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

Each release's section is also its GitHub release notes: the release workflow reads this file when a release is cut. Write the notes under
`## [Unreleased]` as you go; a release turns them into the version's section.

## [Unreleased]

### Added

- The repository's conventions: licence, contributing guide, pull request template, dependency updates, and the package that the app is built in.
- Settings, all named `WAYMARK_…`, checked when the server starts: a wrong or missing one stops it, naming every problem and no value. `WAYMARK_ENCRYPTION_KEY` is required.
