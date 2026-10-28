#!/usr/bin/env bash
# AIR-125: checks the fixture world's data files. (1) at least 11 fixtures/payloads/*.txt, all ASCII; (2) fixtures/payloads.sha256
# matches (shasum -a 256 -c) and lists every file it should (fixtures/world.jsonl, every payload, every fixtures/x402/*.json);
# (3) leak scan: node scripts/payload-markers.mjs --check, then scripts/payload-scan.sh. Every check runs, then the last line is
# PAYLOADS OK (<n> payloads, <m> x402 files, 0 leaks) (exit 0) or PAYLOADS FAIL <k> problems (exit 1); each problem is a FAIL line
# with the file and line where there is one.
# --update rewrites the manifest after checks 1 and 3 pass. It does not regenerate fixtures/payload-markers.txt: whoever adds or
# edits a payload file or an x402 description runs node scripts/payload-markers.mjs first, or check 3 stops the update.
# Usage: scripts/check-payloads.sh [--update]   (run from anywhere; it changes to the repo root)
set -uo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$here/.." || exit 1
UPDATE=0
[ "${1:-}" = --update ] && UPDATE=1
MANIFEST=fixtures/payloads.sha256
problems=0
problem() { echo "FAIL $1"; problems=$((problems + 1)); }

n=0; m=0; listed=""
for f in fixtures/payloads/*.txt; do [ -f "$f" ] && { n=$((n + 1)); listed="$listed $f"; }; done
for f in fixtures/x402/*.json; do [ -f "$f" ] && { m=$((m + 1)); listed="$listed $f"; }; done
[ -f fixtures/world.jsonl ] && listed="fixtures/world.jsonl$listed"

# (1) count and ASCII
[ "$n" -ge 11 ] || problem "count: $n payload files in fixtures/payloads, at least 11 needed"
if [ "$n" -gt 0 ]; then
  bad=$(perl -ne 'print "$ARGV:$.\n" if /[^\x00-\x7F]/; close ARGV if eof' fixtures/payloads/*.txt)
  for at in $bad; do problem "ascii: $at has a byte above 0x7F"; done
fi

# (3) leak scan, before the manifest so that --update can stop on it
if ! out=$(node scripts/payload-markers.mjs --check 2>&1); then problem "markers: $out"; fi
out=$(scripts/payload-scan.sh 2>&1); rc=$?
case "$rc" in
  0) ;;
  1) printf '%s\n' "$out" | sed '$d'; problem "leak: $(printf '%s\n' "$out" | tail -1 | sed 's/^PAYLOAD SCAN FOUND //') payload lines outside the data folders" ;;
  *) problem "scan could not run: $out" ;;
esac

# (2) manifest
if [ "$UPDATE" -eq 1 ]; then
  if [ "$problems" -gt 0 ]; then echo "PAYLOADS FAIL $problems problems (manifest not updated)"; exit 1; fi
  # shellcheck disable=SC2086
  shasum -a 256 $listed > "$MANIFEST"
  echo "wrote $MANIFEST ($(grep -c . "$MANIFEST") files)"
elif [ ! -s "$MANIFEST" ]; then
  problem "manifest: $MANIFEST is missing or empty (run scripts/check-payloads.sh --update)"
else
  if ! out=$(shasum -a 256 -c "$MANIFEST" 2>&1); then
    printf '%s\n' "$out" | grep -v ': OK$'
    problem "manifest: a listed file changed or is missing"
  fi
  for f in $listed; do
    awk -v f="$f" '{sub(/^[0-9a-f]+  /, "")} $0 == f {found = 1} END {exit !found}' "$MANIFEST" || problem "manifest: $f is not listed (run scripts/check-payloads.sh --update)"
  done
fi

if [ "$problems" -gt 0 ]; then echo "PAYLOADS FAIL $problems problems"; exit 1; fi
echo "PAYLOADS OK ($n payloads, $m x402 files, 0 leaks)"
