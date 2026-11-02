#!/usr/bin/env bash
# usage: scripts/invariant-map.sh [--allow-missing "I01 I05"]
# AIR-066: proves that no contract invariant of SPEC 8.4 is without a test. It lists the tests of contracts/airlock-policy (all targets)
# twice, once with every test and once with `--ignored`, and counts the tests that are not ignored per invariant: names starting
# `iNN_` for I01 to I09, and for I10 names starting `i10_` or the test `abi_complete_equals_spec`.
# Prints one row `I<NN> <count>` per invariant, then `ALL 10 INVARIANTS HAVE TESTS` (exit 0) or `MISSING: <ids>` (exit 1).
# With `--allow-missing "I01 I05"` it exits 0 only when the missing set is exactly that list (prints `MISSING (allowed): I01 I05`);
# any other gap, or a list that is no longer missing, fails. AIR-108 writes I01 and I05 and removes the flag in scripts/check.sh.
set -uo pipefail
repo="$(cd "$(dirname "$0")/.." && pwd)"
allowed=""
if [ "${1:-}" = "--allow-missing" ]; then
  allowed="$(printf '%s\n' "${2:-}" | tr ' ' '\n' | grep -v '^$' | sort | tr '\n' ' ' | sed 's/ $//')"
  [ -n "$allowed" ] || { echo "usage: invariant-map.sh [--allow-missing \"I01 I05\"]"; exit 2; }
  shift 2
elif [ $# -ne 0 ]; then
  echo "usage: invariant-map.sh [--allow-missing \"I01 I05\"]"
  exit 2
fi

if [ -z "${CARGO_TARGET_DIR:-}" ]; then
  # shellcheck disable=SC1091
  source "$repo/scripts/env.sh"
fi
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
cd "$repo/contracts/airlock-policy" || exit 2
cargo test --all-targets -- --list 2>/dev/null | grep ': test$' | sed 's/: test$//' | sort -u >"$tmp/all.txt" \
  || { echo "cargo test -- --list failed"; exit 2; }
cargo test --all-targets -- --list --ignored 2>/dev/null | grep ': test$' | sed 's/: test$//' | sort -u >"$tmp/ignored.txt"
# a name is live when it is listed and not ignored
comm -23 "$tmp/all.txt" "$tmp/ignored.txt" >"$tmp/live.txt"
[ -s "$tmp/live.txt" ] || { echo "no tests listed"; exit 2; }

missing=""
for n in 01 02 03 04 05 06 07 08 09 10; do
  if [ "$n" = "10" ]; then
    count="$(grep -cE '^(i10_|abi_complete_equals_spec$)' "$tmp/live.txt")"
  else
    count="$(grep -cE "^i${n}_" "$tmp/live.txt")"
  fi
  echo "I$n $count"
  [ "$count" -ge 1 ] || missing="$missing I$n"
done
missing="$(printf '%s\n' "$missing" | tr ' ' '\n' | grep -v '^$' | sort | tr '\n' ' ' | sed 's/ $//')"

if [ -z "$missing" ] && [ -z "$allowed" ]; then
  echo "ALL 10 INVARIANTS HAVE TESTS"
  exit 0
fi
if [ -n "$allowed" ] && [ "$missing" = "$allowed" ]; then
  echo "MISSING (allowed): $missing"
  exit 0
fi
echo "MISSING: ${missing:-none}"
exit 1
