#!/usr/bin/env bash
# usage: scripts/plumbing-index.sh
# AIR-068: the index of the plumbing classes of F13 for docs/PLUMBING.md. Prints one row `<class> | <test or harness> | <file>` for each of
# ten items and exits 1 with `MISSING <name>` at the first one that is absent. The six contract tests are found with
# `cargo test --test plumbing -- --list`, the three Kani harnesses with a grep for `fn <name>` in the decimal model, the money lint with `test -x`.
# Last line `PLUMBING INDEX OK (10 rows)`.
set -uo pipefail
repo="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=env.sh
. "$repo/scripts/env.sh"
tests_file="contracts/airlock-policy/tests/plumbing.rs"
decimal_file="contracts/airlock-verdict/src/decimal.rs"
rows=0

listing="$(cd "$repo/contracts/airlock-policy" && cargo test --test plumbing -- --list 2>/dev/null)"

contract_test() {
  # $1 class, $2 test name
  if printf '%s\n' "$listing" | grep -qx "$2: test"; then
    printf '%s | %s | %s\n' "$1" "$2" "$tests_file"
    rows=$((rows + 1))
  else
    echo "MISSING $2"
    exit 1
  fi
}

harness() {
  # $1 class, $2 harness name
  if grep -q "fn $2" "$repo/$decimal_file"; then
    printf '%s | %s | %s\n' "$1" "$2" "$decimal_file"
    rows=$((rows + 1))
  else
    echo "MISSING $2"
    exit 1
  fi
}

contract_test "unit and currency" pink_malformed_currency_is_not_priced
contract_test "time window" pink_utc_not_local_hour
contract_test "rounding" pink_sub_unit_amounts
contract_test "overflow" overflow_reverts
contract_test "amounts across JSON" big_amounts_survive_json
contract_test "time zone strings" no_time_zone_strings
harness "decimals" placement_round_trip
harness "decimals" formatted_text_is_canonical
harness "decimals" parse_digits_never_panics
if test -x "$repo/scripts/lint-money.sh"; then
  printf '%s | %s | %s\n' "no float in money paths" "scripts/lint-money.sh" "scripts/lint-money.sh"
  rows=$((rows + 1))
else
  echo "MISSING scripts/lint-money.sh"
  exit 1
fi
echo "PLUMBING INDEX OK ($rows rows)"
