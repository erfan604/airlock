#!/usr/bin/env bash
# AIR-024: the Lean consumer of the shared vector file family. Builds the Lean verdict runner (proofs/VerdictRun.lean, AIR-022), feeds it
# fixtures/verdict-vectors.lines (200 rows of the 21 natural numbers it reads, written by scripts/gen_vectors.mjs from the 200 `verdicts` of
# fixtures/verdict-vectors.json) and compares its 200 output tags with fixtures/verdict-vectors.expect (the `expect` tags in the same order).
# Lean has no JSON parser here, which is why the generator writes these two files.
# Usage: scripts/vector-lean-check.sh        (prints `OK 200 verdicts`, or `DIFFERENCES: <k> of 200` with the first 10 and exits 1)
# VECTOR_SELFTEST=1 flips the first expected tag before comparing, to prove the comparison detects a difference (it must exit 1).
set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck disable=SC1091
source scripts/env.sh
WANT=200
LINES=fixtures/verdict-vectors.lines
EXPECT=fixtures/verdict-vectors.expect
JSON=fixtures/verdict-vectors.json
RUN=proofs/.lake/build/bin/verdict-run
for f in "$LINES" "$EXPECT" "$JSON"; do
  [ -s "$f" ] || { echo "FAIL $f is missing or empty"; exit 1; }
done
(cd proofs && lake build verdict-run > /dev/null 2>&1) || { echo 'FAIL lake build verdict-run'; exit 1; }
[ -x "$RUN" ] || { echo "FAIL $RUN was not built"; exit 1; }
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT
"$RUN" < "$LINES" > "$T/lean.txt"
n=$(wc -l < "$T/lean.txt" | tr -d ' ')
[ "$n" -eq "$WANT" ] || { echo "FAIL verdict-run printed $n lines, want $WANT"; exit 1; }
cp "$EXPECT" "$T/expect.txt"
if [ "${VECTOR_SELFTEST:-}" = 1 ]; then
  # flip the first expected tag: a comparison that cannot see this proves nothing
  awk 'NR == 1 { print ($0 == "allow" ? "block:Paused" : "allow"); next } { print }' "$EXPECT" > "$T/expect.txt"
fi
m=$(wc -l < "$T/expect.txt" | tr -d ' ')
[ "$m" -eq "$WANT" ] || { echo "FAIL $EXPECT has $m lines, want $WANT"; exit 1; }
jq -r '.verdicts[].name' "$JSON" > "$T/names.txt"
k=$(wc -l < "$T/names.txt" | tr -d ' ')
[ "$k" -eq "$WANT" ] || { echo "FAIL $JSON has $k verdicts, want $WANT"; exit 1; }
diffs=$(paste -d '\t' "$T/names.txt" "$T/lean.txt" "$T/expect.txt" | awk -F'\t' '$2 != $3 { d++ } END { print d + 0 }')
if [ "$diffs" -ne 0 ]; then
  echo "DIFFERENCES: $diffs of $WANT"
  paste -d '\t' "$T/names.txt" "$T/lean.txt" "$T/expect.txt" | awk -F'\t' '$2 != $3 { c++; if (c <= 10) printf "  %s: lean=%s expect=%s\n", $1, $2, $3 }'
  exit 1
fi
echo "OK $WANT verdicts"
