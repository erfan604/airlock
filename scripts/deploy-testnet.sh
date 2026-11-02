#!/usr/bin/env bash
# AIR-048: build the policy contract, deploy it to the policy account on NEAR testnet, check that the on-chain code hash equals
# the sha256 of the local wasm, and (with --record) append a row to docs/EVIDENCE.md.
#   scripts/deploy-testnet.sh [--dry-run] [--record]
# --dry-run builds and prints the plan (account, wasm sha256, required balance) and sends nothing.
# Signing goes through near CLI's own keychain option (sign-with-keychain); this script never reads a key or a credentials file.
# Test hooks (scripts/test-deploy.sh): AIRLOCK_NETWORK, AIRLOCK_ACCOUNTS_FILE, AIRLOCK_EVIDENCE, AIRLOCK_RES_DIR,
# AIRLOCK_SKIP_BUILD=1 with AIRLOCK_WASM_SRC=<wasm>.
set -eo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DRY=0
RECORD=0
for a in "$@"; do
  case "$a" in
    --dry-run) DRY=1 ;;
    --record) RECORD=1 ;;
    *) echo "usage: scripts/deploy-testnet.sh [--dry-run] [--record]"; exit 2 ;;
  esac
done

NETWORK="${AIRLOCK_NETWORK:-testnet}"
ACCOUNTS="${AIRLOCK_ACCOUNTS_FILE:-$ROOT/fixtures/accounts.testnet.json}"
EVIDENCE="${AIRLOCK_EVIDENCE:-$ROOT/docs/EVIDENCE.md}"
RES_DIR="${AIRLOCK_RES_DIR:-$ROOT/contracts/airlock-policy/res}"
MPC_CONTRACT="v1.signer-prod.testnet"
# regular testnet RPC order of plan/STACK.md section RPC (read only calls here)
RPCS="https://test.rpc.fastnear.com https://near-testnet.drpc.org https://testnet-rpc.intea.rs https://rpc.testnet.near.org"

die() { echo "$1"; exit 1; }

[ "$NETWORK" = "testnet" ] || die "REFUSED: network is '$NETWORK'; this script deploys to testnet only"
[ -f "$ACCOUNTS" ] || die "REFUSED: $ACCOUNTS is missing"
OWNER="$(jq -r '.owner // empty' "$ACCOUNTS")"
POLICY="$(jq -r '.policy // empty' "$ACCOUNTS")"
[ -n "$OWNER" ] && [ -n "$POLICY" ] || die "REFUSED: owner or policy missing in $ACCOUNTS"
case "$OWNER" in *.testnet) ;; *) die "REFUSED: owner '$OWNER' is not a .testnet account" ;; esac
case "$POLICY" in *.testnet) ;; *) die "REFUSED: policy '$POLICY' is not a .testnet account" ;; esac

# 1. build (a dry run builds too: the plan needs the real wasm hash)
if [ "${AIRLOCK_SKIP_BUILD:-0}" = "1" ]; then
  SRC="${AIRLOCK_WASM_SRC:?AIRLOCK_SKIP_BUILD needs AIRLOCK_WASM_SRC}"
else
  . "$ROOT/scripts/env.sh"
  (cd "$ROOT/contracts/airlock-policy" && cargo near build non-reproducible-wasm --no-abi)
  SRC="${CARGO_TARGET_DIR:-target}/near/airlock_policy.wasm"
fi
[ -s "$SRC" ] || die "FAILED: built wasm not found at $SRC"
mkdir -p "$RES_DIR"
cp "$SRC" "$RES_DIR/airlock_policy.wasm"
WASM="$RES_DIR/airlock_policy.wasm"
WASM_BYTES="$(wc -c < "$WASM" | tr -d ' ')"
WASM_SHA="$(shasum -a 256 "$WASM" | cut -d' ' -f1)"
echo "wasm: $WASM ($WASM_BYTES bytes)"
echo "wasm sha256 (hex): $WASM_SHA"
if [ "$WASM_BYTES" -gt 900000 ]; then echo "NOTE wasm is over 900 KB; say so in docs/EVIDENCE.md"; fi

# 2. helpers
b58_of_hex() {
  python3 -I - "$1" <<'PY'
import sys
A = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
raw = bytes.fromhex(sys.argv[1])
n = int.from_bytes(raw, "big")
out = ""
while n:
    n, r = divmod(n, 58)
    out = A[r] + out
print("1" * (len(raw) - len(raw.lstrip(b"\0"))) + out)
PY
}
hex_of_b58() {
  python3 -I - "$1" <<'PY'
import sys
A = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
s = sys.argv[1]
n = 0
for c in s:
    n = n * 58 + A.index(c)
body = n.to_bytes((n.bit_length() + 7) // 8, "big")
print(("\0" * (len(s) - len(s.lstrip("1"))) ).encode().hex() + body.hex())
PY
}
view_account() {   # view_account <account>: prints the first RPC answer that has a result or an error, else nothing
  local body r rpc
  body="{\"jsonrpc\":\"2.0\",\"id\":\"airlock\",\"method\":\"query\",\"params\":{\"request_type\":\"view_account\",\"finality\":\"final\",\"account_id\":\"$1\"}}"
  for rpc in $RPCS; do
    r="$(curl -s --max-time 20 -X POST -H 'content-type: application/json' -d "$body" "$rpc" || true)"
    if printf '%s' "$r" | jq -e '.result or .error' > /dev/null 2>&1; then printf '%s' "$r"; return 0; fi
  done
  return 1
}

# 3. balance check: storage for the wasm (1e19 yocto per byte) plus 1 NEAR margin
ACC_JSON="$(view_account "$POLICY")" || die "FAILED: no testnet RPC answered for $POLICY"
HAVE_YOCTO="$(printf '%s' "$ACC_JSON" | jq -r '.result.amount // "0"')"
ONCHAIN_BEFORE="$(printf '%s' "$ACC_JSON" | jq -r '.result.code_hash // "none"')"
CALC="$(python3 -I - "$WASM_BYTES" "$HAVE_YOCTO" <<'PY'
import sys
from decimal import Decimal, getcontext
getcontext().prec = 50
size, have = int(sys.argv[1]), int(sys.argv[2])
need = size * 10**19 + 10**24
short = max(0, need - have)
f = lambda y: format(Decimal(y) / Decimal(10**24), ".4f")
print(need, short, f(need), f(have), f(short))
PY
)"
set -- $CALC
NEED_YOCTO="$1"; SHORT_YOCTO="$2"; NEED_NEAR="$3"; HAVE_NEAR="$4"; SHORT_NEAR="$5"

INIT_JSON="{\"requires_tee\":false,\"attestation_expiration_time_ms\":\"86400000\",\"owner_id\":\"$OWNER\",\"mpc_contract_id\":\"$MPC_CONTRACT\"}"
echo "init call: new $INIT_JSON"
echo "on-chain code hash before: $ONCHAIN_BEFORE"
echo "Redeploy rule: a redeploy without init keeps state, which is only safe when the state layout did not change;"
echo "because migrate does not exist, a layout change needs a fresh account (for example policy-v2.$OWNER)."
if [ "$ONCHAIN_BEFORE" != "none" ] && [ "$ONCHAIN_BEFORE" != "11111111111111111111111111111111" ]; then
  echo "NOTE $POLICY already has code; deploying with the init call will fail unless the account is fresh"
fi
if [ "$SHORT_YOCTO" != "0" ]; then
  echo "SHORTFALL $SHORT_NEAR NEAR: send at least this much to $POLICY before the deploy"
fi
if [ "$DRY" = "1" ]; then
  echo "DRY RUN: nothing signed, nothing sent"
  echo "planned account: $POLICY"
  echo "wasm sha256: $WASM_SHA"
  echo "required balance: $NEED_NEAR NEAR (have $HAVE_NEAR NEAR)"
  exit 0
fi
[ "$SHORT_YOCTO" = "0" ] || die "FAILED: balance of $POLICY ($HAVE_NEAR NEAR) is below the required $NEED_NEAR NEAR"

# 4. deploy with the init call; near CLI signs with its own keychain
command -v near > /dev/null || die "FAILED: near CLI not found"
DOUT="$(near contract deploy "$POLICY" use-file "$WASM" with-init-call new json-args "$INIT_JSON" prepaid-gas '100.0 Tgas' attached-deposit '0 NEAR' network-config testnet sign-with-keychain send 2>&1)" || { printf '%s\n' "$DOUT"; die "FAILED: near contract deploy"; }
printf '%s\n' "$DOUT"
TX="$(printf '%s\n' "$DOUT" | sed 's/\x1b\[[0-9;]*m//g' | grep -oE 'Transaction ID: *[A-Za-z0-9]+' | head -1 | sed 's/.*: *//')"
if [ -z "$TX" ]; then TX="unknown"; echo "WARNING no transaction id found in the near output"; fi

# 5. verify the on-chain code hash equals the local sha256
AFTER_JSON="$(view_account "$POLICY")" || die "FAILED: no testnet RPC answered after the deploy"
ONCHAIN="$(printf '%s' "$AFTER_JSON" | jq -r '.result.code_hash // "none"')"
LOCAL_B58="$(b58_of_hex "$WASM_SHA")"
ONCHAIN_HEX="$(hex_of_b58 "$ONCHAIN" 2> /dev/null || echo none)"
echo "local code hash:    base58 $LOCAL_B58  hex $WASM_SHA"
echo "on-chain code hash: base58 $ONCHAIN  hex $ONCHAIN_HEX"
[ "$ONCHAIN" = "$LOCAL_B58" ] || die "MISMATCH: on-chain code hash $ONCHAIN differs from local $LOCAL_B58; nothing recorded"

# 6. access keys of the policy account (audit map: a full-access key can redeploy or call sign directly)
KEYS_OUT="$(near account list-keys "$POLICY" network-config testnet now 2>&1 || true)"
FULL_KEYS="$(printf '%s\n' "$KEYS_OUT" | grep -c 'full access' || true)"
if [ "$FULL_KEYS" -ge 1 ]; then
  KEY_WORD="keys"; [ "$FULL_KEYS" = "1" ] && KEY_WORD="key"
  echo "WARNING policy account has $FULL_KEYS full-access $KEY_WORD: its holder can redeploy the contract or call sign directly"
fi

# 7. record
if [ "$RECORD" = "1" ]; then
  COMMIT="$(git -C "$ROOT" rev-parse --short HEAD 2> /dev/null || echo unknown)"
  SIZE_NOTE=""; if [ "$WASM_BYTES" -gt 900000 ]; then SIZE_NOTE=", wasm is over 900 KB ($WASM_BYTES bytes)"; fi
  ROW="| Policy contract deploy | NEAR testnet | account \`$POLICY\`, code_hash=$ONCHAIN (hex $ONCHAIN_HEX), wasm_sha256=$WASM_SHA (the on-chain code hash equals the sha256 of the committed res/airlock_policy.wasm), tx [$TX](https://testnet.nearblocks.io/txns/$TX), full_access_keys=$FULL_KEYS, commit $COMMIT$SIZE_NOTE | $(date +%Y-%m-%d) |"
  TMP="$(mktemp)"
  awk -v row="$ROW" '
    { lines[NR] = $0 }
    END {
      last = 0
      for (i = 1; i <= NR; i++) {
        if (lines[i] ~ /^\|/) { last = i } else if (last > 0) { break }
      }
      if (last == 0) { for (i = 1; i <= NR; i++) print lines[i]; print row; exit }
      for (i = 1; i <= NR; i++) { print lines[i]; if (i == last) print row }
    }' "$EVIDENCE" > "$TMP"
  cat "$TMP" > "$EVIDENCE"
  rm -f "$TMP"
  echo "recorded a row in $EVIDENCE"
fi
echo "DEPLOYED $POLICY code_hash=$ONCHAIN matches local sha256"
