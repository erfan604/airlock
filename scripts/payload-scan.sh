#!/usr/bin/env bash
# AIR-125: the repo's one payload leak scan. Searches every tracked and untracked (not ignored) file outside the data folders,
# and every commit message on every ref, for the markers in fixtures/payload-markers.txt (written by scripts/payload-markers.mjs),
# case-insensitively as fixed strings. Copies under bench/fixtures, fixtures, web/fixtures, bench/runs, runtime/recordings and third_party are
# allowed. Prints each hit, then PAYLOAD SCAN FOUND <n> (exit 1) or PAYLOAD SCAN OK (<m> markers) (exit 0). Exit 2 when the scan
# cannot run: marker file missing, empty or holding a blank line (a blank fixed string matches every line), or git grep failing.
# Usage: scripts/payload-scan.sh   (run from anywhere; it changes to the repo root)
set -uo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$here/.." || exit 2
M=fixtures/payload-markers.txt
[ -s "$M" ] || { echo "payload-scan: $M is missing or empty, so the scan cannot run"; exit 2; }
if grep -qn '^[[:space:]]*$' "$M"; then echo "payload-scan: $M has a blank line, so the scan cannot run"; exit 2; fi
markers=$(grep -c . "$M")

tree=$(git grep -n -i -F -f "$M" --untracked -- . ':!bench/fixtures' ':!fixtures' ':!web/fixtures' ':!bench/runs' ':!runtime/recordings' ':!third_party')
rc=$?
if [ "$rc" -gt 1 ]; then echo "payload-scan: git grep failed (exit $rc), so the scan cannot run"; exit 2; fi

msgs=""
if [ -n "$(git rev-list --all -n 1 2>/dev/null)" ]; then
  # each message line is prefixed with its short hash, so a hit names the commit
  msgs=$(git log --all --format='@@%h%n%B' | awk '/^@@/ {h = substr($0, 3); next} {print "commit " h ": " $0}' | grep -i -F -f "$M")
fi

hits=$(printf '%s\n%s\n' "$tree" "$msgs" | grep -c .)
if [ "$hits" -gt 0 ]; then
  printf '%s\n%s\n' "$tree" "$msgs" | grep .
  echo "PAYLOAD SCAN FOUND $hits"
  exit 1
fi
echo "PAYLOAD SCAN OK ($markers markers)"
