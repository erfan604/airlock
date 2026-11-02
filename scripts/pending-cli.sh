#!/usr/bin/env bash
# AIR-087: list the pending escalations as a table (read only). Env: NEAR (default near), POLICY.
set -uo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ACCTS="$here/../fixtures/accounts.testnet.json"
NEAR="${NEAR:-near}"
POLICY="${POLICY:-$(jq -r .policy "$ACCTS")}"
if [ -z "$POLICY" ] || [ "$POLICY" = null ]; then echo "policy account missing" >&2; exit 1; fi

LIST="$("$NEAR" contract call-function as-read-only "$POLICY" get_pending json-args '{"from_index":0,"limit":20}' network-config testnet now 2> /dev/null)"
rc=$?
if [ "$rc" -ne 0 ]; then echo "near read failed (exit $rc)" >&2; exit 1; fi
if ! printf '%s' "$LIST" | jq -e 'type == "array"' > /dev/null 2>&1; then echo "unreadable pending list" >&2; exit 1; fi
if [ "$(printf '%s' "$LIST" | jq 'length')" = 0 ]; then echo "no pending requests"; exit 0; fi

{
  printf 'id\tto\tamount\twhy\tbook\texpires\n'
  printf '%s' "$LIST" | jq -r '.[] | [.id, .payee, (.display.asset_symbol + " " + .display.amount_decimal), .reason, .book_status,
    ((.expires_ms | tonumber / 1000 | floor) | todate)] | @tsv'
} | column -t -s "$(printf '\t')"
