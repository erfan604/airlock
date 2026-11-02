#!/usr/bin/env bash
# AIR-030: every Lean theorem of the default build is replayed through the kernel by `lake check` and may use only propext,
# Classical.choice and Quot.sound (so sorryAx, native_decide and bv_decide fail), and the statement of every exported theorem
# is frozen in proofs/claims/Challenge.lean and compared by `lake comparator` (permitted axioms in proofs/comparator.json).
# Usage: scripts/lean-axioms.sh [DIR [check|comparator|all]]   (default: proofs all)
# Last two lines of a full run: "AXIOMS OK: <n> theorems" and "LEANCHECKER OK". The claim wording in docs is "replayed by the
# Lean kernel through lake check", never "leanchecker".
set -u
cd "$(dirname "$0")/.."
source scripts/env.sh
D="${1:-proofs}"; MODE="${2:-all}"
FLAG=--inadvisably-no-sandbox      # no bubblewrap on macOS; the project is our own code
mkdir -p target
fail() { echo "$*"; exit 1; }
case "$MODE" in all|check|comparator) ;; *) fail "usage: scripts/lean-axioms.sh [DIR [check|comparator|all]]";; esac
if [ "$MODE" = all ]; then       # every theorem of Verdict.lean must be pinned and stated in the challenge (Cedar's checkThm idea, cheaper)
  for t in $(grep -oE '^theorem [A-Za-z0-9_]+' "$D/Verdict.lean" | awk '{print $2}'); do
    jq -e --arg t "$t" '.theorem_names | index($t)' "$D/comparator.json" > /dev/null || fail "UNPINNED THEOREM: $t"
    grep -qE "^theorem $t( |\$)" "$D/claims/Challenge.lean" || fail "NOT IN CHALLENGE: $t"
  done
fi
if [ "$MODE" = all ] || [ "$MODE" = check ]; then
  # kernel replay and #print axioms assume the official prelude: a source that replaces it, or adds unsafe code or an elaborator, voids them
  bad=$(grep -rlwE --include='*.lean' --exclude-dir=.lake -e 'prelude|unsafe|elab' "$D" || true)
  [ -z "$bad" ] || fail "FORBIDDEN KEYWORD (prelude, unsafe or elab) in: $bad"
  (cd "$D" && lake check $FLAG) > target/lake-check.log 2>&1 || { grep -E '^error' target/lake-check.log; fail "LAKE CHECK FAILED"; }
fi
if [ "$MODE" = all ] || [ "$MODE" = comparator ]; then
  (cd "$D" && lake comparator $FLAG) > target/lake-comparator.log 2>&1 || { grep -E '^error' target/lake-comparator.log | head -5; fail "COMPARATOR FAILED"; }
fi
[ "$MODE" = all ] || { echo "OK ($MODE)"; exit 0; }
jq -r '.theorem_names[]' "$D/comparator.json" > "$D/THEOREMS.txt"
echo "AXIOMS OK: $(wc -l < "$D/THEOREMS.txt" | tr -d ' ') theorems"
echo "LEANCHECKER OK"
