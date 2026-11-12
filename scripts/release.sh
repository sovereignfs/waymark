#!/usr/bin/env bash
#
# Cut a release of Waymark.
#
#   scripts/release.sh check   X.Y.Z                     read-only preflight
#   scripts/release.sh prepare X.Y.Z [--skip-gates]      branch, bump, plan, gate, commit
#   scripts/release.sh propose X.Y.Z [--dry-run]         push the branch, open a draft PR
#   scripts/release.sh tag     X.Y.Z [--dry-run]         after the PR merges: tag, watch, verify
#   scripts/release.sh verify  X.Y.Z                     check a published release
#
# `main` takes changes only through pull requests, so a release is one too: `prepare`, read what it committed, `propose` (which opens a draft PR and stops), a
# person reviews and merges it, then `tag`. `prepare` never pushes and puts everything back, branch included, if anything fails. `tag` is the step the world can
# see: it waits for CI to be green on the merged commit, and only then creates the tag, which is what fires the release.
#
# Notes for a release come from CHANGELOG.md. Write them under `## [Unreleased]` as you go; `prepare` turns that into the version's section (heading, date and
# compare links), because the release tooling reads the section at the tagged commit and fails *silently* without one.
#
# What is shared lives in scripts/lib/release.sh, and what is particular to Waymark in scripts/release/waymark.sh. Why each check exists is in RELEASING.md.
#
# Needs: git, jq, node and pnpm. `propose`, `tag` and `verify` also need gh (logged in), and `verify` curl. Written for bash 3.2, which is what macOS ships.

set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

# shellcheck source=scripts/lib/release.sh
source "$HERE/lib/release.sh"
# shellcheck source=scripts/release/waymark.sh
source "$HERE/release/waymark.sh"

usage() {
  cat >&2 <<'USAGE'
Usage:
  scripts/release.sh check   X.Y.Z                  read-only preflight
  scripts/release.sh prepare X.Y.Z [--skip-gates]   branch, bump, plan, gate, commit
  scripts/release.sh propose X.Y.Z [--dry-run]      push the branch, open a draft PR
  scripts/release.sh tag     X.Y.Z [--dry-run]      after the PR merges: tag, watch, verify
  scripts/release.sh verify  X.Y.Z                  check a published release

The usual run is prepare, propose, a review and a merge, then tag. The header of this file says what each one does and why.
USAGE
  exit 2
}

main() {
  [ $# -ge 2 ] || usage
  local command=$1 version=$2 dry_run=no skip_gates=no
  shift 2
  while [ $# -gt 0 ]; do
    case $1 in
      --dry-run) dry_run=yes ;;
      --skip-gates) skip_gates=yes ;;
      *) die "unknown option $1" ;;
    esac
    shift
  done

  case $command in
    check) cmd_check "$version" ;;
    prepare) cmd_prepare "$version" "$skip_gates" ;;
    propose) cmd_propose "$version" "$dry_run" ;;
    tag) cmd_tag "$version" "$dry_run" ;;
    publish) cmd_publish "$version" ;;
    verify)
      valid_version "$version" || die "'$version' is not a version of the form X.Y.Z"
      c_verify "$version"
      ;;
    *) usage ;;
  esac
}

# Run only when executed, so the tests can source the library and call single functions without `main` firing.
if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  main "$@"
fi
