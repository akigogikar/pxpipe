#!/usr/bin/env bash
# sync-upstream.sh — pull upstream (teamchong/pxpipe) work into the fork, any time.
#
#   scripts/sync-upstream.sh list      # upstream PRs the fork lacks, ranked by expected yield
#   scripts/sync-upstream.sh pr <n>    # cherry-pick upstream PR #n -> test -> push -> fork PR
#   scripts/sync-upstream.sh merge     # merge all of upstream/main -> test -> push -> fork PR
#
# Ranking: PRs touching src/core (the savings engine) score 3x, other src/ files 1x,
# +1 for large diffs. Requires `gh` (authenticated) and `jq`-capable gh --jq.
# Defaults match this clone's layout (origin=teamchong upstream, fork=akigogikar);
# override via env: UPSTREAM_REMOTE FORK_REMOTE UPSTREAM_REPO FORK_REPO BRANCH TEST_CMD.
set -euo pipefail

UPSTREAM_REMOTE="${UPSTREAM_REMOTE:-origin}"
FORK_REMOTE="${FORK_REMOTE:-fork}"
UPSTREAM_REPO="${UPSTREAM_REPO:-teamchong/pxpipe}"
FORK_REPO="${FORK_REPO:-akigogikar/pxpipe}"
BRANCH="${BRANCH:-main}"
TEST_CMD="${TEST_CMD:-pnpm install --frozen-lockfile && pnpm test}"

say() { printf '\033[1m%s\033[0m\n' "$*"; }

git fetch "$UPSTREAM_REMOTE" "$BRANCH" --quiet
git fetch "$FORK_REMOTE" "$BRANCH" --quiet
UP="$UPSTREAM_REMOTE/$BRANCH"
FK="$FORK_REMOTE/$BRANCH"

in_fork() { git merge-base --is-ancestor "$1" "$FK" 2>/dev/null; }

test_push_pr() { # $1=branch $2=title $3=body
  say "Running: $TEST_CMD"
  eval "$TEST_CMD"
  git push -u "$FORK_REMOTE" "$1"
  gh pr create --repo "$FORK_REPO" --base "$BRANCH" --head "$1" --title "$2" --body "$3"
}

cmd="${1:-list}"
case "$cmd" in
  list)
    behind="$(git rev-list --count "$FK".."$UP")"
    say "Fork is $behind commit(s) behind $UPSTREAM_REPO/$BRANCH"
    [ "$behind" = 0 ] && exit 0
    say "Merged upstream PRs not yet in fork (score | PR | diff | core files | title):"
    gh pr list --repo "$UPSTREAM_REPO" --state merged --limit 30 \
      --json number,title,mergeCommit,additions,deletions,files \
      --jq '.[] | [.number, (.mergeCommit.oid // ""), .additions, .deletions,
                   ([.files[].path | select(startswith("src/core"))] | length),
                   ([.files[].path | select(startswith("src/"))] | length),
                   .title] | @tsv' \
    | while IFS=$'\t' read -r num oid add del core srcn title; do
        [ -n "$oid" ] || continue
        in_fork "$oid" && continue
        score=$(( core * 3 + (srcn - core) + (add > 200 ? 1 : 0) ))
        printf '%s\t#%s\t+%s/-%s\tcore:%s\t%s\n' "$score" "$num" "$add" "$del" "$core" "$title"
      done | sort -rn | column -t -s "$(printf '\t')"
    say "Next: scripts/sync-upstream.sh pr <n>   (or 'merge' for everything)"
    ;;

  pr)
    n="${2:?usage: sync-upstream.sh pr <number>}"
    oid="$(gh pr view "$n" --repo "$UPSTREAM_REPO" --json mergeCommit --jq '.mergeCommit.oid')"
    title="$(gh pr view "$n" --repo "$UPSTREAM_REPO" --json title --jq '.title')"
    [ -n "$oid" ] || { echo "PR #$n has no merge commit (not merged?)" >&2; exit 1; }
    if in_fork "$oid"; then say "PR #$n is already in $FK — nothing to do."; exit 0; fi
    br="sync/pr-$n"
    git switch -c "$br" "$FK"
    if [ "$(git rev-list --no-walk --count --merges "$oid")" = 1 ]; then
      git cherry-pick -x -m 1 "$oid" || { echo "Conflict — resolve or 'git cherry-pick --abort'." >&2; exit 1; }
    else
      git cherry-pick -x "$oid" || { echo "Conflict — resolve or 'git cherry-pick --abort'." >&2; exit 1; }
    fi
    test_push_pr "$br" "sync: upstream PR #$n — $title" \
      "Cherry-picked from $UPSTREAM_REPO#$n (\`$oid\`). Test command: \`$TEST_CMD\` passed before push."
    ;;

  merge)
    behind="$(git rev-list --count "$FK".."$UP")"
    if [ "$behind" = 0 ]; then say "Fork already up to date with $UPSTREAM_REPO/$BRANCH."; exit 0; fi
    br="sync/upstream-$(date +%Y%m%d)"
    git switch -c "$br" "$FK"
    git merge --no-edit "$UP" || { echo "Merge conflict — resolve, commit, then push manually." >&2; exit 1; }
    test_push_pr "$br" "sync: merge upstream/$BRANCH ($(date +%Y-%m-%d), $behind commits)" \
      "Merges $UPSTREAM_REPO/$BRANCH into the fork. Test command: \`$TEST_CMD\` passed before push."
    ;;

  *)
    echo "usage: sync-upstream.sh [list|pr <n>|merge]" >&2; exit 2 ;;
esac
