#!/usr/bin/env bash
# Decide which CI jobs a change needs.
#
#   git diff --name-only BASE HEAD | scripts/ci-changes.sh
#
# Reads changed paths on stdin and prints `name=true|false` lines, ready to be appended to $GITHUB_OUTPUT:
#
#   code     the app can be affected: format, lint, type-check, build and test
#   scripts  the shell scripts can be affected (shellcheck, and the classifier's own tests)
#   image    the Docker image, or how it is brought up, can be affected: it is built and started in each documented setup, on both architectures (the slowest
#            check there is, and the one an ordinary change to a page cannot break)
#
# A change to documentation alone sets neither, so the jobs do not run for it. The rules err towards running: anything that is not named as a
# document below counts as code, so a new kind of file that the build or a test reads is covered without being added here.
#
# Not here on purpose: the publish workflow only runs on a tag.
#
# Written for bash 3.2.

set -euo pipefail

code=false
scripts=false
image=false

# Documents nothing builds or tests from. A regex and not a glob, because in a `case` pattern `*` matches `/`. The README is not one: a test reads it (task 16.3 checks that every setting is in it).
document='^(CHANGELOG|CONTRIBUTING|AGENTS|CLAUDE|DESIGN|ROADMAP|SECURITY|RELEASING)\.md$|^LICENSE$|^docs/|^\.github/(PULL_REQUEST_TEMPLATE\.md|dependabot\.yml)$'

# What goes into the image or decides how it starts: the Dockerfile and what it copies, the dependencies and Next's config, the migrations and the database and settings
# code that runs at start-up (and the one file Next compiles for it), the manifest an instance reads, the public files, the setups it is brought up in and the script that
# brings them up, and the workflow that runs it. The weekly schedule, and a run with nothing to compare, run it whatever changed (`.github/workflows/ci.yml`).
image_paths='^(Dockerfile|\.dockerignore|\.node-version|package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|next\.config\.ts|sovereign\.manifest\.json|instrumentation(-node)?\.ts|proxy\.ts)$|^(deploy|migrations|public|src/db|src/config|src/jobs)/|^scripts/(deploy-check\.sh|serve-standalone\.mjs|boot-check\.mjs|lib/standalone\.mjs)$|^\.github/workflows/ci\.yml$'

while IFS= read -r path; do
  [ -n "$path" ] || continue
  if [[ $path =~ $document ]]; then
    continue
  fi
  if [[ $path =~ $image_paths ]]; then
    image=true
  fi
  case "$path" in
    # Changing the classifier changes what runs, so run everything.
    scripts/ci-changes.sh | scripts/test-ci-changes.sh)
      code=true
      scripts=true
      image=true
      ;;
    # The release scripts have their own checks, and nothing in the app reads them.
    scripts/release.sh | scripts/lib/* | scripts/release/* | scripts/test-release.sh) scripts=true ;;
    *) code=true ;;
  esac
done

printf 'code=%s\n' "$code"
printf 'scripts=%s\n' "$scripts"
printf 'image=%s\n' "$image"
