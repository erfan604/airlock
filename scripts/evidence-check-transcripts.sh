#!/usr/bin/env bash
# AIR-285: checks the committed proof transcripts in docs/evidence (written by scripts/evidence-transcript.sh through
# scripts/g5-check.sh --record). This is the testable meaning of "the sha equals the tag": the tagged commit contains the transcripts,
# so it cannot be the commit they were produced on; it may differ from it by documentation only.
# Usage: scripts/evidence-check-transcripts.sh [<sha-or-tag>]     (default HEAD; run from anywhere, it changes to the repo root)
# Checks, all listed before it stops:
#   1  docs/evidence holds kani.txt, lean-axioms.txt, diff-verdict.txt, claims-offline.txt and check-full-tail.txt
#   2  line 1 of each starts with sha=<40 hex> and git finds that commit (git cat-file -e <sha>^{commit})
#   3  all five headers carry the same sha
#   4  git diff --name-only <header sha> <ref> (renames counted as a delete and an add) lists only README.md, files under docs/ and
#      video/x-post.txt: the transcripts commit and a later link fix do not count, code does
#   5  every file ends with exit=0 as its last line
#   6  scripts/payload-scan.sh exits 0
#   7  no file under docs/evidence contains /Users/ or /home/
# Last line: EVIDENCE TRANSCRIPTS OK sha=<the header sha> (exit 0), or EVIDENCE TRANSCRIPTS FAIL <n> after one FAIL line per problem
# (exit 1). Exit 2 is a usage error. Bash 3.2 compatible (macOS /bin/bash).
set -uo pipefail

usage() { echo "usage: scripts/evidence-check-transcripts.sh [<sha-or-tag>]" >&2; exit 2; }
[ "$#" -le 1 ] || usage
REF=${1:-HEAD}

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$here/.." || exit 2
DIR=docs/evidence
NAMES="kani lean-axioms diff-verdict claims-offline check-full-tail"
PROBLEMS=0
SHAS=""
W=$(mktemp -d "${TMPDIR:-/tmp}/evidence-check.XXXXXX") || { echo "evidence-check-transcripts: no temp directory" >&2; exit 2; }
trap 'case "$W" in */evidence-check.*) rm -rf "$W";; esac' EXIT

problem() { echo "FAIL $1"; PROBLEMS=$((PROBLEMS + 1)); }

for n in $NAMES; do
  f="$DIR/$n.txt"
  if [ ! -f "$f" ]; then problem "$f is missing"; continue; fi
  sha=$(head -n 1 "$f" | sed -n -E 's/^sha=([0-9a-f]{40}) .*$/\1/p')
  if [ -z "$sha" ]; then
    problem "$f: line 1 does not start with sha=<40 hex> followed by a space"
  else
    SHAS="$SHAS$sha"$'\n'
    git cat-file -e "$sha^{commit}" 2>/dev/null || problem "$f: commit $sha not found in this repository"
  fi
  last=$(tail -n 1 "$f")
  [ "$last" = "exit=0" ] || problem "$f: the last line is not exit=0 (it is: $last)"
done

DISTINCT=$(printf '%s' "$SHAS" | sort -u)
COUNT=$(printf '%s' "$DISTINCT" | grep -c . || true)
SHA=""
if [ "$COUNT" -gt 1 ]; then
  problem "the headers carry different shas: $(printf '%s' "$DISTINCT" | tr '\n' ' ')"
elif [ "$COUNT" -eq 1 ]; then
  SHA=$DISTINCT
  if git cat-file -e "$SHA^{commit}" 2>/dev/null; then
    if git diff --name-only --no-renames "$SHA" "$REF" > "$W/changed" 2> "$W/err"; then
      grep -v -E '^$|^(README\.md|video/x-post\.txt)$|^docs/' "$W/changed" > "$W/code" || true
      if [ -s "$W/code" ]; then
        problem "changed since the recorded sha $SHA, not documentation: $(head -n 10 "$W/code" | tr '\n' ' ')"
      fi
    else
      problem "git diff $SHA $REF failed: $(head -n 1 "$W/err")"
    fi
  fi
fi

if scripts/payload-scan.sh > "$W/scan" 2>&1; then :; else
  rc=$?
  problem "scripts/payload-scan.sh exited $rc: $(tail -n 1 "$W/scan")"
fi

if [ -d "$DIR" ]; then
  grep -rlE '/Users/|/home/' "$DIR" > "$W/leaks" 2>/dev/null || true
  while IFS= read -r leak; do
    [ -z "$leak" ] || problem "$leak contains /Users/ or /home/"
  done < "$W/leaks"
fi

if [ "$PROBLEMS" -gt 0 ]; then
  echo "EVIDENCE TRANSCRIPTS FAIL $PROBLEMS"
  exit 1
fi
echo "EVIDENCE TRANSCRIPTS OK sha=$SHA"
