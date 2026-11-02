#!/usr/bin/env bash
# Prints the toolchain and dependency pins as a markdown table, pinned value next to the value this machine actually has (F08
# item 7; scripts/check.sh full writes it to target/pins.md, docs/EVIDENCE.md quotes it with the commit). Exit 1 on any MISMATCH.
# Rows: rustc 1.86.0, kani 0.68, lean 4.35.0 (also equal to proofs/lean-toolchain), node v24 (prefix), cargo-near 0.22, cargo-mutants 26.0.0, and
# near-sdk 5.26.1, omni-transaction 0.5.0, near-sandbox 0.3.9 read from contracts/airlock-policy/Cargo.lock (n/a while it is absent).
# The last line is `commit <short hash>` (`none` before the first commit).
# Usage: scripts/evidence-pins.sh > target/pins.md
set -uo pipefail
cd "$(dirname "$0")/.."
source scripts/env.sh

BAD=0
row() { # tool pinned actual status
  printf '| %s | %s | %s | %s |\n' "$1" "$2" "$3" "$4"
  [ "$4" = MISMATCH ] && BAD=1
  return 0
}
first_line() { printf '%s\n' "$1" | sed -n 1p; }
version_of() { printf '%s\n' "$1" | grep -oE '[0-9]+\.[0-9]+(\.[0-9]+)?' | sed -n 1p; }
# equal, or the pin is a prefix that ends at a dot (pin 0.68 accepts 0.68.0 but not 0.680)
pin_ok() { [ -n "$1" ] && { [ "$1" = "$2" ] || [[ "$1" == "$2".* ]]; }; }   # pin_ok <actual> <pin>
cmp_row() { # tool pinned actual
  if pin_ok "$3" "$2"; then row "$1" "$2" "$3" ok; else row "$1" "$2" "${3:-missing}" MISMATCH; fi
}

printf '| tool | pinned | actual | status |\n| --- | --- | --- | --- |\n'

out=$(rustup run 1.86.0 rustc --version 2>&1); cmp_row rustc 1.86.0 "$(version_of "$(first_line "$out")")"

out=$(cargo kani --version 2>&1); cmp_row kani 0.68 "$(version_of "$(first_line "$out")")"

out=$(lean --version 2>&1); lean_v=$(version_of "$(first_line "$out")")
tc=""
[ -f proofs/lean-toolchain ] && tc=$(tr -d ' \r' < proofs/lean-toolchain | sed -nE 's/^.*:v([0-9][^ ]*)$/\1/p' | sed -n 1p)
if [ "$lean_v" = 4.35.0 ] && [ "$tc" = 4.35.0 ]; then
  row lean 4.35.0 "$lean_v" ok
else
  row lean 4.35.0 "${lean_v:-missing} (proofs/lean-toolchain: ${tc:-missing})" MISMATCH
fi

out=$(node --version 2>&1); node_v=$(first_line "$out")
if [[ "$node_v" == v24.* ]]; then row node v24 "$node_v" ok; else row node v24 "${node_v:-missing}" MISMATCH; fi

out=$(cargo near --version 2>&1); cmp_row cargo-near 0.22 "$(version_of "$(first_line "$out")")"

out=$(cargo mutants --version 2>&1); cmp_row cargo-mutants 26.0.0 "$(version_of "$(first_line "$out")")"

LOCK=contracts/airlock-policy/Cargo.lock
lock_row() { # crate pinned
  local found
  if [ ! -f "$LOCK" ]; then row "$1" "$2" absent n/a; return 0; fi
  found=$(awk -v c="$1" '/^name = "/ {n=$3; gsub(/"/, "", n)} /^version = "/ {v=$3; gsub(/"/, "", v); if (n == c) print v}' "$LOCK" | paste -sd, -)
  if [ "$found" = "$2" ]; then row "$1" "$2" "$found" ok; else row "$1" "$2" "${found:-not in lock}" MISMATCH; fi
}
lock_row near-sdk 5.26.1
lock_row omni-transaction 0.5.0
lock_row near-sandbox 0.3.9

printf '\ncommit %s\n' "$(git rev-parse --verify -q --short HEAD 2>/dev/null || echo none)"
exit "$BAD"
