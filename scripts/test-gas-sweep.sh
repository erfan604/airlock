#!/usr/bin/env bash
# AIR-107: offline tests of scripts/gas-sweep-approve.sh with a fake near CLI, a fake RPC (curl), a fake approve-cli and a fake pnpm.
# No key, no network, no transaction. Last line: `GAS SWEEP OK` or `GAS SWEEP FAILED`.
set -uo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SWEEP="$here/gas-sweep-approve.sh"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
fail=0
ok() { echo "ok   $1"; }
bad() { echo "FAIL $1"; fail=1; }

# fake approve-cli: prints a card with the args line, exits with FAKE_CARD_RC
cat > "$work/approve-cli.sh" << 'EOF'
#!/usr/bin/env bash
echo "APPROVE CARD pending id $1"
echo "to       evm:84532:0xd8da6bf26964af9d7eed9e03e53415d37aa96045"
echo 'args     {"id":"7","to":"evm:84532:0xd8da6bf26964af9d7eed9e03e53415d37aa96045","asset":"ETH.base","amount":"0.01","why":"UntrustedAmount","book":"in_book"}'
exit "${FAKE_CARD_RC:-0}"
EOF

# fake near: one line per call in $work/near.log (the prepaid gas), prints a transaction id that encodes the gas: tx<gas>
cat > "$work/near" << 'EOF'
#!/usr/bin/env bash
gas=""
prev=""
for a in "$@"; do
  if [ "$prev" = "prepaid-gas" ]; then gas="${a%% *}"; fi
  prev="$a"
done
echo "$*" >> "$FAKE_DIR/near.log"
if [ "${FAKE_NO_TXID:-0}" = 1 ]; then echo "error: no network"; exit 1; fi
# base58 has no 0, so the digits of the gas are written as letters: 0 to 9 become a b c d e f g h j k
echo "Transaction ID: Tx$(printf '%s' "$gas" | tr '0123456789' 'abcdefghjk')Z"
EOF

# fake curl: the answer depends on the hash in the request body: success when the gas in the hash is at least FAKE_MIN
cat > "$work/curl" << 'EOF'
#!/usr/bin/env bash
body=""
prev=""
for a in "$@"; do
  if [ "$prev" = "-d" ]; then body="$a"; fi
  prev="$a"
done
echo "$body" >> "$FAKE_DIR/curl.log"
gas="$(printf '%s' "$body" | grep -oE 'Tx[a-hjk]+Z' | head -1 | tr -d 'TxZ' | tr 'abcdefghjk' '0123456789')"
if [ "${FAKE_PENDING:-0}" = 1 ]; then echo '{"jsonrpc":"2.0","id":1,"result":{"status":"Started"}}'; exit 0; fi
if [ "$gas" -ge "$FAKE_MIN" ]; then
  echo '{"jsonrpc":"2.0","id":1,"result":{"status":{"SuccessValue":""}}}'
else
  echo '{"jsonrpc":"2.0","id":1,"result":{"status":{"Failure":{"ActionError":{}}}}}'
fi
EOF

cat > "$work/pnpm" << 'EOF'
#!/usr/bin/env bash
echo "PNPM $*" >> "$FAKE_DIR/pnpm.log"
EOF
chmod +x "$work/approve-cli.sh" "$work/near" "$work/curl" "$work/pnpm"

run() { # <stdin> <env assignments...>: runs the sweep, output in $work/out, exit code in $work/rc
  local input="$1"
  shift
  rm -f "$work/near.log" "$work/curl.log" "$work/pnpm.log"
  printf '%s\n' "$input" | env FAKE_DIR="$work" NEAR="$work/near" CURL="$work/curl" PNPM="$work/pnpm" APPROVE_CLI="$work/approve-cli.sh" \
    OWNER=owner.test POLICY=policy.test SWEEP_POLL_TRIES=2 SWEEP_POLL_SECS=0 "$@" "$SWEEP" 7 > "$work/out" 2> "$work/err"
  echo $? > "$work/rc"
}

# 1. first success at 50 Tgas: five lines, the minimum, 65 with ceil(1.3 * 50), the follow-up commands
run yes FAKE_MIN=50
[ "$(cat "$work/rc")" = 0 ] && ok "exit 0 on a success" || bad "exit code $(cat "$work/rc")"
for n in 30 40; do grep -qx "SWEEP $n Tgas failed" "$work/out" && ok "SWEEP $n failed" || bad "SWEEP $n failed missing"; done
grep -qx 'SWEEP 50 Tgas success' "$work/out" && ok "SWEEP 50 success" || bad "SWEEP 50 success missing"
! grep -q 'SWEEP 60' "$work/out" && ok "stops at the first success" || bad "went past the first success"
grep -qx 'APPROVE_MIN_TGAS=50 testnet' "$work/out" && ok "minimum line" || bad "minimum line missing"
grep -qx 'APPROVE_PREPAID_TGAS_TESTNET=65' "$work/out" && ok "65 for a minimum of 50" || bad "wrong prepaid value"
[ "$(wc -l < "$work/near.log" | tr -d ' ')" = 3 ] && ok "three transactions sent" || bad "wrong number of transactions"
grep -q 'prepaid-gas 30 Tgas attached-deposit 1 yoctoNEAR sign-as owner.test network-config testnet sign-with-keychain send' "$work/near.log" && ok "command shape" || bad "command shape"
grep -q 'policy.test approve json-args {"id":"7"' "$work/near.log" && ok "args come from the card" || bad "args not from the card"
grep -qx 'PNPM tsx scripts/gas-testnet.ts approve_evm TxfaZ' "$work/pnpm.log" && ok "gas row for the successful hash" || bad "gas-testnet call"
grep -qx 'PNPM tsx scripts/mpc-smoke.ts --resync-nonce' "$work/pnpm.log" && ok "nonce resync" || bad "resync call"

# 2. the rounding: 30 -> 39, 70 -> 91, 150 -> 195 (integer ceil of 1.3 n)
for pair in "30 39" "70 91" "150 195"; do
  set -- $pair
  run yes FAKE_MIN="$1"
  grep -qx "APPROVE_PREPAID_TGAS_TESTNET=$2" "$work/out" && ok "ceil(1.3 * $1) = $2" || bad "ceil(1.3 * $1) is not $2"
done

# 3. no success up to 150
run yes FAKE_MIN=999
[ "$(cat "$work/rc")" = 1 ] && ok "exit 1 without a success" || bad "exit code without a success"
grep -qx 'NO SUCCESS UP TO 150 TGAS' "$work/out" && ok "no success line" || bad "no success line missing"
[ "$(wc -l < "$work/near.log" | tr -d ' ')" = 13 ] && ok "thirteen steps 30 to 150" || bad "wrong number of steps"
! grep -q 'APPROVE_MIN_TGAS' "$work/out" && ok "no minimum printed" || bad "minimum printed without a success"
[ ! -e "$work/pnpm.log" ] && ok "no follow-up without a success" || bad "follow-up ran without a success"

# 4. anything but exactly yes sends nothing
for answer in "" "y" "Yes" "yes " "no"; do
  run "$answer" FAKE_MIN=30
  if [ "$(cat "$work/rc")" = 1 ] && [ ! -e "$work/near.log" ] && grep -qx aborted "$work/out"; then ok "aborted on '$answer'"; else bad "sent something on '$answer'"; fi
done

# 5. a card that cannot be read stops before the question
run yes FAKE_MIN=30 FAKE_CARD_RC=1
[ "$(cat "$work/rc")" = 1 ] && [ ! -e "$work/near.log" ] && ok "card failure sends nothing" || bad "card failure"

# 6. no transaction id, a status that never becomes final, a bad id
run yes FAKE_MIN=30 FAKE_NO_TXID=1
[ "$(cat "$work/rc")" = 1 ] && ! grep -q SWEEP "$work/out" && ok "no transaction id stops" || bad "no transaction id"
run yes FAKE_MIN=30 FAKE_PENDING=1
[ "$(cat "$work/rc")" = 1 ] && ! grep -q 'SWEEP 30 Tgas' "$work/out" && ok "a status that never finalizes stops" || bad "pending status"
"$SWEEP" 0 < /dev/null > /dev/null 2>&1
[ "$?" = 2 ] && ok "id 0 is a usage error" || bad "id 0"
"$SWEEP" < /dev/null > /dev/null 2>&1
[ "$?" = 2 ] && ok "no id is a usage error" || bad "no id"

if [ "$fail" = 0 ]; then echo "GAS SWEEP OK"; else echo "GAS SWEEP FAILED"; exit 1; fi
