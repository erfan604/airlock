#!/usr/bin/env bash
# AIR-048: offline tests of scripts/deploy-testnet.sh. No network, no keys, no signing.
# A scratch bin dir holds a fake `near` (records its arguments, answers list-keys) and a fake `curl` (answers the RPC view_account
# query), and goes first on PATH. The wasm build is skipped (AIRLOCK_SKIP_BUILD=1) and a small fake wasm is used.
# Cases: init_call_json, testnet_only_guard, shortfall, records_access_keys, hash_mismatch.
# Last line: DEPLOY TESTS OK (5 cases)
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY="$here/deploy-testnet.sh"
ACCTS="$here/../fixtures/accounts.testnet.json"
fail() { echo "FAIL $1: $2"; exit 1; }
[ -f "$DEPLOY" ] || fail setup "scripts/deploy-testnet.sh is missing"
[ -f "$ACCTS" ] || fail setup "fixtures/accounts.testnet.json is missing"

T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT
mkdir -p "$T/bin" "$T/res"
printf 'fake wasm bytes for the deploy test\n' > "$T/in.wasm"
WASM_SHA="$(shasum -a 256 "$T/in.wasm" | cut -d' ' -f1)"
WASM_BYTES="$(wc -c < "$T/in.wasm" | tr -d ' ')"
# base58 of the sha256, the way the chain prints a code hash
WASM_B58="$(python3 -I - "$WASM_SHA" <<'PY'
import sys
A = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
n = int(sys.argv[1], 16)
out = ""
while n:
    n, r = divmod(n, 58)
    out = A[r] + out
print(out)
PY
)"

# fake near: records "near <args>" in $T/near.log; list-keys answers from $FAKE_KEYS_FILE; deploy prints a transaction id
cat > "$T/bin/near" <<'EOF'
#!/usr/bin/env bash
echo "near $*" >> "$FAKE_LOG"
case "$*" in
  *"account list-keys"*) cat "$FAKE_KEYS_FILE" ;;
  *"contract deploy"*) echo "Transaction ID: FAKETXHASH1111"; echo "Here is your console command if you need to script it" ;;
esac
exit 0
EOF
# fake curl: answers any RPC POST with a view_account result built from $FAKE_AMOUNT and $FAKE_CODE_HASH
cat > "$T/bin/curl" <<'EOF'
#!/usr/bin/env bash
echo "curl $*" >> "$FAKE_LOG"
printf '{"jsonrpc":"2.0","id":"x","result":{"amount":"%s","locked":"0","code_hash":"%s","storage_usage":182}}\n' "$FAKE_AMOUNT" "$FAKE_CODE_HASH"
EOF
chmod +x "$T/bin/near" "$T/bin/curl"

cat > "$T/keys_one_full.txt" <<'EOF'
+---+------------------------------------------------------+-----------------+--------------------------+
| # | Public Key                                           | Nonce           | Permissions              |
+---+------------------------------------------------------+-----------------+--------------------------+
| 1 | ed25519:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA | 1               | full access              |
| 2 | ed25519:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB | 2               | only `submit_batch` call |
+---+------------------------------------------------------+-----------------+--------------------------+
EOF

export FAKE_LOG="$T/near.log" FAKE_KEYS_FILE="$T/keys_one_full.txt"
export AIRLOCK_SKIP_BUILD=1 AIRLOCK_WASM_SRC="$T/in.wasm" AIRLOCK_RES_DIR="$T/res"
export AIRLOCK_EVIDENCE="$T/EVIDENCE.md"
export AIRLOCK_ACCOUNTS_FILE="$ACCTS"
RICH="1000000000000000000000000000"   # 1000 NEAR in yocto
run() {   # run <args...>: sets OUT and RC; the fake bin dir is first on PATH
  : > "$FAKE_LOG"
  set +e; OUT="$(PATH="$T/bin:$PATH" "$DEPLOY" "$@" 2>&1)"; RC=$?; set -e
}
reset_evidence() {
  printf '# Evidence log\n\n| What | Network | Id / hash / link | Date |\n| --- | --- | --- | --- |\n| Existing row | local | x | 2026-11-01 |\n\n## Model choice\n\ntext\n' > "$AIRLOCK_EVIDENCE"
}

# case 1: init_call_json. --dry-run prints the plan, copies the wasm, signs nothing, sends nothing.
export FAKE_AMOUNT="$RICH" FAKE_CODE_HASH="11111111111111111111111111111111"
run --dry-run
[ "$RC" -eq 0 ] || fail init_call_json "dry run exit $RC: $OUT"
printf '%s\n' "$OUT" | grep -q -F '"requires_tee":false' || fail init_call_json "no requires_tee=false in the init args"
printf '%s\n' "$OUT" | grep -q -F '"attestation_expiration_time_ms":"86400000"' || fail init_call_json "no attestation_expiration_time_ms"
printf '%s\n' "$OUT" | grep -q -F '"owner_id":"erfan-airlock.testnet"' || fail init_call_json "no owner_id"
printf '%s\n' "$OUT" | grep -q -F '"mpc_contract_id":"v1.signer-prod.testnet"' || fail init_call_json "no mpc_contract_id"
printf '%s\n' "$OUT" | grep -q -F "wasm sha256: $WASM_SHA" || fail init_call_json "no wasm sha256 line"
printf '%s\n' "$OUT" | grep -q -F "planned account: policy.erfan-airlock.testnet" || fail init_call_json "no planned account line"
printf '%s\n' "$OUT" | grep -q -F "required balance:" || fail init_call_json "no required balance line"
printf '%s\n' "$OUT" | grep -q -F "a layout change needs a fresh account" || fail init_call_json "no redeploy rule"
! grep -q -F "contract deploy" "$FAKE_LOG" || fail init_call_json "dry run called near contract deploy"
cmp -s "$T/in.wasm" "$T/res/airlock_policy.wasm" || fail init_call_json "wasm not copied to the res dir"

# the real deploy path passes the init call and the keychain signer to near
reset_evidence
export FAKE_CODE_HASH="$WASM_B58"
run
[ "$RC" -eq 0 ] || fail init_call_json "deploy exit $RC: $OUT"
grep -q -F "contract deploy policy.erfan-airlock.testnet use-file $T/res/airlock_policy.wasm with-init-call new json-args" "$FAKE_LOG" || fail init_call_json "deploy args: $(grep deploy "$FAKE_LOG")"
grep -q -F '{"requires_tee":false,"attestation_expiration_time_ms":"86400000","owner_id":"erfan-airlock.testnet","mpc_contract_id":"v1.signer-prod.testnet"}' "$FAKE_LOG" || fail init_call_json "init json differs"
grep -q -F "network-config testnet sign-with-keychain send" "$FAKE_LOG" || fail init_call_json "not signed with the keychain on testnet"
[ "$(printf '%s\n' "$OUT" | tail -1)" = "DEPLOYED policy.erfan-airlock.testnet code_hash=$WASM_B58 matches local sha256" ] || fail init_call_json "last line: $(printf '%s\n' "$OUT" | tail -1)"
! grep -q -F "$WASM_SHA" "$AIRLOCK_EVIDENCE" || fail init_call_json "EVIDENCE written without --record"

# case 2: testnet_only_guard
export FAKE_AMOUNT="$RICH"
set +e; OUT="$(AIRLOCK_NETWORK=mainnet PATH="$T/bin:$PATH" "$DEPLOY" --dry-run 2>&1)"; RC=$?; set -e
[ "$RC" -ne 0 ] || fail testnet_only_guard "network=mainnet exited 0"
printf '%s\n' "$OUT" | grep -q -F "REFUSED" || fail testnet_only_guard "no REFUSED line: $OUT"
printf '%s' '{"owner":"a.near","policy":"policy.a.near"}' > "$T/mainnet-accounts.json"
set +e; OUT="$(AIRLOCK_ACCOUNTS_FILE="$T/mainnet-accounts.json" PATH="$T/bin:$PATH" "$DEPLOY" --dry-run 2>&1)"; RC=$?; set -e
[ "$RC" -ne 0 ] || fail testnet_only_guard "a .near policy account exited 0"
printf '%s\n' "$OUT" | grep -q -F "REFUSED" || fail testnet_only_guard "no REFUSED line for a .near account: $OUT"

# case 3: shortfall. The fake balance is 1 NEAR, far below the wasm storage cost plus 1 NEAR.
export FAKE_AMOUNT="1000000000000000000000000"
run --dry-run
printf '%s\n' "$OUT" | grep -q -F "SHORTFALL" || fail shortfall "no SHORTFALL line: $OUT"
printf '%s\n' "$OUT" | grep -q -E "SHORTFALL [0-9]+\.[0-9]+ NEAR" || fail shortfall "no amount in the SHORTFALL line: $OUT"
run
[ "$RC" -ne 0 ] || fail shortfall "a real deploy with too little balance exited 0"
! grep -q -F "contract deploy" "$FAKE_LOG" || fail shortfall "deployed with too little balance"

# case 4: records_access_keys (AUDIT_MAP). One full-access key and one function-call key.
export FAKE_AMOUNT="$RICH" FAKE_CODE_HASH="$WASM_B58"
reset_evidence
run --record
[ "$RC" -eq 0 ] || fail records_access_keys "exit $RC: $OUT"
printf '%s\n' "$OUT" | grep -q -F "WARNING policy account has 1 full-access key: its holder can redeploy the contract or call sign directly" || fail records_access_keys "no warning: $OUT"
grep -q -F "full_access_keys=1" "$AIRLOCK_EVIDENCE" || fail records_access_keys "no full_access_keys=1 in EVIDENCE"
grep -q -F "$WASM_SHA" "$AIRLOCK_EVIDENCE" || fail records_access_keys "no wasm sha256 in EVIDENCE"
grep -q -F "code_hash=$WASM_B58" "$AIRLOCK_EVIDENCE" || fail records_access_keys "no code hash in EVIDENCE"
grep -q -F "FAKETXHASH1111" "$AIRLOCK_EVIDENCE" || fail records_access_keys "no tx hash in EVIDENCE"
# the row lands inside the first table, before the next section
row="$(grep -n -F "full_access_keys=1" "$AIRLOCK_EVIDENCE" | cut -d: -f1)"
sec="$(grep -n -F "## Model choice" "$AIRLOCK_EVIDENCE" | cut -d: -f1)"
[ -n "$row" ] && [ -n "$sec" ] && [ "$row" -lt "$sec" ] || fail records_access_keys "row at line '$row' is not above the section at '$sec'"
[ "$(sed -n "$((row - 1))p" "$AIRLOCK_EVIDENCE" | cut -c1)" = "|" ] || fail records_access_keys "row is not directly under a table row"

# case 5: hash_mismatch. A different on-chain hash is a failure and records nothing.
export FAKE_CODE_HASH="22222222222222222222222222222222"
reset_evidence
run --record
[ "$RC" -ne 0 ] || fail hash_mismatch "a mismatched hash exited 0"
printf '%s\n' "$OUT" | grep -q -F "MISMATCH" || fail hash_mismatch "no MISMATCH line: $OUT"
! grep -q -F "full_access_keys" "$AIRLOCK_EVIDENCE" || fail hash_mismatch "recorded a row for a mismatched hash"

echo "DEPLOY TESTS OK (5 cases)"
