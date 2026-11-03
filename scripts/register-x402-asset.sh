#!/usr/bin/env bash
# AIR-109: register the Base Sepolia test USDC asset (EIP-3009 signing) and its x402 payee in the policy contract.
#   scripts/register-x402-asset.sh [--check]
# --check is read only (one eth_call, no transaction): it compares the stored domain separator of fixtures/x402-asset.json with the
# token's own DOMAIN_SEPARATOR() and prints the MPC-derived address of the asset's path (`DERIVED 0x...`; fund that address with test USDC).
# Without --check: asset_set (eip712 { domain_separator, from: <derived address> }) and book_add of the erc20 payee key, both as the owner
# with 1 yocto, then a get_asset read back.
# The policy account is `policy` of fixtures/x402-asset.json when present (a fresh account runs this ticket's wasm, AIR-048 redeploy rule),
# else `policy` of fixtures/accounts.testnet.json. Signing goes through the near CLI keychain (sign-with-keychain); no key is read here.
# Test hooks: NEAR, BASE_RPC, AIRLOCK_ACCOUNTS_FILE, AIRLOCK_X402_FILE.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NEAR="${NEAR:-near}"
BASE_RPC="${BASE_RPC:-https://sepolia.base.org}"
ACCOUNTS="${AIRLOCK_ACCOUNTS_FILE:-$ROOT/fixtures/accounts.testnet.json}"
FIXTURE="${AIRLOCK_X402_FILE:-$ROOT/fixtures/x402-asset.json}"

CHECK=0
for a in "$@"; do
  case "$a" in
    --check) CHECK=1 ;;
    *) echo "usage: scripts/register-x402-asset.sh [--check]" >&2; exit 2 ;;
  esac
done

die() { echo "$1" >&2; exit 1; }
need() { command -v "$1" > /dev/null || die "FAILED: $1 not found"; }
need jq
need curl
need node

[ -f "$ACCOUNTS" ] || { echo "REFUSED: $ACCOUNTS is missing" >&2; exit 2; }
[ -f "$FIXTURE" ] || { echo "REFUSED: $FIXTURE is missing" >&2; exit 2; }
OWNER="$(jq -r '.owner // empty' "$ACCOUNTS")"
POLICY="$(jq -r '.policy // empty' "$FIXTURE")"
[ -n "$POLICY" ] || POLICY="$(jq -r '.policy // empty' "$ACCOUNTS")"
[ -n "$OWNER" ] && [ -n "$POLICY" ] || { echo "REFUSED: owner or policy missing" >&2; exit 2; }

fx() { jq -r --arg k "$1" '.[$k] | if . == null then "null" else tostring end' "$FIXTURE"; }
CHAIN_ID="$(fx chain_id)"
TOKEN="$(fx token)"
PATH_ID="$(fx path)"
SEPARATOR="$(fx domain_separator)"
PAYEE="$(fx payee)"
ASSET="evm:$CHAIN_ID:erc20:$TOKEN"
KEY="erc20:$CHAIN_ID:$TOKEN:$PAYEE"

# 1. the token's own domain separator (selector 0x3644e515 is DOMAIN_SEPARATOR())
RESP="$(curl -s --max-time 30 -X POST -H 'content-type: application/json' "$BASE_RPC" \
  -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_call\",\"params\":[{\"to\":\"$TOKEN\",\"data\":\"0x3644e515\"},\"latest\"]}")" \
  || die "FAILED: eth_call to $BASE_RPC"
GOT="$(printf '%s' "$RESP" | jq -r '.result // empty' | tr 'A-F' 'a-f')"
case "$GOT" in
  0x????????????????????????????????????????????????????????????????) ;;
  *) die "FAILED: DOMAIN_SEPARATOR() of $TOKEN gave '$(printf '%s' "$RESP" | head -c 200)'" ;;
esac
if [ "${GOT#0x}" != "$SEPARATOR" ]; then
  echo "DRIFT domain separator expected $SEPARATOR got ${GOT#0x}"
  exit 1
fi
echo "DOMAIN SEPARATOR MATCHES token 0x$SEPARATOR"

# 2. the MPC-derived address of the path (offline key derivation)
DERIVED="$(node "$ROOT/scripts/derive-address.mjs" "$POLICY" "$PATH_ID")" || die "FAILED: derive-address.mjs"
case "$DERIVED" in
  0x????????????????????????????????????????) ;;
  *) die "FAILED: derived address '$DERIVED' is not 0x plus 40 hex digits" ;;
esac
echo "DERIVED $DERIVED"
[ "$CHECK" = "1" ] && exit 0

# 3. register, as the owner, 1 yocto each
command -v "$NEAR" > /dev/null || die "FAILED: near CLI not found"
clean() { sed $'s/\x1b\\[[0-9;]*m//g'; }
owner_tx() {   # owner_tx <method> <json args>
  local out rc hash
  out="$("$NEAR" contract call-function as-transaction "$POLICY" "$1" json-args "$2" prepaid-gas '100 Tgas' attached-deposit '1 yoctoNEAR' sign-as "$OWNER" network-config testnet sign-with-keychain send 2>&1)"
  rc=$?
  out="$(printf '%s\n' "$out" | clean)"
  hash="$(printf '%s\n' "$out" | grep -oE 'Transaction ID: *[A-Za-z0-9]+' | head -1 | sed 's/.*: *//')"
  if [ "$rc" -ne 0 ] || [ -z "$hash" ] || printf '%s\n' "$out" | grep -qE 'ExecutionError|Failure'; then
    printf '%s\n' "$out" | tail -8 >&2
    die "FAILED: $1 (near exit $rc, transaction id '${hash:-none}')"
  fi
  echo "TX $1 $hash"
}

FROM="$(printf '%s' "$DERIVED" | tr 'A-F' 'a-f')"
ENTRY="$(jq -c --arg sep "$SEPARATOR" --arg from "$FROM" '{
  symbol, decimals, hard_cap, daily_cap, max_fee_per_gas: "0", max_gas: "0", quick_task_cap, path,
  eip712: { domain_separator: $sep, from: $from } }' "$FIXTURE")"
owner_tx asset_set "$(jq -nc --arg a "$ASSET" --argjson e "$ENTRY" '{asset:$a,entry:$e}')"
owner_tx book_add "$(jq -c --arg k "$KEY" '{key: $k, cap: null, daily_untrusted_budget: "0", daily_limit: .payee_daily_limit, label: .payee_label}' "$FIXTURE")"

# 4. read back
GOT_ASSET="$("$NEAR" contract call-function as-read-only "$POLICY" get_asset json-args "$(jq -nc --arg a "$ASSET" '{asset:$a}')" network-config testnet now 2> /dev/null)" \
  || die "FAILED: get_asset read back"
[ "$(printf '%s' "$GOT_ASSET" | jq -r '.eip712.from // empty')" = "$FROM" ] || die "FAILED: stored eip712.from differs from $FROM"
[ "$(printf '%s' "$GOT_ASSET" | jq -r '.eip712.domain_separator // empty')" = "$SEPARATOR" ] || die "FAILED: stored domain separator differs from the fixture"
echo "ASSET REGISTERED $ASSET from=$FROM"
