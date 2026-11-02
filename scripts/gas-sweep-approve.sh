#!/usr/bin/env bash
# AIR-107: find the least prepaid gas `approve` needs on testnet. THE OWNER RUNS THIS: it sends real transactions signed by the owner key
# in the keychain, and the owner types the one `yes`. An agent session never runs it and never types the `yes`.
# Usage: scripts/gas-sweep-approve.sh <pending_id>
#   1. reads the card of the pending request with scripts/approve-cli.sh (read only) and shows it
#   2. reads one line from standard input and goes on only when it is exactly `yes`
#   3. sends `approve` with prepaid-gas 30, 40, ... 150 Tgas in ascending order on the SAME pending request (a failed approve changes
#      nothing: the promise creation panics, so the request stays pending), checks each transaction with EXPERIMENTAL_tx_status
#      (`status` is SuccessValue or Failure) and prints `SWEEP <N> Tgas success|failed`
#   4. stops at the first success n and prints `APPROVE_MIN_TGAS=<n> testnet` and `APPROVE_PREPAID_TGAS_TESTNET=<m>`, m = ceil(1.3 * n)
#      as integer arithmetic (n * 13 + 9) / 10; no success up to 150 prints `NO SUCCESS UP TO 150 TGAS` and exits 1
#   5. runs `pnpm tsx scripts/gas-testnet.ts approve_evm <hash>` and `pnpm tsx scripts/mpc-smoke.ts --resync-nonce` (the approval's
#      signature is never broadcast, so the contract nonce is ahead of the chain)
# Needs: bash, jq, curl, the near CLI, pnpm. Env (for tests): NEAR (default near), CURL (default curl), PNPM (default pnpm), OWNER and POLICY
# (default: fixtures/accounts.testnet.json), APPROVE_CLI (default scripts/approve-cli.sh next to this file), SWEEP_RPC (default
# https://test.rpc.fastnear.com), SWEEP_POLL_TRIES (default 10) and SWEEP_POLL_SECS (default 3).
set -uo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ACCTS="$here/../fixtures/accounts.testnet.json"
NEAR="${NEAR:-near}"
CURL="${CURL:-curl}"
PNPM="${PNPM:-pnpm}"
APPROVE_CLI="${APPROVE_CLI:-$here/approve-cli.sh}"
RPC="${SWEEP_RPC:-https://test.rpc.fastnear.com}"
TRIES="${SWEEP_POLL_TRIES:-10}"
SECS="${SWEEP_POLL_SECS:-3}"

usage() { echo "usage: gas-sweep-approve.sh <pending_id>" >&2; exit 2; }
[ "$#" -eq 1 ] || usage
ID="$1"
if ! printf '%s' "$ID" | grep -Eq '^[1-9][0-9]{0,9}$'; then
  echo "bad id: must be the canonical decimal of a u32, 1 to 10 digits, no leading zero" >&2
  exit 2
fi

OWNER="${OWNER:-$(jq -r .owner "$ACCTS")}"
POLICY="${POLICY:-$(jq -r .policy "$ACCTS")}"
if [ -z "$OWNER" ] || [ "$OWNER" = null ] || [ -z "$POLICY" ] || [ "$POLICY" = null ]; then
  echo "owner or policy account missing (fixtures/accounts.testnet.json, OWNER, POLICY)" >&2
  exit 1
fi

# 1. the card, read only
CARD="$("$APPROVE_CLI" "$ID")"
rc=$?
printf '%s\n' "$CARD"
if [ "$rc" -ne 0 ]; then echo "approve-cli.sh exited $rc" >&2; exit 1; fi
ARGS="$(printf '%s\n' "$CARD" | grep -E '^args +' | head -1 | sed -E 's/^args +//')"
if ! printf '%s' "$ARGS" | jq -e 'type == "object" and (.id | type == "string")' > /dev/null 2>&1; then
  echo "no args line in the card" >&2
  exit 1
fi

# 2. the one yes
printf 'type yes to send approve as %s with 30 to 150 Tgas until one succeeds: ' "$OWNER" >&2
LINE=""
IFS= read -r LINE || true
if [ "$LINE" != "yes" ]; then
  echo "aborted"
  exit 1
fi

# the status of a transaction: prints success, failed, or nothing while the transaction is not final yet
tx_state() {
  local hash="$1" body out
  body="$(jq -nc --arg h "$hash" --arg s "$OWNER" '{jsonrpc:"2.0",id:1,method:"EXPERIMENTAL_tx_status",params:{tx_hash:$h,sender_account_id:$s,wait_until:"FINAL"}}')"
  out="$("$CURL" -s -m 30 -X POST -H 'content-type: application/json' -d "$body" "$RPC" 2> /dev/null)" || return 0
  printf '%s' "$out" | jq -r 'if (.result.status | type) == "object" and (.result.status | has("SuccessValue")) then "success" elif (.result.status | type) == "object" and (.result.status | has("Failure")) then "failed" else empty end' 2> /dev/null
}

# 3. the sweep
MIN=""
HASH=""
N=30
while [ "$N" -le 150 ]; do
  OUT="$("$NEAR" contract call-function as-transaction "$POLICY" approve json-args "$ARGS" prepaid-gas "$N Tgas" attached-deposit '1 yoctoNEAR' sign-as "$OWNER" network-config testnet sign-with-keychain send 2>&1)"
  H="$(printf '%s\n' "$OUT" | grep -oE 'Transaction ID: *[1-9A-HJ-NP-Za-km-z]+' | head -1 | sed -E 's/^Transaction ID: *//')"
  if [ -z "$H" ]; then
    echo "the near CLI gave no transaction id at $N Tgas, so the result cannot be checked:" >&2
    printf '%s\n' "$OUT" | tail -5 >&2
    exit 1
  fi
  STATE=""
  i=0
  while [ "$i" -lt "$TRIES" ]; do
    STATE="$(tx_state "$H")"
    [ -n "$STATE" ] && break
    i=$((i + 1))
    sleep "$SECS"
  done
  if [ -z "$STATE" ]; then
    echo "no final status for $H at $N Tgas" >&2
    exit 1
  fi
  echo "SWEEP $N Tgas $STATE"
  if [ "$STATE" = success ]; then
    MIN="$N"
    HASH="$H"
    break
  fi
  N=$((N + 10))
done

if [ -z "$MIN" ]; then
  echo "NO SUCCESS UP TO 150 TGAS"
  exit 1
fi

# 4. the numbers
echo "APPROVE_MIN_TGAS=$MIN testnet"
echo "APPROVE_PREPAID_TGAS_TESTNET=$(((MIN * 13 + 9) / 10))"

# 5. the gas row of the successful approval, then the nonce resync
cd "$here/.." || exit 1
rc=0
"$PNPM" tsx scripts/gas-testnet.ts approve_evm "$HASH" || rc=1
"$PNPM" tsx scripts/mpc-smoke.ts --resync-nonce || rc=1
exit "$rc"
