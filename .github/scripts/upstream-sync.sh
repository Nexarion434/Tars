#!/usr/bin/env bash
# The git side of the daily upstream sync (decision D13), run by
# .github/workflows/upstream-sync.yml. The same steps as sync-upstream.ps1,
# split so the workflow can gate the merge before `windows` moves:
#
#   prepare          fetch upstream/main; if windows already holds it, say
#                    "nothing to sync" and stop. Otherwise merge it (--no-ff,
#                    never a rebase: windows is public) into win/sync-<date>
#                    and push that branch, for the gate to check out. On a
#                    conflict: abort the merge, push the branch at the base
#                    it was attempted on, and list the conflicted files.
#   promote          fast-forward windows to the merge the gate passed. Never
#                    forced: if windows moved meanwhile the push is refused.
#   mirror-main      fast-forward the fork's main to upstream/main, as
#                    sync-upstream.ps1 does. Refuses when main has diverged.
#   report-conflict  open an issue "Upstream sync conflict <date>" listing
#                    the files, or comment on the one still open.
#
# Environment (all optional but the ones each command names):
#   UPSTREAM_URL     default https://github.com/JeanBrasse/Tars.git (fetched only)
#   BASE_BRANCH      default windows
#   SYNC_DATE        default today, UTC, YYYY-MM-DD
#   SYNC_DRY_RUN=1   print every push and every gh call instead of running it
#   GITHUB_OUTPUT    where step outputs go (a scratch file when unset)
#
# Every failure exits non-zero. Nothing is ever force-pushed.
set -euo pipefail

UPSTREAM_URL="${UPSTREAM_URL:-https://github.com/JeanBrasse/Tars.git}"
BASE_BRANCH="${BASE_BRANCH:-windows}"
SYNC_DATE="${SYNC_DATE:-$(date -u +%Y-%m-%d)}"
SYNC_DRY_RUN="${SYNC_DRY_RUN:-0}"
OUTPUT_FILE="${GITHUB_OUTPUT:-$(mktemp)}"

say() { printf '%s\n' "$*"; }
fail() { printf '::error::%s\n' "$*"; exit 1; }
output() { printf '%s=%s\n' "$1" "$2" >> "$OUTPUT_FILE"; }
output_lines() {
  local delimiter="EOF_$(date +%s%N)_$RANDOM"
  { printf '%s<<%s\n' "$1" "$delimiter"; printf '%s\n' "$2"; printf '%s\n' "$delimiter"; } >> "$OUTPUT_FILE"
}

# git push, never with --force, and not at all in a dry run.
push() {
  if [ "$SYNC_DRY_RUN" = "1" ]; then
    say "dry run: git push $*"
  else
    git push "$@"
  fi
}

fetch_upstream() {
  if git remote get-url upstream >/dev/null 2>&1; then
    git remote set-url upstream "$UPSTREAM_URL"
  else
    git remote add upstream "$UPSTREAM_URL"
  fi
  # Fetch only: nothing is ever pushed to the upstream.
  git remote set-url --push upstream DISABLED-no-push
  git fetch --no-tags upstream "+refs/heads/main:refs/remotes/upstream/main"
}

fetch_origin() {
  git fetch --no-tags origin "+refs/heads/$1:refs/remotes/origin/$1"
}

remote_branch_sha() {
  git ls-remote --heads origin "refs/heads/$1" | cut -f1
}

cmd_prepare() {
  fetch_upstream
  fetch_origin "$BASE_BRANCH"
  local base upstream
  base="$(git rev-parse "refs/remotes/origin/$BASE_BRANCH")"
  upstream="$(git rev-parse refs/remotes/upstream/main)"
  output base "$base"
  output upstream "$upstream"

  if git merge-base --is-ancestor "$upstream" "$base"; then
    say "nothing to sync: $BASE_BRANCH ${base:0:7} already holds upstream/main ${upstream:0:7}"
    output state up-to-date
    return 0
  fi

  local branch="win/sync-$SYNC_DATE"
  if [ -n "$(remote_branch_sha "$branch")" ]; then
    # A second run the same day (a manual dispatch): a branch of its own.
    branch="$branch-${GITHUB_RUN_NUMBER:-$(date -u +%H%M%S)}"
  fi
  output branch "$branch"

  local count
  count="$(git rev-list --count "$base..$upstream")"
  say "merging upstream/main ${upstream:0:7} ($count new commits) into $BASE_BRANCH ${base:0:7} on $branch"
  git checkout --quiet -B "$branch" "$base"

  if git merge --no-ff --no-edit -m "Merge upstream/main ${upstream:0:7} into $BASE_BRANCH (upstream sync $SYNC_DATE)" "$upstream"; then
    local merged
    merged="$(git rev-parse HEAD)"
    say "clean merge: $merged"
    local workflows
    workflows="$(git diff --name-only "$base" "$merged" -- .github/workflows)"
    if [ -n "$workflows" ]; then
      say "this merge changes workflow files, which only a token with the workflows permission may push:"
      say "$workflows"
    fi
    push origin "$merged:refs/heads/$branch"
    output state merged
    output sha "$merged"
    return 0
  fi

  local conflicts
  conflicts="$(git diff --name-only --diff-filter=U)"
  git merge --abort
  if [ -z "$conflicts" ]; then
    fail "git merge of upstream/main failed without a conflicted file: see the log above"
  fi
  say "conflict, the merge is aborted. Conflicted files:"
  say "$conflicts"
  # The branch holds the base the merge was attempted on, nothing half-merged.
  push origin "$base:refs/heads/$branch"
  output state conflict
  output_lines conflicts "$conflicts"
}

cmd_promote() {
  : "${SYNC_SHA:?SYNC_SHA (the merge the gate passed) is required}"
  : "${SYNC_BRANCH:?SYNC_BRANCH is required}"
  fetch_origin "$BASE_BRANCH"
  local base
  base="$(git rev-parse "refs/remotes/origin/$BASE_BRANCH")"
  git cat-file -e "$SYNC_SHA^{commit}" 2>/dev/null || git fetch --no-tags origin "+refs/heads/$SYNC_BRANCH:refs/remotes/origin/$SYNC_BRANCH"
  if [ "$(git rev-parse "$SYNC_SHA^1")" != "$base" ]; then
    fail "$BASE_BRANCH is at ${base:0:7}, not at the base the merge ${SYNC_SHA:0:7} was made on: it moved during the gate. Nothing pushed; the next sync merges again."
  fi
  say "fast-forward $BASE_BRANCH ${base:0:7} -> ${SYNC_SHA:0:7}"
  push origin "$SYNC_SHA:refs/heads/$BASE_BRANCH"
  output sha "$SYNC_SHA"
  # The sync branch is merged now; remove it only if it still is that merge.
  if [ "$(remote_branch_sha "$SYNC_BRANCH")" = "$SYNC_SHA" ]; then
    push origin ":refs/heads/$SYNC_BRANCH"
  else
    say "$SYNC_BRANCH is not at ${SYNC_SHA:0:7} any more: left as it is"
  fi
}

cmd_mirror_main() {
  fetch_upstream
  fetch_origin main
  local main upstream
  main="$(git rev-parse refs/remotes/origin/main)"
  upstream="$(git rev-parse refs/remotes/upstream/main)"
  if [ "$main" = "$upstream" ]; then
    say "main already mirrors upstream/main ${upstream:0:7}"
    return 0
  fi
  if ! git merge-base --is-ancestor "$main" "$upstream"; then
    fail "the fork's main ${main:0:7} has diverged from upstream/main ${upstream:0:7}: never commit on main. Nothing pushed."
  fi
  say "fast-forward main ${main:0:7} -> ${upstream:0:7}"
  push origin "$upstream:refs/heads/main"
}

cmd_report_conflict() {
  : "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"
  : "${SYNC_CONFLICTS:?SYNC_CONFLICTS is required}"
  local title="Upstream sync conflict $SYNC_DATE"
  local run_url="${GITHUB_SERVER_URL:-https://github.com}/$GITHUB_REPOSITORY/actions/runs/${GITHUB_RUN_ID:-0}"
  local body
  body="$(mktemp)"
  {
    printf 'Merging `upstream/main` %s into `%s` %s conflicts. Nothing was merged and `%s` did not move.\n\n' \
      "${SYNC_UPSTREAM_SHA:-?}" "$BASE_BRANCH" "${SYNC_BASE_SHA:-?}" "$BASE_BRANCH"
    printf 'Conflicted files:\n\n'
    printf '%s\n' "$SYNC_CONFLICTS" | sed 's/^/- `/; s/$/`/'
    printf '\nBranch `%s` holds the base the merge was attempted on. Resolve with the win-upstream-sync agent (or sync-upstream.ps1), then push `%s`; the next daily sync finds nothing to merge.\n\n' \
      "${SYNC_BRANCH:-?}" "$BASE_BRANCH"
    printf 'Run: %s\n' "$run_url"
  } > "$body"

  if [ "$SYNC_DRY_RUN" = "1" ]; then
    say "dry run: gh issue create --repo $GITHUB_REPOSITORY --title \"$title\" --body-file:"
    cat "$body"
  else
    local open
    open="$(gh issue list --repo "$GITHUB_REPOSITORY" --state open --search 'in:title "Upstream sync conflict"' \
      --json number,title --jq '[.[] | select(.title | startswith("Upstream sync conflict"))][0].number // empty')"
    if [ -n "$open" ]; then
      gh issue comment "$open" --repo "$GITHUB_REPOSITORY" --body-file "$body"
      say "commented on the open issue #$open"
    else
      gh issue create --repo "$GITHUB_REPOSITORY" --title "$title" --body-file "$body"
    fi
  fi
  rm -f "$body"
  # A red run as well as the issue: the conflict needs a human.
  fail "upstream sync conflict: $(printf '%s\n' "$SYNC_CONFLICTS" | grep -c .) file(s), see the issue"
}

case "${1:-}" in
  prepare) cmd_prepare ;;
  promote) cmd_promote ;;
  mirror-main) cmd_mirror_main ;;
  report-conflict) cmd_report_conflict ;;
  *) fail "usage: upstream-sync.sh prepare|promote|mirror-main|report-conflict" ;;
esac
