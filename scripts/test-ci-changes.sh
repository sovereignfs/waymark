#!/usr/bin/env bash
# Tests for scripts/ci-changes.sh. Fast and dependency-free, so CI runs them.
#
# The cases that matter are the ones where a wrong answer is costly in one direction or the other: a document must not start the build, and
# a file that the build or the tests read must.

set -u

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
PASSED=0
FAILED=0

# expect "name" "code=… scripts=… image=…" path...
expect() {
  local name=$1 want=$2 got
  shift 2
  got=$(printf '%s\n' "$@" | "$HERE/ci-changes.sh" | tr '\n' ' ' | sed 's/ $//')
  if [ "$got" = "$want" ]; then
    PASSED=$((PASSED + 1))
    printf '  pass  %s\n' "$name"
  else
    FAILED=$((FAILED + 1))
    printf '  FAIL  %s\n          wanted: %s\n          got:    %s\n' "$name" "$want" "$got"
  fi
}

NONE="code=false scripts=false image=false"
CODE="code=true scripts=false image=false"
IMAGE="code=true scripts=false image=true"
SCRIPTS="code=false scripts=true image=false"
ALL="code=true scripts=true image=true"
BOTH="code=true scripts=true image=false"

printf '\nchanges that need nothing\n'
expect "no changes at all" "$NONE"
expect "the root documents" "$NONE" CHANGELOG.md CONTRIBUTING.md AGENTS.md CLAUDE.md DESIGN.md ROADMAP.md
expect "the documentation folder" "$NONE" docs/epics/foundation.md docs/README.md docs/rfcs/0001-sharing.md
expect "the licence" "$NONE" LICENSE
expect "the PR template and Dependabot's file" "$NONE" .github/PULL_REQUEST_TEMPLATE.md .github/dependabot.yml
expect "several documents together" "$NONE" ROADMAP.md CHANGELOG.md docs/epics/sync.md

printf '\nchanges that need the app jobs\n'
expect "a page" "$CODE" app/page.tsx
expect "a source file" "$CODE" src/figures/count.ts
expect "a test" "$CODE" src/figures/count.test.ts
expect "a screen" "$CODE" src/screens/CheckinScreen.tsx
expect "a style" "$CODE" src/screens/CheckinScreen.module.css
expect "a browser test" "$CODE" e2e/checkins.spec.ts
expect "the browser tests' config and runner" "$CODE" playwright.config.ts scripts/e2e-shard.mjs
expect "the publish workflow" "$CODE" .github/workflows/publish.yml
expect "a Markdown file that is not one of the documents" "$CODE" src/landing/terms.md
expect "a document in a subfolder of the root that is not under docs" "$CODE" src/landing/README.md
expect "the README, which a test reads" "$CODE" README.md
expect "a document and a source file together" "$CODE" CHANGELOG.md src/today/index.ts
expect "an unknown kind of file" "$CODE" something/new.thing

printf '\nchanges that need only the script checks\n'
expect "a release script" "$SCRIPTS" scripts/release.sh
expect "the release library" "$SCRIPTS" scripts/lib/release.sh
expect "a release file" "$SCRIPTS" scripts/release/waymark.sh
expect "the release tests" "$SCRIPTS" scripts/test-release.sh
expect "other scripts are the app's" "$CODE" scripts/seed-run.mjs

printf '\nchanges that need the image too\n'
expect "the lockfile" "$IMAGE" pnpm-lock.yaml
expect "package.json" "$IMAGE" package.json
expect "a migration" "$IMAGE" migrations/sqlite/0000_init.sql
expect "the manifest an instance reads" "$IMAGE" sovereign.manifest.json
expect "the image" "$IMAGE" Dockerfile .dockerignore
expect "the setups it is brought up in" "$IMAGE" deploy/compose.yaml
expect "a document in them" "$IMAGE" deploy/README.md
expect "the script that brings them up" "$IMAGE" scripts/deploy-check.sh
expect "the database code that runs at start-up" "$IMAGE" src/db/migrate.ts src/config/index.ts
expect "Next's config" "$IMAGE" next.config.ts
expect "the workflow itself" "$IMAGE" .github/workflows/ci.yml
expect "a screen and the Dockerfile together" "$IMAGE" src/screens/Frame.tsx Dockerfile

printf '\nthe classifier itself\n'
expect "changing the classifier runs everything" "$ALL" scripts/ci-changes.sh
expect "changing its tests runs everything" "$ALL" scripts/test-ci-changes.sh

printf '\nboth kinds at once\n'
expect "a source file and a release script" "$BOTH" src/today/index.ts scripts/release.sh
expect "a document and a release script" "$SCRIPTS" ROADMAP.md scripts/release.sh

printf '\n%s passed, %s failed\n' "$PASSED" "$FAILED"
[ "$FAILED" -eq 0 ]
