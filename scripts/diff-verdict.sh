#!/usr/bin/env bash
# Lean model vs Rust verdict on random vectors (20k uniform + 20k biased past the limit checks). Must be identical.
set -euo pipefail
cd "$(dirname "$0")/.."
source scripts/env.sh
export LEAN_ABORT_ON_PANIC=1   # a malformed line makes the Lean runner panic; without this it exits 0 and prints a verdict from zero fields
T=$(mktemp -d)
python3 scripts/gen_verdict_cases.py 20000 7 > "$T/u.txt"
python3 scripts/gen_verdict_cases.py 20000 11 deep > "$T/d.txt"
for c in u d; do
  (cd contracts/airlock-verdict && cargo run -q --release --example diff < "$T/$c.txt") > "$T/$c.rust"
  ~/.elan/bin/lean --run proofs/VerdictRun.lean < "$T/$c.txt" 2>/dev/null | grep -E '^(allow|block:|escalate:)' > "$T/$c.lean"
  # an empty or short output on both sides must not compare equal and pass
  for side in rust lean; do n=$(wc -l < "$T/$c.$side" | tr -d ' '); [ "$n" -eq 20000 ] || { echo "FAIL $c.$side has $n verdicts, want 20000"; exit 1; }; done
  cmp -s "$T/$c.rust" "$T/$c.lean" || { echo "DIFF in $c batch"; diff <(nl "$T/$c.lean") <(nl "$T/$c.rust") | head; exit 1; }
done
echo "Lean and Rust verdicts identical on 40000 cases"
