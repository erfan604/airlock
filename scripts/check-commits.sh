#!/usr/bin/env bash
# Checks commits that already exist, so a hook bypassed by any route (a flag, a shell trick, another tool) is still caught
# before a gate or a push: author and committer identity, no Co-Authored-By trailer, no em dash, type(scope): summary.
# Identity (Erfan, 2026-10-22): author and committer are the same person and one of two identities: erfan604 (his GitHub
# profile, 3 to 7 commits a day, picked by ~/apps/agent-tools/scripts/commit_identity.py) or erfan-7116 (everything else).
# A local day with more than 7 erfan604 commits fails, so a push can never put too many on his graph.
# Usage: scripts/check-commits.sh [revision range]     default: every commit reachable from HEAD
set -euo pipefail
# erfan604 uses his GitHub noreply address in this repo (plan D13, 2026-10-26): same profile credit, no personal email in public history.
ALT="erfan-7116 <erfan@welcomeaide.com>"; PROFILE="erfan604 <80935804+erfan604@users.noreply.github.com>"; MAX_DAY=7
RANGE="${1:-HEAD}"
git rev-parse --verify -q HEAD >/dev/null || { echo "check-commits: no commits yet"; exit 0; }
# list first, so a bad range or a missing object fails here instead of reading as "0 commits OK"
shas=$(git rev-list "$RANGE") || { echo "check-commits: git rev-list $RANGE failed"; exit 1; }
[ -n "$shas" ] || { echo "check-commits: no commits in $RANGE"; exit 1; }
bad=0; n=0
dash=$(printf '\xe2\x80\x94')
while IFS= read -r sha; do
  n=$((n + 1))
  a=$(git log -1 --format='%an <%ae>' "$sha"); c=$(git log -1 --format='%cn <%ce>' "$sha")
  msg=$(git log -1 --format=%B "$sha"); subj=$(git log -1 --format=%s "$sha")
  { [ "$a" = "$ALT" ] || [ "$a" = "$PROFILE" ]; } || { echo "BAD author $sha: $a"; bad=1; }
  [ "$c" = "$a" ] || { echo "BAD committer $sha: $c (must equal the author)"; bad=1; }
  if printf '%s\n' "$msg" | grep -Eqi '^[[:space:]]*co-authored-by[[:space:]]*:'; then echo "BAD trailer $sha: Co-Authored-By"; bad=1; fi
  if printf '%s' "$msg" | grep -qF "$dash"; then echo "BAD em dash in message $sha"; bad=1; fi
  if ! printf '%s\n' "$subj" | grep -Eq '^(feat|fix|docs|test|chore|refactor|perf|proofs|bench|build|ci)(\([a-z0-9,_-]+\))?: .+'; then
    # only a real merge commit (two or more parents) may keep git's default "Merge ..." subject
    parents=$(git rev-list --parents -n 1 "$sha" | wc -w | tr -d ' ')
    if [ "$parents" -gt 2 ] && [[ "$subj" == Merge* ]]; then :; else echo "BAD subject $sha: $subj"; bad=1; fi
  fi
done <<< "$shas"
# per local day, at most MAX_DAY commits by the profile email (GitHub credits the graph by author email)
over=$(git log --date=format-local:%Y-%m-%d --pretty='%ae %ad' $shas --no-walk 2>/dev/null | awk -v e="${PROFILE#*<}" -v m="$MAX_DAY" \
  'BEGIN{sub(/>$/,"",e)} $1==e {n[$2]++} END{for (d in n) if (n[d] > m) print d, n[d]}')
if [ -n "$over" ]; then echo "BAD too many erfan604 commits on: $over (max $MAX_DAY a day)"; bad=1; fi
[ "$bad" = 0 ] && echo "check-commits: $n commits OK" || echo "check-commits: FIX the commits above (amend or rebase before any push)"
exit "$bad"
