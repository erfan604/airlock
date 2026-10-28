#!/usr/bin/env bash
# AIR-023: the Lean model versus the Rust verdict on the same vectors. Must be identical.
# Usage: scripts/diff-verdict.sh [--quick|--commit] [--count N]
#   --quick   2,000 vectors (the default)             --commit  40,000 vectors: 15,000 uniform, 15,000 boundary, 10,000 toggle
#   --count N sets the total instead, split 3 : 3 : 2 over uniform, boundary and toggle (--nightly is added by AIR-032)
# Cases come from scripts/gen_verdict_cases.py (seeds 7, 11 and 13), one line of 21 natural numbers each. The Lean runner
# proofs/.lake/build/bin/verdict-run (built by `lake build verdict-run`, AIR-022) and the Rust driver contracts/airlock-verdict/examples/diff.rs
# read the same lines and print one tag each; the script requires exactly N lines on each side before comparing, so an empty output on both
# sides cannot compare equal. Files: target/diff.<section>.cases, target/diff.<section>.rust for uniform, boundary and toggle, target/diff.cases
# and target/diff.rust (their concatenations in that order). Output: the table of scripts/diff-report.py and then `identical on <N> cases`; on a
# difference `DIFFERENCES: <k> of <N>` with the first 10 (case number, input, both tags) and exit 1. A tag with count 0 or a toggle flip that
# does not give its rule's tag also fails the run (when the toggle part has the 22 lines of its block).
# DIFF_SELFTEST=1 corrupts one line of the Lean output only, to prove that a difference is detected.
set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck disable=SC1091
source scripts/env.sh
export LEAN_ABORT_ON_PANIC=1   # a malformed line must stop a Lean run that would panic instead of printing a verdict from zero fields

usage() {
  echo "usage: scripts/diff-verdict.sh [--quick|--commit] [--count N]" >&2
  exit 2
}

MODE=quick
COUNT=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --quick) MODE=quick; shift ;;
    --commit) MODE=commit; shift ;;
    --count)
      [ "$#" -ge 2 ] || usage
      COUNT=$2
      shift 2
      ;;
    *) usage ;;
  esac
done
if [ "$MODE" = commit ]; then N=40000; else N=2000; fi
if [ -n "$COUNT" ]; then
  case "$COUNT" in
    '' | *[!0-9]*) usage ;;
  esac
  N=$COUNT
fi
[ "$N" -ge 1 ] || usage
NU=$((N * 3 / 8))
NB=$NU
NT=$((N - NU - NB))

mkdir -p target
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT
(cd proofs && lake build verdict-run > /dev/null 2>&1) || { echo 'FAIL lake build verdict-run'; exit 1; }
RUN=proofs/.lake/build/bin/verdict-run
[ -x "$RUN" ] || { echo "FAIL $RUN was not built"; exit 1; }
(cd contracts/airlock-verdict && cargo build -q --release --example diff) || { echo 'FAIL cargo build --release --example diff'; exit 1; }

lines() { wc -l < "$1" | tr -d ' '; }

# section <name> <seed> <count>: the cases, the Lean tags in $T and the Rust tags in target/, each side with exactly <count> lines
section() {
  local name=$1 seed=$2 n=$3
  python3 scripts/gen_verdict_cases.py "$n" "$seed" "$name" > "target/diff.$name.cases"
  "$RUN" < "target/diff.$name.cases" > "$T/$name.lean"
  (cd contracts/airlock-verdict && cargo run -q --release --example diff) < "target/diff.$name.cases" > "target/diff.$name.rust"
  local c l r
  c=$(lines "target/diff.$name.cases")
  l=$(lines "$T/$name.lean")
  r=$(lines "target/diff.$name.rust")
  if [ "$c" -ne "$n" ] || [ "$l" -ne "$n" ] || [ "$r" -ne "$n" ]; then
    echo "FAIL $name: $c cases, $l Lean lines, $r Rust lines, want $n of each"
    exit 1
  fi
}

section uniform 7 "$NU"
section boundary 11 "$NB"
section toggle 13 "$NT"

cat target/diff.uniform.cases target/diff.boundary.cases target/diff.toggle.cases > target/diff.cases
cat "$T/uniform.lean" "$T/boundary.lean" "$T/toggle.lean" > "$T/all.lean"
cat target/diff.uniform.rust target/diff.boundary.rust target/diff.toggle.rust > target/diff.rust
LEAN_ALL="$T/all.lean"
if [ "${DIFF_SELFTEST:-}" = 1 ]; then
  # flip the first Lean tag: a comparison that cannot see this proves nothing
  awk 'NR == 1 { print ($0 == "allow" ? "block:Paused" : "allow"); next } { print }' "$T/all.lean" > "$T/all.corrupt"
  LEAN_ALL="$T/all.corrupt"
fi
if [ "$(lines "$LEAN_ALL")" -ne "$N" ] || [ "$(lines target/diff.rust)" -ne "$N" ] || [ "$(lines target/diff.cases)" -ne "$N" ]; then
  echo "FAIL the concatenated files do not all have $N lines"
  exit 1
fi

if ! cmp -s "$LEAN_ALL" target/diff.rust; then
  paste -d '\t' target/diff.cases "$LEAN_ALL" target/diff.rust > "$T/joined"
  k=$(awk -F'\t' '$2 != $3 { d++ } END { print d + 0 }' "$T/joined")
  echo "DIFFERENCES: $k of $N"
  awk -F'\t' '$2 != $3 { c++; if (c <= 10) printf "  case %d: %s\n    lean=%s rust=%s\n", NR, $1, $2, $3 }' "$T/joined"
  exit 1
fi

python3 scripts/diff-report.py target/diff.rust --commit-check || exit 1
if [ "$NT" -ge 22 ]; then
  python3 scripts/diff-report.py target/diff.toggle.rust --toggle-check > "$T/toggle.report" || { cat "$T/toggle.report"; exit 1; }
  tail -1 "$T/toggle.report"
fi
echo "identical on $N cases"
