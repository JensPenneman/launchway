#!/usr/bin/env bash
# Publishes the release that release-please proposes, signed by the maintainer.
#
# Every commit on main carries the maintainer's GPG signature, so the release
# pull request is never merged on GitHub. Instead, this script:
#
#   1. checks that the working tree is clean, main equals origin/main, exactly
#      one release pull request is open and is one commit on top of that main,
#      and that neither the tag nor a GitHub release of the version exists;
#   2. cherry-picks the release commit (version bumps and changelog) onto main
#      with -x, makes the maintainer its author and verifies its signature;
#   3. creates the signed tag vX.Y.Z and pushes main and the tag atomically;
#   4. publishes the GitHub release with the version's CHANGELOG.md section as
#      notes. Its release event starts the Images workflow; the script
#      dispatches the workflow itself when no run shows up;
#   5. closes the release pull request with a comment and deletes its branch.
#
# It asks before it changes anything and again before it publishes; --yes
# answers both. If it stops before the push, main and the tags are restored;
# if it stops after the push, it prints the commands that are left.
#
# Needs git with commit signing (commit.gpgsign), an authenticated GitHub CLI
# (gh) and Node.js. Runs with the bash 3.2 that ships with macOS.
#
# Usage: scripts/release.sh [--yes]
set -euo pipefail

readonly remote=origin
readonly branch=main
readonly release_branch_prefix="release-please--branches--${branch}"
readonly images_workflow=images.yml

assume_yes=false
while (($# > 0)); do
  case "$1" in
    -y | --yes) assume_yes=true ;;
    -h | --help)
      echo "Usage: scripts/release.sh [--yes]"
      echo "Publishes the open release-please pull request as a signed release (see CONTRIBUTING.md)."
      exit 0
      ;;
    *)
      echo "Usage: scripts/release.sh [--yes]" >&2
      exit 2
      ;;
  esac
  shift
done

say() { printf '\n==> %s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}
confirm() {
  if "$assume_yes"; then return 0; fi
  local answer=''
  read -r -p "$1 [y/N] " answer || true
  [[ "$answer" =~ ^[Yy]([Ee][Ss])?$ ]]
}

# stage: check (nothing changed yet), local (release commit and tag exist
# only locally), pushed (main and the tag are on the remote), finished.
stage=check
base=''
tag=''
notes_file=''
release_sha=''
pr_number=''

on_exit() {
  local status=$?
  if ((status != 0)); then
    case "$stage" in
      local)
        git cherry-pick --abort >/dev/null 2>&1 || true
        git tag -d "$tag" >/dev/null 2>&1 || true
        if git reset --quiet --keep "$base"; then
          echo "Nothing was pushed: $branch is back at $(git rev-parse --short HEAD) and the tag $tag is removed." >&2
        else
          warn "could not move $branch back to $base; check git status"
        fi
        ;;
      pushed)
        cat >&2 <<EOF
$branch and $tag are on $remote, but the release is not finished. Run what is left by hand:
  gh release view $tag || gh release create $tag --verify-tag --title $tag --notes-file $notes_file
  gh run list --workflow $images_workflow --event release --commit $release_sha
  gh workflow run $images_workflow -f version=$tag   # only when the list above is empty
  gh pr close $pr_number --delete-branch --comment "Released as $tag."
EOF
        return # keep the notes file for the commands above
        ;;
    esac
  fi
  if [[ -n "$notes_file" ]]; then rm -f "$notes_file"; fi
}
trap on_exit EXIT
trap 'exit 130' INT TERM

for tool in git gh node; do
  command -v "$tool" >/dev/null || die "$tool is required"
done
cd "$(git rev-parse --show-toplevel)"
gh auth status >/dev/null 2>&1 || die "the GitHub CLI is not signed in (gh auth login)"

# --- Checks -----------------------------------------------------------------

[[ -z "$(git status --porcelain)" ]] || die "the working tree is not clean"
[[ "$(git symbolic-ref --quiet --short HEAD || true)" == "$branch" ]] || die "check out $branch first"

say "Fetching $remote"
git fetch --quiet --tags "$remote" "$branch"
base=$(git rev-parse HEAD)
upstream=$(git rev-parse "refs/remotes/$remote/$branch")
[[ "$base" == "$upstream" ]] ||
  die "$branch ($(git rev-parse --short "$base")) differs from $remote/$branch ($(git rev-parse --short "$upstream")): pull or push first"

say "Looking for the release pull request"
prs=$(gh pr list --state open --base "$branch" --limit 100 \
  --json number,headRefName,headRefOid,url,title \
  --jq ".[] | select(.headRefName | startswith(\"$release_branch_prefix\")) | [.number, .headRefName, .headRefOid, .url, .title] | @tsv")
count=0
if [[ -n "$prs" ]]; then count=$(printf '%s\n' "$prs" | wc -l | tr -d ' '); fi
case "$count" in
  0) die "no release pull request is open: release-please opens one once $branch has commits that make a release (feat, fix, ...)" ;;
  1) ;;
  *) die "$count release pull requests are open; close all but the current one" ;;
esac
IFS=$'\t' read -r pr_number pr_branch pr_head pr_url pr_title <<<"$prs"

git fetch --quiet "$remote" "+refs/heads/$pr_branch:refs/remotes/$remote/$pr_branch"
release_commit=$(git rev-parse "refs/remotes/$remote/$pr_branch^{commit}")
[[ "$release_commit" == "$pr_head" ]] || die "the release branch changed while it was read; run the script again"

version=$(git show "$release_commit:.release-please-manifest.json" |
  node -e 'process.stdout.write(String(JSON.parse(require("node:fs").readFileSync(0, "utf8"))["."] ?? ""))')
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] ||
  die "unexpected version '$version' in .release-please-manifest.json of #$pr_number"
tag="v$version"

if git rev-parse --quiet --verify "refs/tags/$tag" >/dev/null ||
  [[ -n "$(git ls-remote --tags "$remote" "refs/tags/$tag")" ]]; then
  die "the tag $tag exists already"
fi
if gh release view "$tag" >/dev/null 2>&1; then die "a GitHub release $tag exists already"; fi

# The changelog of the release must cover every commit it ships.
if [[ "$(git rev-parse "$release_commit^")" != "$base" || "$(git rev-list --count "$base..$release_commit")" != 1 ]]; then
  die "#$pr_number is not one commit on top of $remote/$branch: release-please has not caught up with the latest push yet. Wait for the Release Please workflow, then run this again"
fi

notes_file=$(mktemp "${TMPDIR:-/tmp}/launchway-release-notes.XXXXXX")
# The version's section, heading included, without trailing blank lines.
git show "$release_commit:CHANGELOG.md" | awk -v version="$version" '
  /^## / {
    if (found) exit
    if (index($0, "## [" version "]") == 1 || index($0, "## " version " ") == 1) found = 1
  }
  !found { next }
  /^[[:space:]]*$/ { blanks++; next }
  { for (; blanks > 0; blanks--) print ""; print }
' >"$notes_file"
[[ -s "$notes_file" ]] || die "CHANGELOG.md of #$pr_number has no section for $version"

say "Release $tag"
echo "  pull request  #$pr_number $pr_title"
echo "                $pr_url"
echo "  commit        $(git log -1 --format='%h %an: %s' "$release_commit")"
git --no-pager diff --stat "$base" "$release_commit" | sed 's/^/  /'
echo
echo "  Release notes:"
sed -n '1,30s/^/  | /p' "$notes_file"
lines=$(wc -l <"$notes_file" | tr -d ' ')
if ((lines > 30)); then echo "  | ... ($((lines - 30)) more lines)"; fi
echo

confirm "Cherry-pick the release commit onto $branch and create the signed tag $tag?" ||
  die "stopped; nothing was changed"

# --- Local release commit and tag ------------------------------------------

stage=local
say "Cherry-picking $(git rev-parse --short "$release_commit") onto $branch"
git cherry-pick -x "$release_commit" >/dev/null || die "the cherry-pick failed"
git commit --quiet --amend --no-edit --author="$(git config user.name) <$(git config user.email)>"
release_sha=$(git rev-parse HEAD)
[[ "$(git log -1 --format=%G? HEAD)" == G ]] ||
  die "the release commit has no valid signature (git log --show-signature -1); check commit.gpgsign and the GPG agent"
[[ "$(git rev-parse 'HEAD^{tree}')" == "$(git rev-parse "$release_commit^{tree}")" ]] ||
  die "the cherry-picked commit does not match the release pull request"

say "Creating the signed tag $tag"
git tag -s "$tag" -m "$tag"
git tag -v "$tag" >/dev/null 2>&1 || die "the tag $tag has no valid signature"
git --no-pager log -1 --format='  %h  signature %G? by %GS%n  author %an <%ae>%n  %s' HEAD
echo

confirm "Push $branch and $tag to $remote, publish the GitHub release and close #$pr_number?" ||
  die "stopped before publishing"

# --- Publish ------------------------------------------------------------------

say "Pushing $branch and $tag"
# Together, so release-please (which runs on the push) already finds the tag
# and does not propose this version again.
git push --atomic "$remote" "refs/heads/$branch:refs/heads/$branch" "refs/tags/$tag:refs/tags/$tag"
stage=pushed

say "Publishing the GitHub release"
release_url=$(gh release create "$tag" --verify-tag --title "$tag" --notes-file "$notes_file")
echo "  $release_url"

say "Waiting for the Images workflow"
run_url=''
for _ in 1 2 3 4 5 6 7 8 9 10 11 12; do
  run_url=$(gh run list --workflow "$images_workflow" --event release --commit "$release_sha" \
    --limit 1 --json url --jq '.[0].url // ""')
  if [[ -n "$run_url" ]]; then break; fi
  sleep 5
done
if [[ -z "$run_url" ]]; then
  warn "the release event started no Images run within a minute; dispatching the workflow"
  gh workflow run "$images_workflow" --ref "$branch" -f "version=$tag"
  run_url="dispatched: gh run list --workflow $images_workflow --event workflow_dispatch"
fi
echo "  $run_url"

say "Closing #$pr_number"
gh pr close "$pr_number" --delete-branch --comment "Released as [$tag]($release_url). Every commit on \`$branch\` carries the maintainer's signature, so this pull request is not merged: \`scripts/release.sh\` cherry-picked its commit onto \`$branch\` as $release_sha, signed it and tagged it."
git branch --quiet --delete --remotes "$remote/$pr_branch" 2>/dev/null || true
stage=finished

say "Released $tag"
echo "  commit   $release_sha"
echo "  release  $release_url"
echo "  images   $run_url"
