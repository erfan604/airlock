#!/usr/bin/env bash
# AIR-087: owner approve and reject from the command line, fallback for the wallet (cut ladder rung 7).
# Usage: scripts/approve-cli.sh <id> [--reject] [--run]
#   default: read the stored request, print the card and the command, run nothing (exit 0)
#   --reject: same card, the `reject` command
#   --run: print, then read one line from standard input and execute only if it is exactly `yes`
# The six values of `approve` come from the stored RequestView only, never from the command line.
# Env: NEAR (default near), OWNER and POLICY (default: keys owner and policy of fixtures/accounts.testnet.json).
APPROVE_PREPAID_TGAS="${APPROVE_PREPAID_TGAS:-150}"
REJECT_PREPAID_TGAS=30
set -uo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ACCTS="$here/../fixtures/accounts.testnet.json"
NEAR="${NEAR:-near}"

usage() { echo "usage: approve-cli.sh <id> [--reject] [--run]" >&2; exit 2; }

ID=""
HAVE_ID=0
REJECT=0
RUN=0
for a in "$@"; do
  case "$a" in
    --reject) REJECT=1 ;;
    --run) RUN=1 ;;
    *)
      if [ "$HAVE_ID" = 1 ]; then usage; fi
      ID="$a"
      HAVE_ID=1 ;;
  esac
done
[ "$HAVE_ID" = 1 ] || usage
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

# One read. The near CLI prints the return value on stdout and decoration on stderr.
VIEW="$("$NEAR" contract call-function as-read-only "$POLICY" get_request json-args "$(jq -nc --arg id "$ID" '{id:$id}')" network-config testnet now 2> /dev/null)"
rc=$?
if [ "$rc" -ne 0 ]; then echo "near read failed (exit $rc)" >&2; exit 1; fi
if [ "$(printf '%s' "$VIEW" | jq -c . 2> /dev/null)" = "null" ]; then echo "unknown id $ID" >&2; exit 1; fi
if ! printf '%s' "$VIEW" | jq -e 'type == "object"' > /dev/null 2>&1; then echo "unreadable request view" >&2; exit 1; fi

STATE="$(printf '%s' "$VIEW" | jq -r '.state // empty')"
if [ "$STATE" != "Pending" ]; then
  echo "NOT PENDING: state ${STATE:-unknown}"
  exit 1
fi
EXPIRES_MS="$(printf '%s' "$VIEW" | jq -r '.expires_ms // empty')"
if ! printf '%s' "$EXPIRES_MS" | grep -Eq '^[0-9]{1,16}$'; then echo "bad expires_ms" >&2; exit 1; fi
NOW_MS=$(( $(date +%s) * 1000 ))
if [ "$EXPIRES_MS" -le "$NOW_MS" ]; then
  echo "EXPIRED: this request ran out of time; anyone can call expire on it"
  exit 1
fi

TO="$(printf '%s' "$VIEW" | jq -r '.payee')"
SYMBOL="$(printf '%s' "$VIEW" | jq -r '.display.asset_symbol')"
AMOUNT="$(printf '%s' "$VIEW" | jq -r '.display.amount_decimal')"
WHY="$(printf '%s' "$VIEW" | jq -r '.reason')"
BOOK="$(printf '%s' "$VIEW" | jq -r '.book_status')"
DIGEST="$(printf '%s' "$VIEW" | jq -r '.digest')"

# Label masks to names, bit order of GLOSSARY and AIR-024.
mask_names() {
  jq -nr --argjson m "$1" '
    ["Owner","Book","Policy","Oracle","Unresolved","Untrusted:email","Untrusted:web","Untrusted:file","Untrusted:chat",
     "Untrusted:social","Untrusted:tool_output","Untrusted:memory","Untrusted:quarantine","Untrusted:payment_protocol","Untrusted:other"] as $n
    | [range(0; 15) as $i | select((($m / pow(2; $i)) | floor) % 2 == 1) | $n[$i]]
    | if length == 0 then "none" else join("+") end'
}
LAB_R="$(mask_names "$(printf '%s' "$VIEW" | jq -r '.labels.recipient')")"
LAB_A="$(mask_names "$(printf '%s' "$VIEW" | jq -r '.labels.amount')")"
LAB_P="$(mask_names "$(printf '%s' "$VIEW" | jq -r '.labels.pc')")"
EXPIRES_ISO="$(node -e 'console.log(new Date(Number(process.argv[1])).toISOString())' "$EXPIRES_MS")"

APPROVE_ARGS="$(jq -nc --arg id "$ID" --arg to "$TO" --arg asset "$SYMBOL" --arg amount "$AMOUNT" --arg why "$WHY" --arg book "$BOOK" \
  '{id:$id,to:$to,asset:$asset,amount:$amount,why:$why,book:$book}')"
REJECT_ARGS="$(jq -nc --arg id "$ID" '{id:$id}')"

if [ "$REJECT" = 1 ]; then
  METHOD=reject; ARGS="$REJECT_ARGS"; GAS="${REJECT_PREPAID_TGAS} Tgas"
else
  METHOD=approve; ARGS="$APPROVE_ARGS"; GAS="${APPROVE_PREPAID_TGAS} Tgas"
fi
# Printed form: single quotes, with an embedded single quote escaped for a shell.
quoted_args="'$(printf '%s' "$ARGS" | sed "s/'/'\\\\''/g")'"

echo "APPROVE CARD pending id $ID"
echo "to       $TO"
echo "asset    $SYMBOL"
echo "amount   $AMOUNT"
echo "why      $WHY"
echo "book     $BOOK"
echo "labels   recipient=$LAB_R amount=$LAB_A pc=$LAB_P"
echo "expires  $EXPIRES_ISO"
echo "digest   $DIGEST"
echo "args     $APPROVE_ARGS"
echo "command  near contract call-function as-transaction $POLICY $METHOD json-args $quoted_args prepaid-gas '$GAS' attached-deposit '1 yoctoNEAR' sign-as $OWNER network-config testnet sign-with-keychain send"

[ "$RUN" = 1 ] || exit 0

printf 'type yes to send %s as %s: ' "$METHOD" "$OWNER" >&2
LINE=""
IFS= read -r LINE || true
if [ "$LINE" != "yes" ]; then
  echo "aborted"
  exit 1
fi
OUT="$("$NEAR" contract call-function as-transaction "$POLICY" "$METHOD" json-args "$ARGS" prepaid-gas "$GAS" attached-deposit '1 yoctoNEAR' sign-as "$OWNER" network-config testnet sign-with-keychain send 2>&1)"
rc=$?
printf '%s\n' "$OUT" | grep -E 'Transaction ID' || true
if [ "$rc" -ne 0 ]; then
  echo "near exited $rc" >&2
  exit 1
fi
