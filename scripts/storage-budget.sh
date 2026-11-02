#!/usr/bin/env bash
# AIR-049: does the policy account hold enough NEAR for storage growth and the NEAR-lane payments? Read only (RPC view_account).
#   scripts/storage-budget.sh
# locked = storage_usage * 10^19 yocto (the RPC field `locked` is validator stake, not storage). Growth projection: 20 pending
# escalations at 0.007 NEAR, 100 book entries at 0.003 NEAR, 100 EVM attempts (AIR-104) at 0.003 NEAR. Requires
# amount - locked - growth >= 25 NEAR. Arithmetic is python3 integers in yoctoNEAR, never floats.
# Test hooks (scripts/test-bootstrap.sh): AIRLOCK_ACCOUNTS_FILE.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ACCOUNTS="${AIRLOCK_ACCOUNTS_FILE:-$ROOT/fixtures/accounts.testnet.json}"
RPCS="https://test.rpc.fastnear.com https://near-testnet.drpc.org https://testnet-rpc.intea.rs https://rpc.testnet.near.org"

die() { echo "$1"; exit 1; }
[ -f "$ACCOUNTS" ] || die "REFUSED: $ACCOUNTS is missing"
POLICY="$(jq -r '.policy // empty' "$ACCOUNTS")"
[ -n "$POLICY" ] || die "REFUSED: policy missing in $ACCOUNTS"

BODY="{\"jsonrpc\":\"2.0\",\"id\":\"airlock\",\"method\":\"query\",\"params\":{\"request_type\":\"view_account\",\"finality\":\"final\",\"account_id\":\"$POLICY\"}}"
ACC=""
for rpc in $RPCS; do
  r="$(curl -s --max-time 20 -X POST -H 'content-type: application/json' -d "$BODY" "$rpc" || true)"
  if printf '%s' "$r" | jq -e '.result.amount' > /dev/null 2>&1; then ACC="$r"; break; fi
done
[ -n "$ACC" ] || die "FAILED: no testnet RPC answered view_account for $POLICY"
AMOUNT="$(printf '%s' "$ACC" | jq -r '.result.amount')"
USAGE="$(printf '%s' "$ACC" | jq -r '.result.storage_usage')"

python3 -I - "$POLICY" "$AMOUNT" "$USAGE" <<'PY'
import sys
from decimal import Decimal, ROUND_CEILING, ROUND_FLOOR

policy, amount, usage = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
NEAR = 10**24
locked = usage * 10**19
growth = 20 * 7 * 10**21 + 100 * 3 * 10**21 + 100 * 3 * 10**21
need = 25 * NEAR
spendable = amount - locked
short = need + growth - spendable


def fmt(y, rounding):
    return str((Decimal(y) / Decimal(NEAR)).quantize(Decimal("0.01"), rounding=rounding))


print(f"account {policy}")
print(f"balance {fmt(amount, ROUND_FLOOR)} NEAR, locked for storage {fmt(locked, ROUND_CEILING)} NEAR ({usage} bytes)")
print(f"projected growth {fmt(growth, ROUND_CEILING)} NEAR, required spendable {fmt(need, ROUND_FLOOR)} NEAR")
if short > 0:
    print(f"STORAGE LOW: top up {fmt(short, ROUND_CEILING)} NEAR")
    sys.exit(1)
print(f"STORAGE OK: locked {fmt(locked, ROUND_CEILING)} NEAR, spendable {fmt(spendable, ROUND_FLOOR)} NEAR")
PY
