#!/usr/bin/env bash
# Privacy screen before the product repo goes public (AIR-252): issues and PRs become public together with the code.
# Scans every tracked file, commit history (messages, author and committer lines), and every GitHub issue and PR
# (titles, bodies, comments, PR review comments) for personal data patterns.
# The patterns live OUTSIDE any repo, one extended regex per line, so personal data is never committed even as a pattern:
#   ${AIRLOCK_PRIVACY_PATTERNS:-$HOME/.config/airlock/privacy-patterns}
# Usage: REPO=<owner>/<repo> scripts/privacy-screen.sh      exit 0 only when everything was screened and is clean,
# 1 when anything matches or could not be screened (fail closed), 2 on a missing or invalid pattern file.
set -euo pipefail
PAT="${AIRLOCK_PRIVACY_PATTERNS:-$HOME/.config/airlock/privacy-patterns}"
[ -s "$PAT" ] || { echo "no pattern file at $PAT; create it (one regex per line) before screening"; exit 2; }
# grep exits 0 on a match, 1 on no match and 2 on an error; an error must never read as "clean".
rc=0; grep -E -i -f "$PAT" /dev/null >/dev/null 2>&1 || rc=$?
[ "$rc" -le 1 ] || { echo "invalid regex in $PAT (grep exit $rc)"; exit 2; }
hits=0
scan() { # label, then text on stdin; prints matches, sets hits on a match or an error
  local label="$1" out rc=0
  out=$(grep -n -a -E -i -f "$PAT" 2>&1) || rc=$?
  case "$rc" in
    0) echo "$label"; printf '%s\n' "$out" | cut -c1-160 | sed 's/^/    /'; hits=1;;
    1) ;;
    *) echo "ERROR scanning $label (grep exit $rc): $out"; hits=1;;
  esac
}
# 1. tracked files (gitleaks covers secrets; this covers personal data); binary files are scanned as text (-a)
nfiles=0
while IFS= read -r -d '' f; do
  nfiles=$((nfiles + 1))
  [ -f "$f" ] || continue
  scan "FILE $f" < "$f"
done < <(git ls-files -z)
[ "$nfiles" -gt 0 ] || { echo "no tracked files: run inside the repo"; hits=1; }
git ls-files -z >/dev/null || { echo "ERROR: git ls-files failed; files were NOT screened"; hits=1; }
# 2. git history: messages, author and committer names and emails. Written to a file first: a pipeline would run scan in a
# subshell, where setting hits is lost, and a failing git log would go unnoticed.
H=$(mktemp); trap 'rm -f "$H"' EXIT
if git log --all --format='%H %an %ae %cn %ce %s%n%b' > "$H"; then
  scan "HISTORY (git log --all)" < "$H"
else
  echo "ERROR: git log failed; history was NOT screened"; hits=1
fi
# 3. GitHub issues and PRs, including comments and PR review comments
if [ -n "${REPO:-}" ]; then
  T=$(mktemp -d); trap 'rm -rf "$T" "$H"' EXIT
  for kind in issue pr; do
    if ! gh "$kind" list --repo "$REPO" --state all --limit 5000 --json number,title,body,comments > "$T/$kind.json"; then
      echo "ERROR: could not list ${kind}s for $REPO (gh failed); nothing was screened there"; hits=1; continue
    fi
    # count items, not lines: bodies contain newlines, so a line count overstates the number of issues (AIR-254 saw 15383)
    if ! n=$(jq 'length' "$T/$kind.json") || ! jq -r '.[] | "#\(.number)\t\(.title)\t\(.body)\t\([.comments[].body] | join(" "))"' \
         "$T/$kind.json" > "$T/$kind.txt"; then
      echo "ERROR: could not parse the ${kind} list for $REPO; nothing was screened there"; hits=1; continue
    fi
    [ "$n" -lt 5000 ] || { echo "ERROR: $n ${kind}s returned, the 5000 limit may have truncated the list"; hits=1; }
    scan "GITHUB ${kind}s" < "$T/$kind.txt"
  done
  if gh api --paginate "repos/$REPO/pulls/comments?per_page=100" --jq '.[] | "PR review comment \(.id)\t\(.body)"' > "$T/review.txt"; then
    scan "GITHUB PR review comments" < "$T/review.txt"
  else
    echo "ERROR: could not list PR review comments for $REPO"; hits=1
  fi
else
  echo "REPO not set: GitHub issues and PRs were NOT screened"; hits=1
fi
[ "$hits" = 0 ] && echo "privacy screen: clean ($nfiles files, history, issues, PRs, review comments)" \
  || echo "privacy screen: FIX the matches or errors above before going public"
exit "$hits"
