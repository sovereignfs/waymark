## What and why

<!-- Describe what changed and why. Focus on the reasoning, not just the mechanics. -->

## Type of change

- [ ] `feat`: new feature or capability
- [ ] `fix`: bug fix
- [ ] `docs`: documentation only
- [ ] `chore`: tooling, scaffolding, dependencies, maintenance

## Design reference

<!-- The DESIGN.md section this implements or changes (e.g. §8.4). Delete if not applicable. -->

## Verification

- [ ] `pnpm format:check`, `pnpm lint`, `pnpm typecheck` and `pnpm test` pass
- [ ] A regression test was seen to fail against the old code (for a `fix`)
- [ ] A data-layer change was tested on sqld, a `file:` database and PostgreSQL
- [ ] A new route is in `src/access/routes.ts`, with a test calling it as the wrong account
- [ ] A new kind of change works offline and is replayed safely
- [ ] `## [Unreleased]` in `CHANGELOG.md` is updated (for a change in behaviour)
- [ ] The task is marked done in `ROADMAP.md` and written up in its epic
- [ ] Relevant docs updated (README, DESIGN, AGENTS)

<!-- Merge with "Rebase and merge" only. Fix commit messages before merging. -->
