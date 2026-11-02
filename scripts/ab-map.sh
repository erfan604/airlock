#!/usr/bin/env bash
# usage: scripts/ab-map.sh
# AIR-084: maps the twelve approval-path attacks of Kodathala et al. (arXiv 2610.21063) to named contract tests. It lists the tests
# of contracts/airlock-policy/tests/approval_surface.rs and prints one row `AB<n> <test name>` for each name starting `ab01_` to
# `ab12_`, or `MISSING AB<n>` (exit 1 at the end) for an absent one. The last line is `AB1 TO AB12 ALL MAPPED` when none is missing.
set -uo pipefail
repo="$(cd "$(dirname "$0")/.." && pwd)"
if [ -z "${CARGO_TARGET_DIR:-}" ]; then
  # shellcheck disable=SC1091
  source "$repo/scripts/env.sh"
fi
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
cd "$repo/contracts/airlock-policy" || exit 2
cargo test --test approval_surface -- --list 2>/dev/null | grep ': test$' | sed 's/: test$//' | sort -u >"$tmp/names.txt"
missing=0
for n in 01 02 03 04 05 06 07 08 09 10 11 12; do
  name="$(grep -E "^ab${n}_" "$tmp/names.txt" | head -n 1)"
  if [ -n "$name" ]; then
    echo "AB$((10#$n)) $name"
  else
    echo "MISSING AB$((10#$n))"
    missing=1
  fi
done
if [ "$missing" -eq 0 ]; then
  echo "AB1 TO AB12 ALL MAPPED"
  exit 0
fi
exit 1
