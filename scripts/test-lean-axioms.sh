#!/usr/bin/env bash
# AIR-030: tests for scripts/lean-axioms.sh. Three cases, each in a scratch directory under mktemp -d (never the .lake build
# directory of proofs/):
#   1. a theorem proved by `sorry`: lake check must exit 1 and name sorryAx;
#   2. a theorem proved by `native_decide`: lake check must exit 1 and name the native_decide axiom;
#   3. a copy of proofs/ whose challenge file has one statement changed: lake comparator must exit 1 and say the statements differ.
# Last line: LEAN AXIOM TESTS OK (3 of 3). About 90 s.
set -u
cd "$(dirname "$0")/.."
source scripts/env.sh
ROOT="$PWD"
mkdir -p target
SCRATCH="$(mktemp -d)"
trap 'rm -rf "$SCRATCH"' EXIT
PASS=0

# case_fail <name> <dir> <mode> <needle>: scripts/lean-axioms.sh <dir> <mode> must exit 1 and print <needle>
case_fail() {
  local name=$1 dir=$2 mode=$3 needle=$4 out rc
  out=$("$ROOT/scripts/lean-axioms.sh" "$dir" "$mode" 2>&1); rc=$?
  if [ "$rc" -eq 1 ] && grep -qF -e "$needle" <<<"$out"; then
    echo "PASS $name"
    PASS=$((PASS + 1))
  else
    echo "FAIL $name (exit $rc, wanted exit 1 and: $needle)"
    printf '%s\n' "$out" | tail -5
  fi
}

# fixture_project <fixture file> <dir>: a one-file lake project whose only default target is the fixture. The build exits 0 even
# for a `sorry` (a warning) and writes lake-manifest.json, which lake check needs.
fixture_project() {
  mkdir -p "$2"
  cp proofs/lean-toolchain "$2/lean-toolchain"
  cp "$1" "$2/Fx.lean"
  printf 'name = "fx"\ndefaultTargets = ["Fx"]\n\n[[lean_lib]]\nname = "Fx"\n' > "$2/lakefile.toml"
  (cd "$2" && lake build > build.log 2>&1) || { echo "fixture build failed: $1"; tail -5 "$2/build.log"; return 1; }
}

if fixture_project proofs/fixtures/BadSorry.lean "$SCRATCH/sorry"; then
  case_fail "sorry is rejected" "$SCRATCH/sorry" check "Axiom 'sorryAx' is not permitted; it is used by 'bad_sorry'"
else
  echo "FAIL sorry is rejected (no fixture project)"
fi

if fixture_project proofs/fixtures/UsesNativeDecide.lean "$SCRATCH/native"; then
  case_fail "native_decide is rejected" "$SCRATCH/native" check "is not permitted; it is used by 'uses_native'"
else
  echo "FAIL native_decide is rejected (no fixture project)"
fi

# case 3: the frozen statement of one theorem is changed from <= to <, so Verdict.lean no longer proves what the challenge says
DRIFT="$SCRATCH/drift"
mkdir -p "$DRIFT/claims"
cp proofs/*.lean proofs/lakefile.toml proofs/lean-toolchain proofs/lake-manifest.json proofs/comparator.json "$DRIFT/"
cp proofs/claims/Challenge.lean proofs/claims/Solution.lean "$DRIFT/claims/"
perl -0pi -e 's/<=/</' "$DRIFT/claims/Challenge.lean"
if cmp -s proofs/claims/Challenge.lean "$DRIFT/claims/Challenge.lean"; then
  echo "FAIL statement drift is rejected (the mutation changed nothing)"
elif ! (cd "$DRIFT" && lake build > build.log 2>&1); then
  echo "FAIL statement drift is rejected (scratch build failed)"
  tail -5 "$DRIFT/build.log"
else
  case_fail "statement drift is rejected" "$DRIFT" comparator "Challenge and solution theorem statement do not match"
fi

if [ "$PASS" -eq 3 ]; then
  echo "LEAN AXIOM TESTS OK (3 of 3)"
  exit 0
fi
echo "LEAN AXIOM TESTS FAILED ($PASS of 3)"
exit 1
