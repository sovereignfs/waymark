# Releasing

A release of Waymark is cut with `scripts/release.sh`:

```bash
scripts/release.sh check   0.1.0                 # read-only preflight
scripts/release.sh prepare 0.1.0                 # branch, bump, gate, commit locally
scripts/release.sh propose 0.1.0 [--dry-run]     # push the branch, open a draft PR
scripts/release.sh tag     0.1.0 [--dry-run]     # after the PR merges: tag, watch, verify
scripts/release.sh verify  0.1.0                 # check a published release
```

`main` takes changes only through pull requests ([`AGENTS.md`](AGENTS.md) § Working conventions), and a release is a change like any other:

1. **`prepare`** cuts `chore/release-waymark-0.1.0` from an up-to-date `main`, promotes `[Unreleased]` in `CHANGELOG.md` to the new version, bumps `version` in
   `package.json`, checks that the tag will start the release workflow and find its notes, runs the gates (install, format, lint, types, tests, the manifest, build),
   and makes one commit, `Release waymark 0.1.0`. Read it with `git show --stat HEAD`. It never pushes, and puts everything back, the branch included, if anything fails.
2. **`propose`** pushes that branch and opens a **draft** PR into `main` with the notes as its body, then stops.
3. A person marks the PR ready (which runs CI) and merges it with **rebase and merge**. That is the review.
4. **`tag`**, on `main` after `git pull`, checks that the latest commit is the release commit, waits for CI on that exact commit, tags it, watches the release workflow,
   titles the release and verifies it.

`tag` is separate from the merge because a rebase-and-merge gives the commit a new SHA, and it is the merged commit that CI has to vouch for and that is tagged. For
the same reason CI also runs on pushes to `main`.

`publish`, which would push `main` and tag in one go, does not exist; it prints this list and exits.

Every check in the script is there because a release went wrong without it (in Fjord's, whose release process this is). The script has its own tests,
`scripts/test-release.sh`, run against throwaway repositories with a stand-in for `gh`; CI runs them when `scripts/` changes.

## What a tag does

`.github/workflows/publish.yml`, in this order, and a failure at any step publishes nothing after it:

1. **Checks the app** at the tag: the tag names the version in `package.json`, and the manifest, types, tests and build pass.
2. **Builds the image** (the `Dockerfile`, with the port and label `sovereign-manifest docker-args` makes from `sovereign.manifest.json`) for `linux/amd64` and
   `linux/arm64`, each on a runner of its own kind (libSQL's native client differs by architecture, and arm64 under emulation would take most of an hour). Each is pushed
   by digest only, with no tag, so a half-published release cannot be pulled.
3. **Joins them** as `ghcr.io/<owner>/waymark:X.Y.Z`, `:X.Y` and `:latest`, checks both platforms are in it, and **attests its build provenance** (a signed statement of the
   commit and workflow that built it; `gh attestation verify oci://ghcr.io/<owner>/waymark:X.Y.Z --owner <owner>`).
4. **Pulls the published image by digest and brings it up** with `scripts/deploy-check.sh file sovereign`, as an operator would (healthy, a restart, SIGTERM in seconds) and as
   a Sovereign instance would host it (the image's label is `sovereign.manifest.json`; it listens on the `PORT` it is given; it offers Sovereign and no password).
5. **Publishes the GitHub release page**, whose notes are the changelog's section and the image's name, marked Latest. This is last, so a release page means an image
   that was pulled and run.

Run by hand from the Actions tab (_Publish_, on a branch) it does steps 1 and 2 and throws the images away: that is how a change to the workflow or the Dockerfile is
tried before a tag exists.

`scripts/release.sh verify X.Y.Z` also looks at the registry (both platforms) and warns if it cannot. **The first time**, GitHub creates the package private: open it
(the organisation's _Packages_, `waymark`, _Package settings_) and make it public, or nobody but the organisation can pull it. That is the one step no workflow can do.

## Versions

Waymark is `0.x` and follows [Semantic Versioning](https://semver.org/), with what that means for an application that has a database and settings:

| Release                        | May contain                                                                                                                                                                                               | Never contains                                                                                                                                                              |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Patch** `X.Y.Z+1`            | Fixes.                                                                                                                                                                                                    | A migration, or a setting added, renamed or removed. `release.sh` refuses a patch release if anything under `migrations/` changed since the previous release of that minor. |
| **Minor** `X.Y+1.0`            | Features; migrations (forward-only, applied at start-up); new settings. While the major is `0` also changes that break (a setting renamed, behaviour changed), each marked **breaking** in the changelog. | A migration or a setting change that is not in the changelog.                                                                                                               |
| **Major** `X+1.0.0` (from 1.0) | Breaking changes.                                                                                                                                                                                         | —                                                                                                                                                                           |

What follows for someone running it (`deploy/README.md` § Updating): a patch release can be installed and, if it is bad, put back, without touching the database. A minor
release changes the database when it starts, and **going back means restoring the backup taken before**: migrations only go forward, and the changelog says which release has
one. A migration that has been released is never edited, and `release.sh` refuses a release in which one was (a journal that only gained entries is not an edit); a fix is a
new migration.

A new or renamed environment variable, port, on-disk path or native dependency updates the `Dockerfile` and `.dockerignore` in the change that makes it, and is a minor
release at least (`AGENTS.md`).

A version that has never been released is `0.0.0`, and its first version's changelog link points at the release page, since there is nothing to compare with. The first
release is `0.1.0`.

Write the notes under `## [Unreleased]` in `CHANGELOG.md` as you go. `prepare` turns them into the version's section, because the release tooling reads that section at the
tagged commit and would publish an empty page without one.

## Release titles

A release is titled `waymark <version>`, for example `waymark 0.1.0`, with no date; the date is in the changelog, where it belongs. A release created from a changelog heading would
be titled `0.1.0 - 2026-11-01`, so the workflow titles it itself and `tag` sets the title again if it is not that; `verify` warns if a title still has the date.

## Dependencies that are newer than the registry's age limit

`pnpm-workspace.yaml` makes pnpm refuse a release younger than a minimum age. The design system, `@sovereignfs/ui`, is ours and is exact-pinned and upgraded on purpose, so a
fresh release of it is added to `minimumReleaseAgeExclude` in the same change as the bump (pnpm writes the entry). An entry is not removed when the release ages: it names one
exact version and does no harm. Anything else that needs one has to be argued in the PR, because the limit is there to stop a freshly published, hijacked package from being
installed.

## What is not proved until it runs

`publish.yml` is checked by `actionlint` and by its structure (the tag trigger, the version check, the notes), but it has not yet run on a real tag, and nothing in it can be
run from a developer's machine. The first `vX.Y.Z` release is its test, and `scripts/release.sh verify` is how to read the result. The same goes for the PR-based flow: `prepare`,
`propose` and the preflights of `tag` are tested against a local origin and a stand-in for `gh`, but the first real `propose` → merge → `tag` is what proves the whole of it.
