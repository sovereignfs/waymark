#!/usr/bin/env bash
#
# Tests for scripts/release.sh and what it sources (scripts/lib/release.sh, scripts/release/waymark.sh).
#
#   scripts/test-release.sh
#
# A release script is the kind of code that breaks silently and is only ever run on the day you can least afford it, so it is tested the way the rest of this
# repository is: against real git repositories, through its failure modes as well as its success.
#
# Each test builds a throwaway repository from this checkout: a bare "origin" and a clone of it, with this working tree laid over it (so what is tested is what is
# on disk, committed or not). Nothing here touches this repository, its remote, or GitHub: `gh` is replaced by a script that answers "logged in" and records what it
# was asked. The gates (install, format, lint, types, tests, build) are replaced, by WAYMARK_RELEASE_GATES, with a command of the test's own.
#
# Needs git, jq and node. Written for bash 3.2.

# The commands handed to check_in are single-quoted on purpose: they are eval'd inside the scratch repository, so $NEXT, $CUR and friends must expand there and
# not here.
# shellcheck disable=SC2016
set -u

ROOT=$(git rev-parse --show-toplevel)
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT

PASSED=0
FAILED=0
TODAY=$(date +%Y-%m-%d)
CL=CHANGELOG.md
# Read by commands that check_in eval's, which shellcheck cannot follow.
# shellcheck disable=SC2034
REPO=https://github.com/sovereignfs/waymark

# The version under test: the one the repository is at, and the ones after it.
CUR=$(jq -r .version "$ROOT/package.json")
NEXT=$(echo "$CUR" | awk -F. '{ print $1 "." $2 "." $3 + 1 }')
MINOR=$(echo "$CUR" | awk -F. '{ print $1 "." $2 + 1 ".0" }')

pass() {
  PASSED=$((PASSED + 1))
  printf '  pass  %s\n' "$1"
}
fail() {
  FAILED=$((FAILED + 1))
  printf '  FAIL  %s\n' "$1"
  shift
  [ $# -eq 0 ] || printf '%s\n' "$@" | sed 's/^/          /'
}

# Run a command inside a scratch repository and record whether it held. The command is eval'd there, so it can use $NEXT, $CUR and $TODAY.
check_in() {
  local dir=$1 name=$2 command=$3
  if (cd "$T/$dir" && eval "$command") >/dev/null 2>&1; then
    pass "$name"
  else
    fail "$name" "command: $command"
  fi
}

# A fresh scratch repository: bare origin, plus a clone with the script.
fresh() {
  local name=$1
  git clone -q --bare "$ROOT" "$T/$name.git"
  git clone -q "$T/$name.git" "$T/$name"
  # The tests release from the version the repository is at, as if nothing had been released, so the real repository's tags are not theirs to meet...
  for tag in $(git -C "$T/$name.git" tag --list 'v*'); do
    git -C "$T/$name.git" tag -d "$tag" >/dev/null
    git -C "$T/$name" tag -d "$tag" >/dev/null 2>&1 || true
  done
  # ...nor the branches of releases that were made, which the real repository may still have.
  for branch in $(git -C "$T/$name.git" for-each-ref --format='%(refname:short)' 'refs/heads/chore/release-*'); do
    git -C "$T/$name.git" branch -D "$branch" >/dev/null
  done
  (
    cd "$T/$name" || exit 1
    git config user.name "Release Test"
    git config user.email "release-test@example.invalid"
    # Always on main, whatever branch this checkout is on: the script under test cuts releases from main.
    git checkout -q -B main
    # The working tree, not HEAD: replace every tracked file with what this checkout has, so the script is tested as it stands.
    git rm -rq --quiet .
    (cd "$ROOT" && git ls-files -co --exclude-standard -z | xargs -0 tar cf -) | tar xf -
    # Whatever notes are waiting under [Unreleased] in the real changelog are not these tests' business: they start from an empty one, and add their own.
    awk '/^## \[Unreleased\]/ { print; print ""; skip = 1; next }
         /^## \[/ { skip = 0 }
         /^\[Unreleased\]: / { skip = 0 }
         !skip { print }' "$CL" >"$CL.new"
    mv "$CL.new" "$CL"
    git add -A
    git commit -q -m "scratch: this working tree under test"
    git push -q -u origin main
  )
}

# The gates a scratch repository runs: nothing, unless a test says so.
GATES=true

# Run the script in a scratch repository, keeping its output and status.
OUT=""
RC=0
rel() {
  local name=$1
  shift
  OUT=$(cd "$T/$name" && WAYMARK_RELEASE_GATES="$GATES" /bin/bash scripts/release.sh "$@" 2>&1)
  RC=$?
}

# Add notes under [Unreleased].
notes() {
  (
    cd "$T/$1" || exit 1
    awk '{ print } /^## \[Unreleased\]/ && !d { print ""; print "### Added"; print ""; print "- A note for the release under test."; d = 1 }' \
      "$CL" >"$CL.new"
    mv "$CL.new" "$CL"
  )
}

# Commit everything in a scratch repository and push it, so that main still matches origin: for setting up states that preflight must tolerate or refuse.
commit_push() {
  (
    cd "$T/$1" || exit 1
    git add -A
    git commit -q -m "$2"
    git push -q origin main
  )
}

# The script must refuse, and say why.
refuses() {
  local test=$1 want=$2
  if [ "$RC" -ne 0 ] && printf '%s' "$OUT" | grep -qF -- "$want"; then
    pass "$test"
  else
    fail "$test" "expected a refusal containing: $want" "exit $RC" "$OUT"
  fi
}

accepts() {
  local test=$1
  if [ "$RC" -eq 0 ]; then
    pass "$test"
  else
    fail "$test" "expected success, got exit $RC" "$OUT"
  fi
}

says() {
  local test=$1 want=$2
  if printf '%s' "$OUT" | grep -qF -- "$want"; then
    pass "$test"
  else
    fail "$test" "expected the output to contain: $want" "$OUT"
  fi
}

# --- Usage ---------------------------------------------------------------------------

printf '\nusage\n'
fresh use
rel use
refuses "no arguments" "Usage:"
rel use frobnicate "$NEXT"
refuses "a command it does not know" "Usage:"
rel use check "$NEXT" --frobnicate
refuses "an option it does not know" "unknown option --frobnicate"
rel use publish "$NEXT"
refuses "publish, which no longer exists" "publish no longer exists"
says "...and says what to do instead" "scripts/release.sh propose $NEXT"

# --- Preflight refusals -----------------------------------------------------------------

printf '\npreflight: what it refuses\n'
fresh pre

rel pre check abc
refuses "a version that is not X.Y.Z" "not a version of the form X.Y.Z"

rel pre check "$CUR"
refuses "the current version again" "is not greater than"

rel pre check "$NEXT"
refuses "no notes anywhere in the changelog" "no notes for $NEXT"

# An empty section heading is not notes.
(cd "$T/pre" && awk -v h="## [$NEXT] - $TODAY" '{ print } /^## \[Unreleased\]/ && !d { print ""; print h; d = 1 }' $CL >c.new && mv c.new $CL)
rel pre check "$NEXT"
refuses "a section heading with nothing under it" "is empty"
(cd "$T/pre" && git checkout -q $CL)

# A section with the wrong date: it would be dated for a different day.
(cd "$T/pre" && awk -v h="## [$NEXT] - 2000-01-01" '{ print } /^## \[Unreleased\]/ && !d { print ""; print h; print ""; print "- notes"; d = 1 }' $CL >c.new && mv c.new $CL)
rel pre check "$NEXT"
refuses "a section dated for another day" "dated 2000-01-01"
(cd "$T/pre" && git checkout -q $CL)

# Dirty tree: something other than the changelog.
notes pre
(cd "$T/pre" && echo "stray" >>README.md)
rel pre check "$NEXT"
refuses "changes other than the changelog" "changes other than $CL"
(cd "$T/pre" && git checkout -q README.md)

# Not on main.
(cd "$T/pre" && git checkout -q -b elsewhere)
rel pre check "$NEXT"
refuses "a branch that is not main" "releases are cut from main"
(cd "$T/pre" && git checkout -q main)

# main ahead of origin: what would be released is not what is on GitHub.
(cd "$T/pre" && git stash -q && echo x >local.txt && git add local.txt && git commit -q -m "local only" && git stash pop -q)
rel pre check "$NEXT"
refuses "main ahead of origin/main" "main is not the same as origin/main"
(cd "$T/pre" && git reset -q --hard origin/main)

# A tag that already exists on origin.
(cd "$T/pre" && git tag "v$NEXT" && git push -q origin "v$NEXT" && git tag -d "v$NEXT" >/dev/null)
notes pre
rel pre check "$NEXT"
refuses "a tag that already exists on origin" "already exists on origin"
(cd "$T/pre" && git push -q --delete origin "v$NEXT")

# The version cannot be read.
fresh blind
(cd "$T/blind" && jq 'del(.version)' package.json >p.new && mv p.new package.json)
commit_push blind "scratch: no version"
notes blind
rel blind check "$NEXT"
refuses "a package.json that does not say its version" "could not read the version"

# --- check: the success path ---------------------------------------------------------------

printf '\ncheck: what it accepts\n'
fresh ok
notes ok
rel ok check "$NEXT"
accepts "notes under [Unreleased]"
says "...and says what [Unreleased] will become" "to become [$NEXT] - $TODAY"
says "...and what to run next" "scripts/release.sh prepare $NEXT"

# --- prepare ------------------------------------------------------------------------------------

printf '\nprepare: what it makes\n'
rel ok prepare "$NEXT"
accepts "prepare, with the gates replaced"
says "...and the gates ran" "the gates the caller named"

# A release is a change like any other: it gets a branch, and main is not touched.
check_in ok "prepare left us on the release branch" \
  '[ "$(git branch --show-current)" = "chore/release-waymark-$NEXT" ]'
check_in ok "main still matches origin/main" \
  '[ "$(git rev-parse main)" = "$(git rev-parse origin/main)" ]'
check_in ok "the release branch is one commit ahead of main" \
  '[ "$(git rev-list --count main..HEAD)" = 1 ]'
check_in ok "one commit, subject 'Release waymark $NEXT'" \
  '[ "$(git log -1 --format=%s)" = "Release waymark $NEXT" ]'
check_in ok "the working tree is clean afterwards" \
  '[ -z "$(git status --porcelain)" ]'
check_in ok "the commit message carries the release notes" \
  'git log -1 --format=%b | grep -qF "A note for the release under test."'
check_in ok "[Unreleased] is left empty above the new section" \
  'awk "/^## \\[Unreleased\\]/{f=1;next} /^## \\[/{exit} f&&NF{bad=1} END{exit bad}" $CL'
check_in ok "the new section is headed '## [$NEXT] - $TODAY'" \
  'grep -qxF "## [$NEXT] - $TODAY" $CL'
check_in ok "the notes moved under the new heading" \
  'awk -v h="## [$NEXT]" '"'"'index($0,h)==1{f=1;next} /^## \[/{f=0} f'"'"' $CL | grep -qF "A note for the release"'
check_in ok "[Unreleased] compares from the new version" \
  'grep -qF "[Unreleased]: $REPO/compare/v$NEXT...HEAD" $CL'
check_in ok "the new version has a link (to the release itself, as nothing was released before)" \
  'grep -qF "[$NEXT]: $REPO/compare/v$CUR...v$NEXT" $CL || grep -qF "[$NEXT]: $REPO/releases/tag/v$NEXT" $CL'
check_in ok "package.json says the new version" \
  '[ "$(jq -r .version package.json)" = "$NEXT" ]'
check_in ok "only the two expected files changed" \
  '[ -z "$(git diff --name-only HEAD~1 | grep -vE "^(CHANGELOG\\.md|package\\.json)$")" ]'
check_in ok "nothing was pushed" \
  '[ "$(git rev-parse HEAD)" != "$(git rev-parse origin/main)" ]'

# Running prepare again must refuse.
rel ok prepare "$NEXT"
refuses "preparing the same version twice" "already prepared"
says "...and says to propose it" "scripts/release.sh propose $NEXT"

# --- prepare, when it fails: nothing is left behind ---------------------------------------------------

printf '\nprepare: when a gate fails\n'
fresh roll
notes roll
BEFORE_HEAD=$(cd "$T/roll" && git rev-parse HEAD)
GATES=false rel roll prepare "$NEXT"
refuses "a failing gate fails the run" "the gates the caller named gate failed"
check_in roll "no commit was made" '[ "$(git rev-parse HEAD)" = "'"$BEFORE_HEAD"'" ]'
check_in roll "we are back on main" '[ "$(git branch --show-current)" = main ]'
check_in roll "the release branch is gone" \
  '! git rev-parse -q --verify "refs/heads/chore/release-waymark-$NEXT"'
check_in roll "package.json is back at $CUR" '[ "$(jq -r .version package.json)" = "$CUR" ]'
check_in roll "the uncommitted notes survived the rollback" \
  'grep -qF "A note for the release under test." $CL'
check_in roll "...and are still under [Unreleased], not promoted" \
  '! grep -q "^## \\[$NEXT\\]" $CL'
check_in roll "the only modified file is the changelog" \
  '[ "$(git status --porcelain | awk "{print \$2}")" = "$CL" ]'

# A release the tag could not start is refused before anything is committed: the workflow must trigger on version tags.
fresh noflow
(cd "$T/noflow" && sed -i.bak "s/'v\[0-9\]+\.\[0-9\]+\.\[0-9\]+'/'nothing'/" .github/workflows/publish.yml && rm .github/workflows/publish.yml.bak)
commit_push noflow "scratch: a workflow that no tag starts"
notes noflow
rel noflow prepare "$NEXT"
refuses "a release workflow that does not trigger on v tags" "does not trigger on v tags"
check_in noflow "...and the repository was put back" '[ "$(git branch --show-current)" = main ] && [ "$(jq -r .version package.json)" = "$CUR" ]'

# --- Migrations and patch releases ---------------------------------------------------------------------------

printf '\nmigrations: what a release may carry\n'
# The previous release is a tag on the base commit.
fresh mig
(cd "$T/mig" && git tag "v$CUR" && git push -q origin "v$CUR")
notes mig
# A patch release with a new migration.
(cd "$T/mig" && echo "SELECT 1;" >migrations/sqlite/0099_added.sql)
commit_push mig "scratch: a new migration"
rel mig prepare "$NEXT"
refuses "a patch release that carries a migration" "is a patch release, and the migrations changed"
# The same change as a minor release is what a minor release is for.
rel mig prepare "$MINOR"
accepts "...and the same change as a minor release"
(cd "$T/mig" && git switch -q main && git branch -D "chore/release-waymark-$MINOR" >/dev/null)

# A released migration, edited.
fresh edit
(cd "$T/edit" && git tag "v$CUR" && git push -q origin "v$CUR")
(cd "$T/edit" && for first in migrations/sqlite/*.sql; do echo "-- edited after release" >>"$first" && break; done)
commit_push edit "scratch: a released migration edited"
notes edit
rel edit prepare "$MINOR"
refuses "a released migration that was edited" "were edited or removed"
check_in edit "...and the repository was put back" '[ "$(git branch --show-current)" = main ]'

# A journal that only gained an entry is not an edit.
fresh journal
(cd "$T/journal" && git tag "v$CUR" && git push -q origin "v$CUR")
(
  cd "$T/journal" || exit 1
  echo "SELECT 1;" >migrations/sqlite/0099_added.sql
  jq '.entries += [{"idx": 99, "version": "6", "when": 1, "tag": "0099_added", "breakpoints": true}]' migrations/sqlite/meta/_journal.json >j.new
  mv j.new migrations/sqlite/meta/_journal.json
)
commit_push journal "scratch: a migration added, with its journal entry"
notes journal
rel journal prepare "$MINOR"
accepts "a migration added with its journal entry, in a minor release"
check_in journal "...and the check said the released ones were kept" 'true'

# --- propose and tag, against a stand-in for gh -------------------------------------------------------------
#
# Opening a pull request and tagging a release are the two steps the world can see. Their preflights are tested here, and propose is run for real against a local
# bare origin; only gh is replaced, by a script that answers "logged in" and records what it was asked to do.

printf '\npropose and tag: the preflights, and propose itself\n'
mkdir -p "$T/bin"
cat >"$T/bin/gh" <<'SHIM'
#!/bin/sh
echo "$*" >>"$GH_RECORD"
case "$1 $2" in
  "auth status") exit 0 ;;
  "pr list") exit 0 ;;
  "pr create") echo "https://github.com/example/example/pull/1" ;;
esac
SHIM
chmod +x "$T/bin/gh"
GH_RECORD="$T/gh-record"
: >"$GH_RECORD"

# Like rel, with the stand-in first on PATH.
relg() {
  local name=$1
  shift
  OUT=$(cd "$T/$name" && PATH="$T/bin:$PATH" GH_RECORD="$GH_RECORD" WAYMARK_RELEASE_GATES="$GATES" /bin/bash scripts/release.sh "$@" 2>&1)
  RC=$?
}

relg ok propose "$NEXT" --dry-run
accepts "a dry run of propose on a prepared release"
says "...and says it changed nothing" "Dry run, so nothing was changed"
check_in ok "...and really did not push the branch" \
  '! git ls-remote --exit-code --heads origin "chore/release-waymark-$NEXT"'

# Not prepared: we are on main, not on a release branch.
fresh unprep
relg unprep propose "$NEXT" --dry-run
refuses "proposing something that was never prepared" "Run 'prepare $NEXT' first"

# Prepared, then something else committed on top of the release commit.
(cd "$T/ok" && echo y >extra.txt && git add extra.txt && git commit -q -m "something else")
relg ok propose "$NEXT" --dry-run
refuses "a commit on top of the release commit" "HEAD is 'something else'"
(cd "$T/ok" && git reset -q --hard HEAD~1)

# Proposing for real: the branch is pushed, a DRAFT PR into main is opened, and main is not touched.
relg ok propose "$NEXT"
accepts "propose, with gh stood in for"
check_in ok "the release branch is on origin" \
  'git ls-remote --exit-code --heads origin "chore/release-waymark-$NEXT"'
check_in ok "main on origin did not move" \
  '[ "$(git ls-remote origin refs/heads/main | cut -f1)" = "$(git rev-parse main)" ]'
if grep -qF "pr create --draft --base main --head chore/release-waymark-$NEXT --title Release waymark $NEXT" "$GH_RECORD"; then
  pass "the pull request is a draft into main, titled for the release"
else
  fail "the pull request is a draft into main, titled for the release" "$(cat "$GH_RECORD")"
fi
says "...and it says to run tag after the merge" "scripts/release.sh tag $NEXT"

# tag, before the PR is merged: we are on the release branch, then on a main that does not have the release commit.
relg ok tag "$NEXT" --dry-run
refuses "tagging from the release branch" "releases are cut from main"
relg unprep tag "$NEXT" --dry-run
refuses "tagging before the release commit is on main" "not 'Release waymark $NEXT'"

# Simulate the merge, which is a fast-forward of main to the release commit.
(cd "$T/ok" && git switch -q main && git merge -q --ff-only "chore/release-waymark-$NEXT" && git push -q origin main)
relg ok tag "$NEXT" --dry-run
accepts "a dry run of tag once the release commit is on main"
says "...and says it changed nothing" "Dry run, so nothing was changed"
says "...and what it would wait for" "ci.yml"
says "...and what it would push" "create and push the tag v$NEXT"
check_in ok "...and really did not tag" '! git rev-parse -q --verify "refs/tags/v$NEXT"'

# The release is already tagged.
(cd "$T/ok" && git tag "v$NEXT" && git push -q origin "v$NEXT")
relg ok tag "$NEXT" --dry-run
refuses "tagging a release that is already tagged" "already exists on origin"

# --- The changelog, read ----------------------------------------------------------------------------------------------

printf '\nthe changelog: reading it\n'
# A section with a lot in it: reading it must not be cut short (a writer that dies of SIGPIPE under pipefail was once a refusal of a release with many notes).
fresh big
(
  cd "$T/big" || exit 1
  {
    echo "- A first note."
    i=0
    while [ $i -lt 3000 ]; do
      echo "- A note, number $i, which is long enough to fill a pipe's buffer several times over if there are enough of them."
      i=$((i + 1))
    done
  } >notes.txt
  awk '{ print } /^## \[Unreleased\]/ && !d { print ""; print "### Added"; print ""; system("cat notes.txt"); d = 1 }' $CL >c.new
  mv c.new $CL
  rm notes.txt
)
rel big check "$NEXT"
accepts "a changelog section of thousands of lines"

# --- The summary ------------------------------------------------------------------------------------------------------------

printf '\n%d passed, %d failed\n' "$PASSED" "$FAILED"
[ "$FAILED" -eq 0 ]
