#!/usr/bin/env bash
# AIR-049: offline tests of scripts/bootstrap-policy.sh, scripts/storage-budget.sh and scripts/task-key.mjs.
# A scratch bin dir holds a fake `near` and a fake `curl` and goes first on PATH. No network, no keys, no signing.
# The fake near logs one line per call, arguments joined by `|`, in $FAKE_LOG, and mirrors the two call shapes the script may use:
#   contract call-function as-read-only CONTRACT METHOD json-args ARGS network-config testnet now
#   contract call-function as-transaction CONTRACT METHOD json-args ARGS prepaid-gas G attached-deposit D sign-as SIGNER
#       network-config testnet sign-with-keychain send
# A read prints $FAKE_STATE/<method>.<first json arg value, non-alphanumerics as _>.json, else $FAKE_STATE/<method>.json.
# A transaction prints `Transaction ID: FAKE<n>` and exits 0. The fake curl answers eth_getTransactionCount ($FAKE_CHAIN_NONCE)
# and view_account ($FAKE_AMOUNT, $FAKE_USAGE; its `locked` field is deliberately wrong).
# AIR-326: the book is a vault file and one book_set_root; get_book_root is the fake chain's root. Cases: order, deposits_and_signers, verify_detects_drift, nonce_never_lowered, payee_keys_are_canonical, policy_json_schema,
# storage_budget_math, task_key_seed_never_printed. Last line: BOOTSTRAP TESTS OK
set -uo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BOOT="$here/bootstrap-policy.sh"
BUDGET="$here/storage-budget.sh"
TASKKEY="$here/task-key.mjs"
ACCTS="$here/../fixtures/accounts.testnet.json"
POLICYJ="$here/../fixtures/policy.json"
fail() { echo "FAIL $1: $2"; exit 1; }
for f in "$BOOT" "$BUDGET" "$TASKKEY" "$ACCTS" "$POLICYJ" "$here/../fixtures/local-mode.json"; do
  [ -f "$f" ] || fail setup "$f is missing"
done

T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT
mkdir -p "$T/bin"

cat > "$T/bin/near" <<'EOF'
#!/usr/bin/env bash
{ printf 'near'; for a in "$@"; do printf '|%s' "$a"; done; printf '\n'; } >> "$FAKE_LOG"
mode="$3"; method="$5"; args="$7"
case "$mode" in
  as-read-only)
    v="$(printf '%s' "$args" | jq -r 'if type == "object" and length > 0 then (to_entries[0].value | tostring) else empty end' | tr -c 'A-Za-z0-9\n' '_')"
    f="$FAKE_STATE/$method.$v.json"
    [ -f "$f" ] || f="$FAKE_STATE/$method.json"
    if [ -f "$f" ]; then cat "$f"; else echo "no fake state for $method" >&2; exit 1; fi ;;
  as-transaction)
    n=$(( $(cat "$FAKE_STATE/.txn" 2> /dev/null || echo 0) + 1 )); echo "$n" > "$FAKE_STATE/.txn"
    echo "Transaction ID: FAKE$n"
    echo "Here is your console command if you need to script it" ;;
  *) echo "unexpected call shape" >&2; exit 1 ;;
esac
exit 0
EOF
cat > "$T/bin/curl" <<'EOF'
#!/usr/bin/env bash
echo "curl $*" >> "$FAKE_LOG"
case "$*" in
  *eth_getTransactionCount*) printf '{"jsonrpc":"2.0","id":1,"result":"0x%x"}\n' "$FAKE_CHAIN_NONCE" ;;
  *view_account*) printf '{"jsonrpc":"2.0","id":"x","result":{"amount":"%s","locked":"5555","code_hash":"x","storage_usage":%s}}\n' "$FAKE_AMOUNT" "$FAKE_USAGE" ;;
  *) echo '{}' ;;
esac
EOF
chmod +x "$T/bin/near" "$T/bin/curl"

# AIR-326: the owner's private book of these tests, and the root the fake chain reports (zeros until a run has built the vault)
export AIRLOCK_BOOK_VAULT="$T/book.vault.json"
BOOK_ROOT="$(printf '0%.0s' $(seq 1 64))"
export TASK_PUBLIC_KEY="ed25519:AKnL4NNf3DGWZJS6cPknBuEGnVsV4A4m5tgebLHaRSZ9"
export FAKE_CHAIN_NONCE=5 FAKE_AMOUNT=40000000000000000000000000 FAKE_USAGE=900000
POLICY_ACC="$(jq -r .policy "$ACCTS")"
AGENT_ACC="$(jq -r .agent "$ACCTS")"
OWNER_ACC="$(jq -r .owner "$ACCTS")"
EVM_KEY="evm:84532:0x7eafcb38a7de2a6805db7c93ccec6365a5c7528f"

mkstate() {   # mkstate <dir>: every fake view equals the fixture (nonce 5 equals the chain, agent registered)
  local d="$1" a
  mkdir -p "$d"
  jq -c '{paused: false, flags: .flags}' "$POLICYJ" > "$d/get_policy.json"
  jq -c '{attestation_expiration_time_ms}' "$POLICYJ" > "$d/get_contract_info.json"
  for a in near evm:84532:native; do
    jq -c --arg a "$a" '.assets[$a]' "$POLICYJ" > "$d/get_asset.$(printf '%s' "$a" | tr -c 'A-Za-z0-9' '_').json"
  done
  jq -c '[.assets | to_entries[] | [.key, .value]]' "$POLICYJ" > "$d/list_assets.json"
  printf '"%s"\n' "$BOOK_ROOT" > "$d/get_book_root.json"
  printf '"%s"\n' "$TASK_PUBLIC_KEY" > "$d/get_task_key.json"
  echo true > "$d/is_agent_allowed.json"
  echo true > "$d/is_agent_valid.json"
  jq -nc --arg a "$AGENT_ACC" '{account_id:$a, valid_until_ms:"1893456000000", validity:"Valid"}' > "$d/get_agent.json"
  echo '"5"' > "$d/get_nonce.json"
}

run() {   # run <state dir> <script> <args...>: sets OUT, RC and the log in $FAKE_LOG; the fake bin dir is first on PATH
  local st="$1" script="$2"; shift 2
  export FAKE_STATE="$st" FAKE_LOG="$st/near.log"
  : > "$FAKE_LOG"
  set +e; OUT="$(PATH="$T/bin:$PATH" "$script" "$@" 2>&1)"; RC=$?
}
txlines() { awk -F'|' '$4 == "as-transaction"' "$FAKE_LOG"; }

# case 1: order. A fresh contract (get_agent null, get_nonce null) gets the 15 transactions in the listed order.
S="$T/s1"; mkstate "$S"; echo null > "$S/get_agent.json"; echo null > "$S/get_nonce.json"
run "$S" "$BOOT"
GOT="$(txlines | awk -F'|' '{print $6}' | tr '\n' ' ')"
WANT="update_attestation_expiration_time approve_measurements approve_ppids whitelist_agent_for_local register_agent allow_agent asset_set asset_set book_set_root set_flags set_task_key set_nonce "
[ "$GOT" = "$WANT" ] || fail order "got: $GOT"
[ "$(printf '%s\n' "$OUT" | grep -c '^TX ')" -ge 12 ] || fail order "fewer than 12 TX lines"
echo "ok order"
# the vault the first run built; later states report its root as the chain root
BOOK_ROOT="$(cd "$here/.." && npx --no-install tsx scripts/book-vault.ts root "$AIRLOCK_BOOK_VAULT")"
[ "${#BOOK_ROOT}" = 64 ] || fail order "no vault root"
[ "$(stat -f '%Lp' "$AIRLOCK_BOOK_VAULT")" = "600" ] || fail order "the vault is not mode 600"

# case 2: deposits_and_signers
OTHERS="$(txlines | awk -F'|' '$6 != "register_agent" && ($12 != "1 yoctoNEAR" || $14 != "'"$OWNER_ACC"'") {print $6}')"
[ -z "$OTHERS" ] || fail deposits_and_signers "owner call without 1 yoctoNEAR or the owner as signer: $OTHERS"
REG="$(txlines | awk -F'|' '$6 == "register_agent" {print $12 "/" $14}')"
[ "$REG" = "0.005 NEAR/$AGENT_ACC" ] || fail deposits_and_signers "register_agent on a null get_agent: $REG"
txlines | awk -F'|' '{ if ($10 != "100 Tgas") exit 1 }' || fail deposits_and_signers "prepaid gas is not 100 Tgas"
S="$T/s2"; mkstate "$S"
run "$S" "$BOOT"
REG="$(txlines | awk -F'|' '$6 == "register_agent" {print $12 "/" $14}')"
[ "$REG" = "0 NEAR/$AGENT_ACC" ] || fail deposits_and_signers "register_agent on a registered agent: $REG"
FP="$(node "$here/agent-fingerprint.mjs" "$AGENT_ACC")"
txlines | awk -F'|' '$6 == "allow_agent" {print $8}' | jq -e --arg f "$FP" --arg a "$AGENT_ACC" '.fingerprint == $f and .account_id == $a' > /dev/null \
  || fail deposits_and_signers "allow_agent arguments"
echo "ok deposits_and_signers"

# case 3: verify_detects_drift
S="$T/s3"; mkstate "$S"
run "$S" "$BOOT" --verify
[ "$RC" -eq 0 ] || fail verify_detects_drift "matching state exited $RC: $OUT"
[ "$(printf '%s\n' "$OUT" | tail -1)" = "POLICY MATCHES fixtures/policy.json" ] || fail verify_detects_drift "no POLICY MATCHES line: $OUT"
printf '%s\n' "$OUT" | grep -q '^DRIFT' && fail verify_detects_drift "DRIFT on matching state: $OUT"
printf '%s\n' "$OUT" | grep -q '^agent valid until 2030-01-01T00:00:00Z$' || fail verify_detects_drift "no agent valid until line: $OUT"
[ -z "$(txlines)" ] || fail verify_detects_drift "--verify sent a transaction"
OTHER_ROOT="$(printf 'f%.0s' $(seq 1 64))"
echo "\"$OTHER_ROOT\"" > "$S/get_book_root.json"
run "$S" "$BOOT" --verify
[ "$RC" -eq 1 ] || fail verify_detects_drift "book root drift exited $RC"
printf '%s\n' "$OUT" | grep -qx "DRIFT book field root expected $BOOK_ROOT got $OTHER_ROOT" \
  || fail verify_detects_drift "no book root DRIFT line: $OUT"
printf '%s\n' "$OUT" | tail -1 | grep -qx 'POLICY MATCHES fixtures/policy.json' && fail verify_detects_drift "MATCHES printed with drift"
S="$T/s3b"; mkstate "$S"
jq -c '. + [["extra", {"symbol":"X","decimals":1,"hard_cap":"1","daily_cap":"1","max_fee_per_gas":"0","max_gas":"0","quick_task_cap":"1","path":null}]]' "$S/list_assets.json" > "$S/x.json" && mv "$S/x.json" "$S/list_assets.json"
run "$S" "$BOOT" --verify
[ "$RC" -eq 1 ] || fail verify_detects_drift "extra asset exited $RC"
printf '%s\n' "$OUT" | grep -q '^DRIFT assets field ids' || fail verify_detects_drift "extra asset is not a DRIFT: $OUT"
echo "ok verify_detects_drift"

# case 4: nonce_never_lowered
nonce_case() {   # nonce_case <name> <get_nonce json> <chain> <flag or empty>; sets SENT (the set_nonce value or none) and OUT
  local st="$T/n_$1"; mkstate "$st"; echo "$2" > "$st/get_nonce.json"
  export FAKE_CHAIN_NONCE="$3"
  if [ -n "$4" ]; then run "$st" "$BOOT" "$4"; else run "$st" "$BOOT"; fi
  SENT="$(txlines | awk -F'|' '$6 == "set_nonce" {print $8}' | jq -r '.nonce' | tr '\n' ',')"
  export FAKE_CHAIN_NONCE=5
}
nonce_case ahead '"7"' 5 ""
[ -z "$SENT" ] || fail nonce_never_lowered "nonce 7 vs chain 5 sent set_nonce $SENT"
printf '%s\n' "$OUT" | grep -q '^nonce kept 7 (chain 5)$' || fail nonce_never_lowered "no nonce kept line: $OUT"
nonce_case behind '"3"' 5 ""
[ "$SENT" = "5," ] || fail nonce_never_lowered "nonce 3 vs chain 5 sent: $SENT"
nonce_case null null 5 ""
[ "$SENT" = "5," ] || fail nonce_never_lowered "null nonce vs chain 5 sent: $SENT"
nonce_case force '"7"' 5 --force-nonce
[ "$SENT" = "5," ] || fail nonce_never_lowered "--force-nonce sent: $SENT"
echo "ok nonce_never_lowered"

# case 5: payee_keys_are_canonical
S="$T/s5"; mkstate "$S"
UPPER="0x7EAFCB38A7DE2A6805DB7C93CCEC6365A5C7528F"
jq --arg u "$UPPER" '.contractor_evm = $u' "$ACCTS" > "$T/accts_upper.json"
export AIRLOCK_ACCOUNTS_FILE="$T/accts_upper.json"
rm -f "$AIRLOCK_BOOK_VAULT"
run "$S" "$BOOT"
unset AIRLOCK_ACCOUNTS_FILE
jq -e --arg k "$EVM_KEY" '[.entries[].payee] | index($k) != null' "$AIRLOCK_BOOK_VAULT" > /dev/null \
  || fail payee_keys_are_canonical "the EVM payee key of the vault is not lowercase"
jq 'del(.sam)' "$ACCTS" > "$T/accts_nosam.json"
export AIRLOCK_ACCOUNTS_FILE="$T/accts_nosam.json"
run "$S" "$BOOT"
unset AIRLOCK_ACCOUNTS_FILE
[ "$RC" -eq 2 ] || fail payee_keys_are_canonical "a missing accounts key exited $RC"
[ ! -s "$FAKE_LOG" ] || fail payee_keys_are_canonical "a call was made before the exit 2"
echo "ok payee_keys_are_canonical"

# case 6: policy_json_schema
jq -e '(.assets | keys) == ["evm:84532:native","near"] and (.book | length) == 4 and (.flags | keys | length) == 7 and .task_public_key == null' "$POLICYJ" > /dev/null \
  || fail policy_json_schema "shape"
jq -e '[.assets[] | .hard_cap, .daily_cap, .max_fee_per_gas, .max_gas, .quick_task_cap] + [.book[] | .daily_untrusted_budget, .daily_limit, (.cap | select(. != null))]
       + [.attestation_expiration_time_ms, .flags.pending_ttl_ms, .flags.max_task_ttl_ms] | all(type == "string" and test("^[0-9]+$"))' "$POLICYJ" > /dev/null \
  || fail policy_json_schema "a decimal-string field is not ^[0-9]+\$"
echo "ok policy_json_schema"

# case 7: storage_budget_math (the RPC `locked` field is 5555 in the fake and must be ignored)
export FAKE_USAGE=900000 FAKE_STATE="$T/s7" FAKE_LOG="$T/s7.log"; mkdir -p "$FAKE_STATE"; : > "$FAKE_LOG"
export FAKE_AMOUNT=34000000000000000000000000
set +e; OUT="$(PATH="$T/bin:$PATH" "$BUDGET" 2>&1)"; RC=$?; set +e
[ "$RC" -eq 1 ] || fail storage_budget_math "34 NEAR exited $RC"
[ "$(printf '%s\n' "$OUT" | tail -1)" = "STORAGE LOW: top up 0.74 NEAR" ] || fail storage_budget_math "34 NEAR: $OUT"
export FAKE_AMOUNT=40000000000000000000000000
set +e; OUT="$(PATH="$T/bin:$PATH" "$BUDGET" 2>&1)"; RC=$?; set +e
[ "$RC" -eq 0 ] || fail storage_budget_math "40 NEAR exited $RC"
[ "$(printf '%s\n' "$OUT" | tail -1)" = "STORAGE OK: locked 9.00 NEAR, spendable 31.00 NEAR" ] || fail storage_budget_math "40 NEAR: $OUT"
export FAKE_AMOUNT=40000000000000000000000000 FAKE_USAGE=900000
echo "ok storage_budget_math"

# case 8: task_key_seed_never_printed
K="$T/task-key"; mkdir -p "$K"
export AIRLOCK_TASK_KEY_FILE="$K/seed"
OUT="$(node "$TASKKEY" init 2>&1)"; RC=$?
[ "$RC" -eq 0 ] || fail task_key_seed_never_printed "init exited $RC"
printf '%s\n' "$OUT" | grep -qE '[0-9a-f]{64}' && fail task_key_seed_never_printed "init printed a 64 hex string"
[ "$(stat -f '%Lp' "$K/seed")" = "600" ] || fail task_key_seed_never_printed "mode is not 600"
[ "$(wc -c < "$K/seed" | tr -d ' ')" = "65" ] && grep -qE '^[0-9a-f]{64}$' "$K/seed" || fail task_key_seed_never_printed "file is not 64 lowercase hex plus a newline"
OUT2="$(node "$TASKKEY" init 2>&1)"; RC=$?
[ "$RC" -eq 1 ] && [ "$OUT2" = "exists" ] || fail task_key_seed_never_printed "second init: exit $RC, '$OUT2'"
PUB="$(node "$TASKKEY" pubkey 2>&1)"
[ "$(printf '%s\n' "$PUB" | wc -l | tr -d ' ')" = "1" ] && printf '%s\n' "$PUB" | grep -qE '^ed25519:[1-9A-HJ-NP-Za-km-z]{43,44}$' \
  || fail task_key_seed_never_printed "pubkey output: $PUB"
unset AIRLOCK_TASK_KEY_FILE
echo "ok task_key_seed_never_printed"

echo "BOOTSTRAP TESTS OK"
