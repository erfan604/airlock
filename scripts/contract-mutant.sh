#!/usr/bin/env bash
# usage: scripts/contract-mutant.sh <file relative to the repo root> '<perl -0pi expression>' <cargo test arguments...>
# Applies the expression to a copy of the repo, builds the wasm into a private target directory, runs the named test against that wasm
# (AIRLOCK_WASM) and prints MUTANT KILLED (a test failed) or MUTANT SURVIVED (all passed, exit 1). Exit 3: the expression changed
# nothing. Exit 4: the mutant did not build. Exit 5: no test ran. The working tree and the shared wasm are never touched.
set -uo pipefail
repo="$(cd "$(dirname "$0")/.." && pwd)"
file="$1"; expr="$2"; shift 2
W="$(mktemp -d)"; trap 'rm -rf "$W"' EXIT
rsync -a --exclude target --exclude node_modules --exclude .git --exclude .lake --exclude video "$repo/" "$W/repo/"
cd "$W/repo" || exit 1
before="$(shasum "$file")"
perl -0pi -e "$expr" "$file"
[ "$before" != "$(shasum "$file")" ] || { echo "PATCH DID NOT APPLY"; exit 3; }
source scripts/env.sh
(cd contracts/airlock-policy && CARGO_TARGET_DIR="$W/wasm-target" cargo near build non-reproducible-wasm --no-abi >"$W/build.out" 2>&1) \
  || { tail -5 "$W/build.out"; echo "MUTANT DID NOT BUILD"; exit 4; }
export AIRLOCK_WASM="$W/wasm-target/near/airlock_policy.wasm"
cd contracts/airlock-policy || exit 1
cargo test "$@" >"$W/test.out" 2>&1; rc=$?
if grep -qE 'test result: .* [1-9][0-9]* (passed|failed)' "$W/test.out"; then
  if [ "$rc" -eq 0 ]; then tail -3 "$W/test.out"; echo "MUTANT SURVIVED"; exit 1; fi
  if grep -q 'test result: FAILED' "$W/test.out"; then echo "MUTANT KILLED"; exit 0; fi
  tail -5 "$W/test.out"; echo "TEST DID NOT RUN"; exit 5
fi
tail -5 "$W/test.out"; echo "NO TEST MATCHED"; exit 5
