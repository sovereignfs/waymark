# shellcheck shell=bash
# What a release of Waymark is made of. Sourced by scripts/release.sh (and by its tests); not run directly. It is the model Fjord's is (sovereignfs/fjord,
# scripts/lib/release.sh), for one thing released and not several.
#
# What is released is described by scripts/release/waymark.sh, which sets the C_* variables and defines the c_* functions below. This library does the parts that
# do not depend on what is being released: the output, the rollback, the changelog, the preflight, the waiting on GitHub. Why each check exists is in
# RELEASING.md; every one of them is there because a release went wrong without it.
#
# How a release goes
# ------------------
# `main` takes changes only through a pull request (AGENTS.md § Working
# conventions), and a release is a change like any other:
#
#   prepare  on a branch cut from main, bump, gate, and make one commit
#   propose  push that branch and open a draft pull request, then stop
#   ...      a person reviews the PR and merges it with "rebase and merge"
#   tag      on main, once merged: wait for CI on that exact commit, tag it,
#            watch the release workflow, retitle the release, verify it
#
# `tag` is separate from the merge because the merge rewrites the commit's
# SHA, and it is the merged commit that CI has to vouch for and that gets tagged.
#
# What a component provides
# -------------------------
#   C_PACKAGE            what the release is called in commit and tag messages
#   C_TAG_PREFIX         a release of version X is tagged "${C_TAG_PREFIX}X"
#   C_LEGACY_TAG_PREFIX  the prefix older releases were tagged with, if any;
#                        only used to find the previous release's tag
#   C_CHANGELOG          path of the component's CHANGELOG.md
#   C_TOUCHED            the files `prepare` edits (the changelog is one)
#   C_RELEASE_WORKFLOW   the workflow file that the tag starts
#   C_NEEDS              the tools its commands run, beyond git, jq and gh
#                        (Waymark: "node pnpm")
#   C_LATEST             "yes" if its releases are marked Latest on GitHub,
#                        "no" if they must never be
#   C_REQUIRED_WORKFLOWS workflows that must be green on the release commit
#   C_OPTIONAL_WORKFLOWS ...and ones that are only waited for if they ran
#
#   c_current_version    print the component's current version
#   c_check_versions     die unless every place a version is written agrees
#   c_bump FROM TO       write the new version everywhere, and refresh locks
#   c_check_plan V       die unless the release machinery accepts this tag
#   c_gates              run the checks that must pass before committing
#   c_verify V           check the published release
#   c_check_publish      (optional) die unless what publishing needs is in place;
#                        run before a pull request is proposed or a tag is pushed

# Always the repository root, whatever the caller's directory.
cd "$(git rev-parse --show-toplevel)" || exit 1

# The address of the repository, for the changelog's compare links: package.json says it, or the remote does.
REPO_URL=$(jq -r '(.repository.url // .repository // empty)' package.json 2>/dev/null | sed -E 's#^git\+##; s#\.git$##; s#^git@github\.com:#https://github.com/#')
if [ -z "$REPO_URL" ]; then
  REPO_URL=$(git remote get-url origin 2>/dev/null | sed -E 's#\.git$##; s#^git@[^:]*:#https://github.com/#')
fi
# `gh` cannot work out the repository from an SSH host alias, so say it.
GH_REPO=${REPO_URL#https://github.com/}
export GH_REPO

WORK=""
PREPARING=""
# The branch `prepare` created, so that a failure can put things back.
PREPARE_BRANCH=""

# How long to wait for a workflow run to *appear* for a commit. Runs start
# within seconds, so two minutes means something is wrong; it is a variable so
# the tests can exercise that path without waiting two minutes.
RUN_START_TIMEOUT=${RELEASE_RUN_START_TIMEOUT:-120}

# --- Output -------------------------------------------------------------------

die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}
warn() { printf 'warning: %s\n' "$*" >&2; }
step() { printf '\n==> %s\n' "$*"; }
ok() { printf '  ok  %s\n' "$*"; }
say() { printf '      %s\n' "$*"; }

# --- Cleanup and rollback -------------------------------------------------------

# The files `prepare` edits are backed up before the first edit, so that a
# failure puts back exactly what was there — including a changelog with
# uncommitted notes in it, which a `git checkout` would destroy.
backup_files() {
  local f
  for f in $C_TOUCHED; do
    mkdir -p "$WORK/backup/$(dirname "$f")"
    cp -p "$f" "$WORK/backup/$f"
  done
}

restore_files() {
  local f
  for f in $C_TOUCHED; do
    cp -p "$WORK/backup/$f" "$f"
  done
}

cleanup() {
  local status=$?
  if [ -n "$PREPARING" ] && [ "$status" -ne 0 ] && [ -d "$WORK/backup" ]; then
    printf '\nprepare failed; putting back the files it edited.\n' >&2
    restore_files
    # Back to main, and the branch it made removed: a failed prepare leaves
    # the repository as it found it, branches included.
    if [ -n "$PREPARE_BRANCH" ]; then
      git switch -q main 2>/dev/null || true
      git branch -D "$PREPARE_BRANCH" >/dev/null 2>&1 || true
    fi
  fi
  if [ -n "$WORK" ]; then
    rm -rf "$WORK"
  fi
  exit "$status"
}
trap cleanup EXIT

# --- Small helpers ----------------------------------------------------------------

need() {
  command -v "$1" >/dev/null 2>&1 || die "$1 is required and was not found"
}

# The tools this component's own commands run (C_NEEDS), so that releasing a
# component that is not Rust does not demand a Rust toolchain, and the reverse.
need_component_tools() {
  local tool
  for tool in ${C_NEEDS:-}; do
    need "$tool"
  done
}

valid_version() {
  [[ $1 =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]
}

# Whether $1 is a strictly greater version than $2.
version_gt() {
  local a1 a2 a3 b1 b2 b3
  IFS=. read -r a1 a2 a3 <<<"$1"
  IFS=. read -r b1 b2 b3 <<<"$2"
  if [ "$a1" -ne "$b1" ]; then
    [ "$a1" -gt "$b1" ]
    return
  fi
  if [ "$a2" -ne "$b2" ]; then
    [ "$a2" -gt "$b2" ]
    return
  fi
  [ "$a3" -gt "$b3" ]
}

# The tag a release of $1 gets.
tag_of() {
  echo "${C_TAG_PREFIX}$1"
}

# The tag the previous release of this component carries. Earlier releases
# were tagged before there was more than one component, so fall back to the
# old prefix; and if neither exists, the new scheme's name, which at least
# says what it should have been.
previous_tag() {
  local prev=$1
  if git rev-parse -q --verify "refs/tags/${C_TAG_PREFIX}$prev" >/dev/null; then
    echo "${C_TAG_PREFIX}$prev"
  elif [ -n "${C_LEGACY_TAG_PREFIX:-}" ] &&
    git rev-parse -q --verify "refs/tags/${C_LEGACY_TAG_PREFIX}$prev" >/dev/null; then
    echo "${C_LEGACY_TAG_PREFIX}$prev"
  else
    echo "${C_TAG_PREFIX}$prev"
  fi
}

# Files git reports as changed that should not have been. With an argument,
# that one file is the only change allowed (before `prepare` edits anything,
# only the changelog may carry the release's notes); without, any of
# $C_TOUCHED is (after `prepare` has bumped the version).
unexpected_changes() {
  local only=${1:-} f
  git status --porcelain | awk '{ print $2 }' | while IFS= read -r f; do
    if [ -n "$only" ]; then
      [ "$f" = "$only" ] || echo "$f"
    else
      case " $C_TOUCHED " in
        *" $f "*) ;;
        *) echo "$f" ;;
      esac
    fi
  done
}

# --- The changelog ------------------------------------------------------------------

# The body of one section: from its heading to the next heading or to the
# link references at the foot of the file.
section_body() {
  awk -v h="## [$1]" '
    index($0, h) == 1 { f = 1; next }
    /^## \[/ { f = 0 }
    /^\[[^]]+\]: / { f = 0 }
    f' "$C_CHANGELOG"
}

# Reads all of its input. `grep -q` would stop at the first line with content, and a writer
# still sending (a long changelog section) would then die of SIGPIPE, which `pipefail` turns
# into "no notes": the release of a changelog with a lot in it was refused for that.
has_content() {
  grep '[^[:space:]]' >/dev/null
}

# What the changelog holds for $1: `section` (a filled-in section), `empty`
# (a heading with nothing under it), `unreleased` (notes waiting to be
# released) or `missing`.
changelog_state() {
  local vre=${1//./\\.}
  if grep -q "^## \[$vre\]" "$C_CHANGELOG"; then
    if section_body "$1" | has_content; then
      echo section
    else
      echo empty
    fi
  elif section_body Unreleased | has_content; then
    echo unreleased
  else
    echo missing
  fi
}

# Turn `## [Unreleased]` notes into `## [$1] - <today>`, leaving Unreleased
# empty above it. This is the standard Keep a Changelog step, done here
# because a hand-typed heading or compare link is exactly the sort of thing
# that goes subtly wrong.
promote_unreleased() {
  local heading="## [$1] - $2"
  awk -v h="$heading" '
    !done && index($0, "## [Unreleased]") == 1 { print; print ""; print h; done = 1; next }
    { print }' "$C_CHANGELOG" >"$WORK/changelog.new"
  cat "$WORK/changelog.new" >"$C_CHANGELOG"
}

# Point [Unreleased] at the new version, and add the new version's compare
# link, from the previous release's tag to this one's. Skipped, with a
# warning, if the file has no [Unreleased] link.
update_footer_links() {
  local version=$1 previous=$2 vre=${1//./\\.} has_link=no first new_tag prev_tag
  new_tag=$(tag_of "$version")
  prev_tag=$(previous_tag "$previous")
  if grep -q '^\[Unreleased\]: ' "$C_CHANGELOG"; then
    if grep -q "^\[$vre\]: " "$C_CHANGELOG"; then
      has_link=yes
    fi
    # A component at 0.0.0 has never been released, so there is nothing to compare
    # with: its first version links to the release itself, as a changelog does.
    first=no
    [ "$previous" != 0.0.0 ] || first=yes
    awk -v url="$REPO_URL" -v v="$version" -v new="$new_tag" -v prev="$prev_tag" -v has="$has_link" -v first="$first" '
      index($0, "[Unreleased]: ") == 1 {
        print "[Unreleased]: " url "/compare/" new "...HEAD"
        if (has == "no" && first == "yes") print "[" v "]: " url "/releases/tag/" new
        else if (has == "no") print "[" v "]: " url "/compare/" prev "..." new
        next
      }
      { print }' "$C_CHANGELOG" >"$WORK/changelog.new"
    cat "$WORK/changelog.new" >"$C_CHANGELOG"
  else
    warn "$C_CHANGELOG has no [Unreleased] link at the foot; compare links not updated"
  fi
}

# --- Preflight ------------------------------------------------------------------------

require_main_in_sync() {
  local branch
  branch=$(git rev-parse --abbrev-ref HEAD)
  [ "$branch" = main ] || die "releases are cut from main, and this is $branch"
  git fetch origin --tags --quiet || die "could not fetch from origin"
}

require_tag_free() {
  local tag
  tag=$(tag_of "$1")
  # Origin first. The preflight has just fetched tags, so a tag that exists on
  # origin is also local by now, and saying "locally" would name the effect
  # and not the cause.
  if [ -n "$(git ls-remote --tags origin "refs/tags/$tag")" ]; then
    die "tag $tag already exists on origin"
  fi
  if git rev-parse -q --verify "refs/tags/$tag" >/dev/null; then
    die "tag $tag already exists locally (not on origin)"
  fi
  ok "tag $tag is free"
}

# What a published release is called on GitHub: the name and the version, with
# no date. The title would otherwise come from the changelog heading, which is
# "0.3.0 - 2026-10-21" because that is how a changelog is written; so `tag` sets
# the title once the release exists.
release_title() {
  echo "$C_PACKAGE $1"
}

# The branch a release is prepared on, and proposed from.
release_branch() {
  echo "chore/release-$C_NAME-$1"
}

# The subject of the commit `prepare` makes, and `propose` and `tag` insist on.
release_subject() {
  echo "Release $C_PACKAGE $1"
}

# Everything `prepare` needs to be true, without changing anything.
preflight_prepare() {
  local v=$1 cur unexpected state today heading_date
  step "Preflight for $C_PACKAGE $v"

  valid_version "$v" || die "'$v' is not a version of the form X.Y.Z"
  need git
  need jq
  need_component_tools

  # Said before the checks that follow, which would otherwise tell someone who
  # has already prepared to "switch to main": the wrong advice.
  if [ "$(git rev-parse --abbrev-ref HEAD)" = "$(release_branch "$v")" ]; then
    die "already prepared: you are on $(release_branch "$v"). Next: scripts/release.sh propose $v. To start over: git switch main && git branch -D $(release_branch "$v")"
  fi

  require_main_in_sync
  ok "on main, fetched origin"

  if [ "$(git log -1 --format=%s)" = "$(release_subject "$v")" ]; then
    die "main already has the '$(release_subject "$v")' commit: it has been merged. Next: scripts/release.sh tag $v"
  fi

  [ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] ||
    die "main is not the same as origin/main; push or pull first, so that what is released is what is on GitHub"
  ok "main matches origin/main"

  # The changelog may carry the release's notes, uncommitted. Nothing else.
  unexpected=$(unexpected_changes "$C_CHANGELOG")
  [ -z "$unexpected" ] ||
    die "the working tree has changes other than $C_CHANGELOG: $(echo "$unexpected" | tr '\n' ' ')"
  ok "working tree clean (apart from $C_CHANGELOG)"

  c_check_versions
  cur=$(c_current_version)
  version_gt "$v" "$cur" || die "$v is not greater than the current version $cur"
  ok "$v is greater than $cur"

  require_tag_free "$v"

  state=$(changelog_state "$v")
  today=$(date +%Y-%m-%d)
  case "$state" in
    section)
      heading_date=$(sed -nE "s/^## \[${v//./\\.}\] - ([0-9]{4}-[0-9]{2}-[0-9]{2}).*/\1/p" "$C_CHANGELOG" | head -1)
      [ -n "$heading_date" ] ||
        die "the [$v] heading in $C_CHANGELOG has no date; write it as '## [$v] - $today'"
      [ "$heading_date" = "$today" ] ||
        die "the [$v] heading is dated $heading_date but today is $today; correct it"
      ok "$C_CHANGELOG has a [$v] section dated today"
      ;;
    unreleased)
      ok "$C_CHANGELOG has notes under [Unreleased], to become [$v] - $today"
      ;;
    empty)
      die "the [$v] section of $C_CHANGELOG is empty"
      ;;
    *)
      die "$C_CHANGELOG has no notes for $v. Write them under '## [Unreleased]'; the release would ship with generic notes without them"
      ;;
  esac
}

# Run one gate. A bare `set -e` exit would show the tool's own output and
# nothing saying which gate it was, which is no help at the end of a long run.
gate() {
  local name=$1
  shift
  if "$@"; then
    ok "$name"
  else
    die "the $name gate failed (its output is above); nothing was committed"
  fi
}

# --- Commands ---------------------------------------------------------------------------

cmd_check() {
  preflight_prepare "$1"
  printf '\nready: scripts/release.sh prepare %s will do the rest.\n' "$1"
}

cmd_prepare() {
  local v=$1 skip_gates=$2 cur today state f body
  preflight_prepare "$v"

  cur=$(c_current_version)
  today=$(date +%Y-%m-%d)
  WORK=$(mktemp -d)
  backup_files
  PREPARING=yes

  # The release is a change like any other, so it gets a branch and later a
  # pull request. Uncommitted notes in the changelog come with the switch.
  step "Branch"
  git switch -q -c "$(release_branch "$v")"
  PREPARE_BRANCH=$(release_branch "$v")
  ok "on $(release_branch "$v"), cut from main"

  step "Notes"
  state=$(changelog_state "$v")
  if [ "$state" = unreleased ]; then
    promote_unreleased "$v" "$today"
    ok "promoted [Unreleased] to [$v] - $today"
  fi
  update_footer_links "$v" "$cur"
  ok "compare links updated"

  step "Bump $cur -> $v"
  c_bump "$cur" "$v"

  # Nothing may have changed except the files this command is for.
  f=$(unexpected_changes)
  [ -z "$f" ] || die "unexpected changes after the bump: $(echo "$f" | tr '\n' ' ')"
  ok "only the expected files changed"

  step "Release machinery"
  c_check_plan "$v"

  if [ "$skip_gates" = yes ]; then
    warn "gates skipped: CI will still run them, but only after the push"
  else
    step "Gates"
    c_gates
  fi

  step "Commit"
  body=$(section_body "$v" | sed '/./,$!d')
  printf '%s\n\n%s\n' "$(release_subject "$v")" "$body" >"$WORK/message"
  # shellcheck disable=SC2086  # the file list is deliberately word-split
  git add $C_TOUCHED
  git commit -q -F "$WORK/message"
  PREPARING=""
  PREPARE_BRANCH=""
  ok "committed $(git rev-parse --short HEAD): $(release_subject "$v")"

  printf '\nPrepared on %s, and nothing has been pushed. Read what it made:\n\n' "$(release_branch "$v")"
  printf '    git show --stat HEAD\n\n'
  printf 'then open the pull request:\n\n'
  printf '    scripts/release.sh propose %s\n' "$v"
}

wait_for_workflow() {
  local workflow=$1 sha=$2 required=$3 id="" waited=0 conclusion
  while [ -z "$id" ]; do
    # Ask for the commit itself rather than the latest runs on main: CI runs on
    # every push, so a fixed window would eventually scroll past an old commit.
    id=$(gh run list --workflow "$workflow" --branch main --commit "$sha" --limit 20 \
      --json databaseId,headSha \
      --jq ".[] | select(.headSha == \"$sha\") | .databaseId" | head -1 || true)
    if [ -z "$id" ]; then
      if [ "$waited" -ge "$RUN_START_TIMEOUT" ]; then
        if [ "$required" = yes ]; then
          die "no $workflow run appeared for ${sha:0:7} after ${RUN_START_TIMEOUT}s"
        fi
        warn "no $workflow run for ${sha:0:7}; its path filters may have skipped it. Continuing"
        return 0
      fi
      sleep 5
      waited=$((waited + 5))
    fi
  done
  say "$workflow run $id"
  gh run watch "$id" --exit-status --interval 15 >/dev/null 2>&1 || true
  conclusion=$(gh run view "$id" --json conclusion --jq .conclusion)
  [ "$conclusion" = success ] ||
    die "$workflow finished as '$conclusion' on ${sha:0:7}, so the tag was not created. See: gh run view $id --log-failed"
  ok "$workflow is green on ${sha:0:7}"
}

# Wait for the run that a pushed tag starts. $1 is the tag, $2 the workflow.
# A tag-triggered run records the tag as its branch.
wait_for_release_run() {
  local tag=$1 workflow=$2 id="" waited=0 conclusion
  while [ -z "$id" ]; do
    id=$(gh run list --workflow "$workflow" --limit 10 --json databaseId,headBranch \
      --jq ".[] | select(.headBranch == \"$tag\") | .databaseId" | head -1 || true)
    if [ -z "$id" ]; then
      [ "$waited" -lt 90 ] || die "the $workflow workflow did not start for $tag"
      sleep 5
      waited=$((waited + 5))
    fi
  done
  say "$workflow run $id"
  gh run watch "$id" --exit-status --interval 20 >/dev/null 2>&1 || true
  conclusion=$(gh run view "$id" --json conclusion --jq .conclusion)
  if [ "$conclusion" != success ]; then
    printf '\nThe release run finished as %s. Nothing may have been published; check with:\n' "$conclusion" >&2
    printf '    gh run view %s --log-failed\n    gh release list\n' "$id" >&2
    printf 'The tag %s is on origin. If nothing was published, fix the cause, then move it:\n' "$tag" >&2
    printf '    git push --delete origin %s && git tag -f %s <fixed-commit> && git push origin %s\n' "$tag" "$tag" "$tag" >&2
    exit 1
  fi
  ok "the $workflow workflow succeeded"
}

retitle_release() {
  local tag=$1 v=$2 title
  title=$(release_title "$v")
  gh release edit "$tag" --title "$title" >/dev/null ||
    die "could not set the title of $tag to '$title'. Set it yourself: gh release edit $tag --title '$title'"
  ok "titled the release '$title'"
}

# What every published release must be, whatever it contains: visible to
# `releases/latest` if it is meant to be, and invisible to it if not.
verify_release_page() {
  local tag=$1 v=${2:-} is_latest title
  need gh
  need jq
  [ -n "$WORK" ] || WORK=$(mktemp -d)

  gh release view "$tag" --json name,isDraft,isPrerelease,body,assets >"$WORK/release.json" ||
    die "there is no release $tag"
  jq -e '.isDraft == false and .isPrerelease == false' "$WORK/release.json" >/dev/null ||
    die "$tag is a draft or a prerelease, which 'releases/latest' skips"
  ok "published, not a draft or prerelease"

  # A warning, not a failure: a release made before titles were set has the
  # date in it, and that is cosmetic and fixed with one command.
  if [ -n "$v" ]; then
    title=$(jq -r .name "$WORK/release.json")
    if [ "$title" = "$(release_title "$v")" ]; then
      ok "titled '$title'"
    else
      warn "$tag is titled '$title', not '$(release_title "$v")'. Fix it: gh release edit $tag --title '$(release_title "$v")'"
    fi
  fi

  is_latest=$(gh release list --json tagName,isLatest --jq ".[] | select(.tagName == \"$tag\") | .isLatest")
  if [ "$C_LATEST" = yes ]; then
    if [ "$is_latest" = true ]; then
      ok "marked Latest"
    else
      warn "$tag is not marked Latest; fine for an older version, wrong for the newest"
    fi
  else
    [ "$is_latest" != true ] ||
      die "$tag is marked Latest, but $C_PACKAGE releases must not be. Fix it: gh release edit $tag --latest=false"
    ok "not marked Latest, as it must not be"
  fi
}

# The tools and the login the steps that talk to GitHub need.
need_github() {
  need git
  need jq
  need_component_tools
  need gh
  gh auth status >/dev/null 2>&1 || die "gh is not logged in"
}

# Push the release branch and open a draft pull request for it. Stops there:
# review and merge are a person's.
cmd_propose() {
  local v=$1 dry_run=$2 cur subject branch current url
  branch=$(release_branch "$v")
  step "Preflight for proposing $C_PACKAGE $v"
  valid_version "$v" || die "'$v' is not a version of the form X.Y.Z"
  need_github
  git fetch origin --tags --quiet || die "could not fetch from origin"
  if declare -F c_check_publish >/dev/null; then c_check_publish; fi

  current=$(git rev-parse --abbrev-ref HEAD)
  [ "$current" = "$branch" ] ||
    die "you are on $current, not $branch. Run 'prepare $v' first, from main"
  ok "on $branch"

  cur=$(c_current_version)
  [ "$cur" = "$v" ] ||
    die "the $C_PACKAGE version is $cur, not $v; run 'prepare $v' first"
  c_check_versions
  subject=$(git log -1 --format=%s)
  [ "$subject" = "$(release_subject "$v")" ] ||
    die "HEAD is '$subject', not '$(release_subject "$v")'. The release branch is for the release commit alone"
  ok "HEAD is the $(release_subject "$v") commit"
  [ -z "$(git status --porcelain)" ] || die "the working tree is not clean"
  ok "working tree clean"
  require_tag_free "$v"
  git merge-base --is-ancestor origin/main HEAD ||
    die "origin/main has commits that $branch does not. Rebase onto it ('git rebase origin/main'), re-run the gates, and propose again"
  ok "$branch is up to date with origin/main"
  c_check_plan "$v"

  if [ "$dry_run" = yes ]; then
    printf '\nDry run, so nothing was changed. It would now:\n\n'
    printf '    1. push %s to origin\n' "$branch"
    printf '    2. open a draft pull request into main titled "%s"\n' "$(release_subject "$v")"
    printf '\nThen a person marks it ready, lets CI run, and merges it with rebase and merge.\n'
    return 0
  fi

  step "Push"
  git push --quiet -u origin "$branch"
  ok "pushed $branch"

  step "Pull request"
  url=$(gh pr list --head "$branch" --state open --json url --jq '.[0].url // empty')
  if [ -n "$url" ]; then
    ok "a pull request is already open: $url"
  else
    [ -n "$WORK" ] || WORK=$(mktemp -d)
    {
      section_body "$v" | sed '/./,$!d'
      printf '\n---\n\n'
      printf 'Merge with **rebase and merge**. Then, on main:\n\n'
      printf '    git switch main && git pull\n'
      printf '    scripts/release.sh tag %s\n' "$v"
    } >"$WORK/pr-body"
    url=$(gh pr create --draft --base main --head "$branch" \
      --title "$(release_subject "$v")" --body-file "$WORK/pr-body")
    ok "opened a draft pull request: $url"
  fi

  printf '\nNothing is released yet. Review %s, mark it ready (which runs CI), and merge it\n' "$url"
  printf 'with rebase and merge. Then, on main:\n\n'
  printf '    git switch main && git pull\n'
  printf '    scripts/release.sh tag %s\n' "$v"
}

# After the release PR has merged: tag the merged commit, which starts the
# release, and see it through.
cmd_tag() {
  local v=$1 dry_run=$2 cur subject sha tag branch w
  tag=$(tag_of "$v")
  branch=$(release_branch "$v")
  step "Preflight for tagging $C_PACKAGE $v"
  valid_version "$v" || die "'$v' is not a version of the form X.Y.Z"
  need_github
  if declare -F c_check_publish >/dev/null; then c_check_publish; fi
  require_main_in_sync
  ok "on main, fetched origin"

  [ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] ||
    die "main is not the same as origin/main; git pull first, so the tag goes on the commit that was merged"
  ok "main matches origin/main"

  subject=$(git log -1 --format=%s)
  [ "$subject" = "$(release_subject "$v")" ] ||
    die "the latest commit on main is '$subject', not '$(release_subject "$v")'. Has the release PR been merged, and is it still the latest commit? Tag it by hand if something landed after it"
  ok "HEAD is the $(release_subject "$v") commit"

  cur=$(c_current_version)
  [ "$cur" = "$v" ] || die "the $C_PACKAGE version is $cur, not $v"
  c_check_versions
  [ -z "$(git status --porcelain)" ] || die "the working tree is not clean"
  ok "working tree clean"
  require_tag_free "$v"
  c_check_plan "$v"

  sha=$(git rev-parse HEAD)

  if [ "$dry_run" = yes ]; then
    printf '\nDry run, so nothing was changed. It would now:\n\n'
    printf '    1. wait for %s to be green on %s\n' "$C_REQUIRED_WORKFLOWS $C_OPTIONAL_WORKFLOWS" "${sha:0:7}"
    printf '    2. create and push the tag %s on that commit\n' "$tag"
    printf '    3. watch the %s workflow to the end\n' "$C_RELEASE_WORKFLOW"
    printf '    4. title the release, and verify it\n'
    return 0
  fi

  step "Wait for CI on ${sha:0:7}"
  for w in $C_REQUIRED_WORKFLOWS; do
    wait_for_workflow "$w" "$sha" yes
  done
  # An optional workflow only runs when its path filters match; if they skip
  # it, carry on with a warning.
  for w in $C_OPTIONAL_WORKFLOWS; do
    wait_for_workflow "$w" "$sha" no
  done

  step "Tag"
  git tag -a "$tag" -m "$C_PACKAGE $v" "$sha"
  git push origin "$tag"
  ok "pushed $tag, which starts the release"

  step "Release workflow"
  wait_for_release_run "$tag" "$C_RELEASE_WORKFLOW"
  retitle_release "$tag" "$v"

  c_verify "$v"

  if git rev-parse -q --verify "refs/heads/$branch" >/dev/null; then
    printf '\nThe release branch is no longer needed: git branch -D %s\n' "$branch"
  fi
}

# `publish` was one step that pushed main and tagged it, which a main that
# takes changes only through pull requests cannot do. It is now two.
cmd_publish() {
  printf 'publish no longer exists: main takes changes only through pull requests.\n' >&2
  printf 'It is now two steps, with a review between them:\n\n' >&2
  printf '    scripts/release.sh propose %s     push the release branch, open a draft PR\n' "$1" >&2
  printf '    scripts/release.sh tag %s         after it is merged: tag, watch, verify\n' "$1" >&2
  exit 2
}
