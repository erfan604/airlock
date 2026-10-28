#!/usr/bin/env bash
# Import the AIR-*.md tickets into GitHub Issues for the product repo (Day 1, once, with Erfan's yes; AIR-006).
# Creates labels (epic, tier, owner, cut), one milestone per gate with its due date, and one issue per ticket whose body is
# the ticket body plus a front-matter summary. Records AIR id to issue number in <tickets>/github_map.json.
# E13 tickets (Erfan's pre-window and personal work) are never imported: issue bodies become public with the repo.
# Cut tickets are imported and closed as "not planned" with the label cut, so every AIR-### named elsewhere resolves.
# Safe to re-run: tickets already in github_map.json are skipped, so a re-run prints "created 0".
#
# Usage: TICKETS=<dir, default plan/tickets> REPO=<owner>/<repo> scripts/import-tickets.sh [--yes]
#   without --yes: dry run, prints the planned gh commands ("+ ...") and writes and sends nothing
#   IMPORT_LIMIT=<n> stops after n creations (the first live run uses 2, to inspect labels, milestone and body)
#   IMPORT_SLEEP (default 2 s after every creation) and IMPORT_RETRY_WAIT (default 60 s) exist for the tests
# Last line: IMPORT SUMMARY created <c> skipped_mapped <m> skipped_e13 <e> closed_cut <x>
set -euo pipefail
REPO="${REPO:?set REPO=owner/repo}"
DIR="${TICKETS:-plan/tickets}"; MAP="$DIR/github_map.json"
DRY=1; [ "${1:-}" = "--yes" ] && DRY=0
[ "$DRY" = 1 ] && echo "Dry run. Re-run with --yes after Erfan confirms the repo: $REPO"
LIMIT="${IMPORT_LIMIT:-0}"; SLEEP="${IMPORT_SLEEP:-2}"; WAIT="${IMPORT_RETRY_WAIT:-60}"
created=0; mapped=0; e13=0; closed=0

# gh with one retry when GitHub answers with its secondary rate limit; a second failure exits 1
gh_retry() {
  local out
  if out=$(gh "$@" 2>&1); then printf '%s\n' "$out"; return 0; fi
  if printf '%s\n' "$out" | grep -qiE 'secondary rate limit|was submitted too quickly'; then
    echo "gh rate limited, retrying once in ${WAIT}s" >&2; sleep "$WAIT"
    if out=$(gh "$@" 2>&1); then printf '%s\n' "$out"; return 0; fi
  fi
  printf '%s\n' "$out" >&2; echo "gh failed: gh $*" >&2; exit 1
}
field() { sed -n "s/^$1: *//p" "$2" | head -1 | sed 's/[[:space:]]#.*$//;s/[[:space:]]*$//'; }   # front matter value, comment stripped
in_map() {
  [ -f "$MAP" ] || return 1
  python3 - "$MAP" "$1" <<'PY'
import json, sys
p, k = sys.argv[1:]
sys.exit(0 if k in json.load(open(p)) else 1)
PY
}

due() { case "$1" in G0) echo 2026-10-30;; G1) echo 2026-11-02;; G1b) echo 2026-11-05;; G2) echo 2026-11-07;;
  G3) echo 2026-11-09;; G4) echo 2026-11-09;; Freeze) echo 2026-11-10;; G5) echo 2026-11-12;; G6) echo 2026-11-13;; esac; }
for g in G0 G1 G1b G2 G3 G4 Freeze G5 G6; do      # bash 3.2 on macOS has no associative arrays
  args=(api "repos/$REPO/milestones" -f "title=$g" -f "due_on=$(due "$g")T23:59:00Z")
  if [ "$DRY" = 1 ]; then echo "+ gh ${args[*]}"; continue; fi
  if ! out=$(gh "${args[@]}" 2>&1); then
    printf '%s\n' "$out" | grep -q 'already_exists' || { printf '%s\n' "$out" >&2; echo "milestone $g failed" >&2; exit 1; }
  fi
done
for l in E00 E01 E02 E03 E04 E05 E06 E07 E08 E09 E10 E11 E12 E13 Floor Should Defer claude erfan both cut; do
  if [ "$DRY" = 1 ]; then echo "+ gh label create $l --repo $REPO --force"; continue; fi
  gh label create "$l" --repo "$REPO" --force > /dev/null 2>&1 || { echo "label $l failed" >&2; exit 1; }
done

for f in "$DIR"/AIR-*.md; do
  id=$(field id "$f")
  [[ "$id" =~ ^AIR-[0-9]{3}$ ]] || { echo "skipping $f: bad id '$id'"; continue; }
  epic=$(field epic "$f")
  if [ "$epic" = "E13" ] && [ "${INCLUDE_E13:-0}" != 1 ]; then e13=$((e13 + 1)); continue; fi
  if in_map "$id"; then mapped=$((mapped + 1)); continue; fi
  if [ "$LIMIT" -gt 0 ] && [ "$created" -ge "$LIMIT" ]; then break; fi
  title=$(field title "$f"); tier=$(field tier "$f"); gate=$(field gate "$f"); owner=$(field owner "$f"); status=$(field status "$f")
  labels="$epic,$tier,$owner"; [ "$status" = cut ] && labels="$labels,cut"
  body=$(awk 'BEGIN{n=0} /^---$/{n++; next} n>=2{print}' "$f")
  meta=$(awk 'BEGIN{n=0} /^---$/{n++; next} n==1{print}' "$f")
  if [ "$DRY" = 1 ]; then
    echo "+ gh issue create [$id] $title ($epic, $tier, $gate, $owner)"
    [ "$status" = cut ] && echo "+ gh issue close <new issue of $id> --reason \"not planned\""
    continue
  fi
  url=$(gh_retry issue create --repo "$REPO" --title "[$id] $title" --label "$labels" --milestone "$gate" \
        --body "$(printf '```\n%s\n```\n\n%s' "$meta" "$body")" | tail -1)
  num="${url##*/}"
  [[ "$num" =~ ^[0-9]+$ ]] || { echo "unexpected gh issue create answer for $id: $url" >&2; exit 1; }
  # values go in as argv, never interpolated into code
  python3 - "$MAP" "$id" "$num" <<'PY'
import json, os, sys
p, k, v = sys.argv[1:]
m = json.load(open(p)) if os.path.exists(p) else {}
m[k] = int(v); json.dump(m, open(p, "w"), indent=1, sort_keys=True)
PY
  created=$((created + 1)); echo "$id -> #$num"
  if [ "$status" = cut ]; then gh_retry issue close "$num" --repo "$REPO" --reason "not planned" > /dev/null; closed=$((closed + 1)); fi
  sleep "$SLEEP"
done
echo "IMPORT SUMMARY created $created skipped_mapped $mapped skipped_e13 $e13 closed_cut $closed"
