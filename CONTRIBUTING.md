# Contributing to Waymark

Thank you for wanting to help. This is everything you need to get a change merged. The agent-facing version of these rules is [`AGENTS.md`](AGENTS.md);
the two are meant to say the same thing.

## Contents

- [Development setup](#development-setup)
- [Branching and commits](#branching-and-commits)
- [Pull requests](#pull-requests)
- [Planning: the design, the roadmap and the epics](#planning-the-design-the-roadmap-and-the-epics)
- [Releases](#releases)
- [Licence of contributions](#licence-of-contributions)

## Development setup

You need Node 24.15 or newer and [pnpm](https://pnpm.io) (the version is `packageManager` in `package.json`). Docker is needed for the full test suite once the database layer exists, which
runs against sqld and PostgreSQL as well as a SQLite file.

```bash
git clone https://github.com/sovereignfs/waymark.git
cd waymark
pnpm install --frozen-lockfile
pnpm format:check && pnpm lint && pnpm typecheck && pnpm test
```

Browser tests need the browsers once (`pnpm exec playwright install chromium webkit`) and a build: `pnpm build && pnpm e2e`, or `pnpm build && pnpm e2e:fast`, which runs them in shards at once on the cores of the machine.

[`AGENTS.md`](AGENTS.md) holds the rules of the app, which are the ones most likely to be broken by accident: read it before changing anything that
reads or writes check-ins or trips, sign-in or the service worker.

## Branching and commits

Branch from an up-to-date `main`, and do not commit to it directly unless you are the owner using the bypass:

```bash
git switch main && git pull
git switch -c feat/your-change
```

| Prefix   | Use for                                         |
| -------- | ----------------------------------------------- |
| `feat/`  | New features or capabilities                    |
| `fix/`   | Bug fixes                                       |
| `docs/`  | Documentation only                              |
| `chore/` | Tooling, scaffolding, dependencies, maintenance |

**Commit messages** explain _why_, not just _what_: `type(scope): summary`, subject under 72 characters, body wrapped at 100, and a `Verified:` line
naming what was run. One logical change per commit.

If an AI assistant helped write the code, say so with a trailer:

```
Co-Authored-By: Claude Code <noreply@anthropic.com>
```

## Pull requests

- **One logical change per PR,** and one task per branch. Open it as a **draft** while it is in progress; mark it _Ready for review_ when it is. CI does
  not run on drafts.
- Before asking for review, make sure `pnpm format:check`, `pnpm lint`, `pnpm typecheck` and `pnpm test` pass, and `pnpm build` for a change that can affect it.
- If you change behaviour, add a line under `## [Unreleased]` in `CHANGELOG.md`. Do **not** bump a version: releases are their own PR.
- A finished task is marked done in `ROADMAP.md` and written up in its epic, in the same PR.
- PRs are merged with **rebase and merge**. No squash, no merge commits, so fix commit messages _before_ the merge, because afterwards they are on `main`.

## Planning: the design, the roadmap and the epics

[`DESIGN.md`](DESIGN.md) says what Waymark does, [`ROADMAP.md`](ROADMAP.md) puts the work in order, and [`docs/epics/`](docs/epics/) holds each task's detail and what
makes it done. A change that the design does not cover changes the design first, in the same PR. An open question with no design gets a research
document in `docs/research/`; a design that needs review before it is built gets an RFC in `docs/rfcs/`.

## Releases

A release is its own pull request, and the merged commit is tagged `vX.Y.Z`. Contributors do not need to do anything for one.

## Licence of contributions

Waymark is licensed under the [AGPL-3.0-or-later](LICENSE), since it bundles `@sovereignfs/ui`. By contributing you agree that your contribution is licensed under
the same terms. There is no CLA.
