#!/usr/bin/env bash
# AIR-126: the canary of the noninterference property. Four copies of the interpreter, each broken in one rule of AIR-121 by a patch
# (runtime/test/mutants/<name>.patch), must each fail runtime/test/interpreter.prop.test.ts, which reads the tree to test from AIR_SRC.
# A mutant that passes the property means the property cannot see that bug.
#   no-quarantine      R3: extraction adds no Untrusted:quarantine
#   no-selection-taint R5: a lookup that finds its key adds none of the key's untrusted labels
#   if-no-pc           R6: the body of an if runs with the pc unchanged
#   for-no-pc          R6: the body of a for runs with the pc unchanged
# Each patch is applied to a fresh copy of runtime/src under runtime/.mutants (inside runtime/ so zod and the other packages resolve).
# A patch that does not apply prints `MUTANT NOT APPLIED <name>` and exits 2, so a refactor of the interpreter cannot quietly neuter the
# canary; a run that fails without fast-check's `Property failed after <n> tests` is `MUTANT CRASHED <name>` (exit 2). The last line is
# `CANARY OK (4 mutants killed)` (exit 0) or the exit code is 1 when a mutant survived. The patch files are named by literal paths, one
# line per mutant, never through a loop variable.
# Usage: scripts/prop-canary.sh   (from anywhere; also `pnpm -C runtime test:prop:canary`)
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.." || exit 2
source scripts/env.sh
ROOT="$(pwd -P)"
killed=0
survived=0

cleanup() {
  rm -rf runtime/.mutants
}
trap cleanup EXIT

prepare() {
  rm -rf "runtime/.mutants/$1"
  mkdir -p "runtime/.mutants/$1"
  cp -R runtime/src "runtime/.mutants/$1/src"
}

not_applied() {
  echo "MUTANT NOT APPLIED $1"
  exit 2
}

run_mutant() {
  local name="$1" log status n
  log="$ROOT/target/canary-$name.log"
  mkdir -p "$ROOT/target"
  rm -f "$log"
  AIR_SRC="$ROOT/runtime/.mutants/$name/src" FC_RUNS=1000 FC_SEED=20261101 pnpm -C runtime exec tsx --test test/interpreter.prop.test.ts > "$log" 2>&1
  status=$?
  if [ "$status" -eq 0 ]; then
    echo "MUTANT SURVIVED $name"
    survived=$((survived + 1))
    return
  fi
  if grep -qE 'Property failed after [0-9]+ tests' "$log"; then
    n="$(grep -oE 'Property failed after [0-9]+ tests' "$log" | head -1 | grep -oE '[0-9]+')"
    echo "CANARY $name killed after $n tests"
    killed=$((killed + 1))
  else
    echo "MUTANT CRASHED $name"
    exit 2
  fi
}

prepare no-quarantine
patch -p1 -s -d runtime/.mutants/no-quarantine/src < runtime/test/mutants/no-quarantine.patch || not_applied no-quarantine
run_mutant no-quarantine

prepare no-selection-taint
patch -p1 -s -d runtime/.mutants/no-selection-taint/src < runtime/test/mutants/no-selection-taint.patch || not_applied no-selection-taint
run_mutant no-selection-taint

prepare if-no-pc
patch -p1 -s -d runtime/.mutants/if-no-pc/src < runtime/test/mutants/if-no-pc.patch || not_applied if-no-pc
run_mutant if-no-pc

prepare for-no-pc
patch -p1 -s -d runtime/.mutants/for-no-pc/src < runtime/test/mutants/for-no-pc.patch || not_applied for-no-pc
run_mutant for-no-pc

if [ "$survived" -ne 0 ]; then
  echo "CANARY FAILED ($survived mutants survived)"
  exit 1
fi
echo "CANARY OK ($killed mutants killed)"
