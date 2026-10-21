#!/usr/bin/env bash
# Lists commits on upstream repositories that this fork has not picked up yet.
#
# Each source is "name|clone URL|branch|ref to exclude". Commits reachable from
# the exclude ref are skipped, which keeps a fork of upstream (SatsRouting) from
# re-reporting all of upstream's own history.
#
# Merged commits keep their SHA and drop out of `git rev-list`. Cherry-picked
# ones get a new SHA, so a commit only counts as new if its exact title also
# appears nowhere in this fork's history; `git cherry-pick` keeps the title.
# A hit can still be something already covered under a different title: once
# checked, add its SHA to .github/upstream-verified-ignore.txt.
#
# Usage: check-upstreams.sh [base ref, default origin/master]
# Exits 1 when there are commits to review.

set -euo pipefail

BASE="${1:-origin/master}"
IGNORE_FILE="$(dirname "$0")/../upstream-verified-ignore.txt"

SOURCES=(
  "upstream|https://github.com/BoltzExchange/boltz-backend.git|master|"
  "satsrouting|https://github.com/SatsRouting/boltz-backend.git|master|upstream/master"
)

IGNORED=()
if [ -f "$IGNORE_FILE" ]; then
  mapfile -t IGNORED < <(grep -v '^\s*#' "$IGNORE_FILE" | awk 'NF {print $1}')
fi

# Entries may be short SHAs
is_ignored() {
  local entry
  for entry in "${IGNORED[@]}"; do
    [[ "$1" == "$entry"* ]] && return 0
  done
  return 1
}

has_title_in_base() {
  local title="$1" candidate
  # --fixed-strings matches substrings, so compare the full titles exactly
  while IFS= read -r candidate; do
    [ "$candidate" = "$title" ] && return 0
  done < <(git log "$BASE" --format='%s' --fixed-strings --grep="$title")
  return 1
}

for source in "${SOURCES[@]}"; do
  IFS='|' read -r name url branch _ <<< "$source"
  if ! git remote get-url "$name" > /dev/null 2>&1; then
    git remote add "$name" "$url"
  fi
  git fetch --quiet --no-tags "$name" "+refs/heads/$branch:refs/remotes/$name/$branch"
done

FOUND=0
for source in "${SOURCES[@]}"; do
  IFS='|' read -r name _ branch exclude <<< "$source"
  range=("$BASE..$name/$branch")
  [ -n "$exclude" ] && range+=("^$exclude")

  lines=""
  while read -r sha; do
    is_ignored "$sha" && continue
    has_title_in_base "$(git log -1 --format='%s' "$sha")" && continue
    lines+=$(git log -1 --format='  - %h %s (%an, %ad)' --date=short "$sha")$'\n'
  done < <(git rev-list --reverse --no-merges "${range[@]}")

  if [ -z "$lines" ]; then
    echo "$name/$branch: nothing new"
  else
    FOUND=1
    echo "$name/$branch: commits to review (no matching title in $BASE):"
    printf '%s' "$lines"
    echo "  Review with: git fetch $name && git log --no-merges ${range[*]}"
  fi
done

exit "$FOUND"
