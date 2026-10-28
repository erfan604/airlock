#!/usr/bin/env bash
# Runs the flood mutants against the Kani harnesses. Each mutant is a copy of the crate with its own target dir (Kani reuses a stale
# build when two copies of one package share CARGO_TARGET_DIR, measured), and the unmutated control must verify first.
set -uo pipefail
cd "$(dirname "$0")/.."
source scripts/env.sh
W="$(mktemp -d)"; trap 'rm -rf "$W"' EXIT
run_kani() { # <dir> <harness> -> log in $W/log
  (cd "$1" && CARGO_TARGET_DIR="$1/target" timeout 300 cargo kani --harness "$2" > "$W/log" 2>&1); }
copy() { mkdir -p "$W/$1" && cp -R contracts/airlock-verdict/Cargo.toml contracts/airlock-verdict/Cargo.lock contracts/airlock-verdict/rust-toolchain.toml contracts/airlock-verdict/src "$W/$1/"; }
bad=0
copy control
for h in flood_locked_never_stores flood_pending_never_exceeds_max flood_three_consecutive_rejects_lock flood_hourly_budget_holds; do
  run_kani "$W/control" "$h"; grep -q 'VERIFICATION:- SUCCESSFUL' "$W/log" || { echo "CONTROL FAILED $h"; exit 1; }
done
mutant() { # id harness expected-failure-text perl-expression
  copy "$1"; before=$(shasum "$W/$1/src/flood.rs")
  perl -0pi -e "$4" "$W/$1/src/flood.rs"
  [ "$before" != "$(shasum "$W/$1/src/flood.rs")" ] || { echo "$1 PATCH DID NOT APPLY"; bad=1; return; }
  run_kani "$W/$1" "$2"
  if grep -q 'VERIFICATION:- FAILED' "$W/log" && grep -A2 'Status: FAILURE' "$W/log" | grep -q "$3"; then echo "$1 killed by $2"; else echo "$1 SURVIVED $2"; bad=1; fi
}
mutant F1 flood_locked_never_stores 'an escalation was stored while locked' 's/    if s\.locked \{\n        return Err\(Reason::EscalationsLocked\);\n    \}\n//'
mutant F2 flood_pending_never_exceeds_max 'pending cap exceeded' 's/s\.pending >= l\.max_pending/s.pending > l.max_pending/'
mutant F3 flood_hourly_budget_holds 'admitted despite a refusal condition' 's/    if used >= l\.hourly_budget \{\n        return Err\(Reason::EscalationBudget\);\n    \}\n//'
mutant F4 flood_hourly_budget_holds 'refused without a reason' 's/let used = if hour == s\.hour \{\n?\s*s\.hour_count\n?\s*\} else \{\n?\s*0\n?\s*\};/let used = s.hour_count;/'
mutant F5 flood_three_consecutive_rejects_lock 'three consecutive rejects did not lock' 's/consecutive >= l\.lock_consecutive/consecutive > l.lock_consecutive/'
[ "$bad" = 0 ] && echo "FLOOD MUTANTS OK (5 killed)"; exit "$bad"
