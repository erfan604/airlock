#!/usr/bin/env bash
# AIR-049: turn a freshly deployed policy contract into the demo configuration and verify it against fixtures/policy.json.
#   scripts/bootstrap-policy.sh [--verify] [--force-nonce]
# Without flags: 15 transactions on a fresh contract (every owner call attaches 1 yoctoNEAR; register_agent is the agent's call
# and attaches 0.005 NEAR on a first registration, 0 NEAR on a re-registration), then --verify, whose status is the script's.
# --verify sends nothing: it reads the chain and prints `ok <item>` or `DRIFT <item> field <f> expected <x> got <y>` per item,
# and ends with `POLICY MATCHES fixtures/policy.json` only when there is no DRIFT.
# --force-nonce sends set_nonce with the chain value even when the contract's nonce is higher (recovery only, docs/design/nonce.md).
# Signing goes through the near CLI's own keychain option (sign-with-keychain); this script never reads a key or a credentials file.
# Test hooks (scripts/test-bootstrap.sh): NEAR, BASE_RPC, AIRLOCK_ACCOUNTS_FILE, AIRLOCK_POLICY_FILE, AIRLOCK_LOCAL_MODE_FILE,
# TASK_PUBLIC_KEY.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NEAR="${NEAR:-near}"
BASE_RPC="${BASE_RPC:-https://sepolia.base.org}"
ACCOUNTS="${AIRLOCK_ACCOUNTS_FILE:-$ROOT/fixtures/accounts.testnet.json}"
POLICY_FILE="${AIRLOCK_POLICY_FILE:-$ROOT/fixtures/policy.json}"
LOCAL_MODE="${AIRLOCK_LOCAL_MODE_FILE:-$ROOT/fixtures/local-mode.json}"

VERIFY=0
FORCE_NONCE=0
for a in "$@"; do
  case "$a" in
    --verify) VERIFY=1 ;;
    --force-nonce) FORCE_NONCE=1 ;;
    *) echo "usage: scripts/bootstrap-policy.sh [--verify] [--force-nonce]" >&2; exit 2 ;;
  esac
done

die() { echo "$1" >&2; exit 1; }
need() { command -v "$1" > /dev/null || die "FAILED: $1 not found"; }
need jq
need python3
need curl
need node

# ---- inputs (exit 2 before any call) ----
[ -f "$ACCOUNTS" ] || { echo "REFUSED: $ACCOUNTS is missing" >&2; exit 2; }
[ -f "$POLICY_FILE" ] || { echo "REFUSED: $POLICY_FILE is missing" >&2; exit 2; }
# owner, policy and agent always; every payee account the policy file names as a {placeholder} is checked when it is resolved below
for k in owner policy agent; do
  v="$(jq -r --arg k "$k" '.[$k] // empty' "$ACCOUNTS")"
  [ -n "$v" ] || { echo "REFUSED: key '$k' is missing in $ACCOUNTS" >&2; exit 2; }
done
OWNER="$(jq -r .owner "$ACCOUNTS")"
POLICY="$(jq -r .policy "$ACCOUNTS")"
AGENT="$(jq -r .agent "$ACCOUNTS")"

# the policy fixture with {name} placeholders resolved from the accounts file; EVM payee keys are canonical (lowercase, AIR-043)
EXPECTED="$(jq -c --slurpfile acc "$ACCOUNTS" '
  def res: gsub("\\{(?<n>[a-z_]+)\\}"; ($acc[0][.n] // error("no account " + .n)));
  .book |= map(.key |= (res | if startswith("evm:") then ascii_downcase else . end))' "$POLICY_FILE")" \
  || { echo "REFUSED: could not resolve the placeholders of $POLICY_FILE" >&2; exit 2; }
NONCE_PATH="$(printf '%s' "$EXPECTED" | jq -r '.nonce.path')"
# A NEAR-only policy (no asset with an EVM signing path) has no EVM nonce to set or verify: the contract answers "unknown path".
HAS_EVM="$(printf '%s' "$EXPECTED" | jq -r '[.assets[]? | select(.path != null)] | length > 0')"
ATT_MS="$(printf '%s' "$EXPECTED" | jq -r '.attestation_expiration_time_ms')"

# ---- helpers ----
clean() { sed $'s/\x1b\\[[0-9;]*m//g'; }

view() {   # view <method> <json args>: the near CLI prints the return value on stdout and decoration on stderr
  "$NEAR" contract call-function as-read-only "$POLICY" "$1" json-args "$2" network-config testnet now 2> /dev/null
}

tx() {   # tx <signer> <method> <json args> <deposit>
  local out rc hash
  out="$("$NEAR" contract call-function as-transaction "$POLICY" "$2" json-args "$3" prepaid-gas '100 Tgas' attached-deposit "$4" sign-as "$1" network-config testnet sign-with-keychain send 2>&1)"
  rc=$?
  out="$(printf '%s\n' "$out" | clean)"
  hash="$(printf '%s\n' "$out" | grep -oE 'Transaction ID: *[A-Za-z0-9]+' | head -1 | sed 's/.*: *//')"
  if [ "$rc" -ne 0 ] || [ -z "$hash" ] || printf '%s\n' "$out" | grep -qE 'ExecutionError|Failure'; then
    printf '%s\n' "$out" | tail -8 >&2
    die "FAILED: $2 (near exit $rc, transaction id '${hash:-none}')"
  fi
  echo "TX $2 $hash"
}

owner_tx() { tx "$OWNER" "$1" "$2" '1 yoctoNEAR'; }

chain_nonce() {   # the pending transaction count of the derived Base Sepolia address, as a decimal integer
  local addr resp
  addr="$(node "$ROOT/scripts/derive-address.mjs" "$POLICY" "$NONCE_PATH")" || return 1
  resp="$(curl -s --max-time 20 -X POST -H 'content-type: application/json' "$BASE_RPC" \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_getTransactionCount\",\"params\":[\"$addr\",\"pending\"]}")" || return 1
  python3 -I -c 'import json,sys; print(int(json.load(sys.stdin)["result"], 16))' <<< "$resp" 2> /dev/null
}

task_key() {   # the expected task public key: the fixture, else $TASK_PUBLIC_KEY, else the owner's seed file
  local k
  k="$(printf '%s' "$EXPECTED" | jq -r '.task_public_key // empty')"
  [ -n "$k" ] || k="${TASK_PUBLIC_KEY:-}"
  [ -n "$k" ] || k="$(node "$ROOT/scripts/task-key.mjs" pubkey 2> /dev/null)" || k=""
  printf '%s' "$k"
}

jqs() {   # jqs <json> <field>: the field as a plain string, null as the word null
  printf '%s' "$1" | jq -r --arg f "$2" '.[$f] | if . == null then "null" else tostring end'
}

# ---- bootstrap ----
bootstrap() {
  local id entry fp n cur dep existing i
  TASK_KEY="$(task_key)"
  [ -n "$TASK_KEY" ] || die "FAILED: no task public key: set TASK_PUBLIC_KEY or run: node scripts/task-key.mjs init"
  fp="$(node "$ROOT/scripts/agent-fingerprint.mjs" "$AGENT")" || die "FAILED: agent fingerprint"

  # 1 to 4: attestation lifetime first (valid_until_ms is fixed at registration), approvals, local whitelist
  owner_tx update_attestation_expiration_time "$(jq -nc --arg v "$ATT_MS" '{attestation_expiration_time_ms:$v}')"
  owner_tx approve_measurements "$(jq -c '.approve_measurements' "$LOCAL_MODE")"
  owner_tx approve_ppids "$(jq -c '.approve_ppids' "$LOCAL_MODE")"
  owner_tx whitelist_agent_for_local "$(jq -nc --arg a "$AGENT" '{account_id:$a}')"

  # 5: the agent registers with its own full-access key; a first registration needs the 0.005 NEAR storage deposit
  existing="$(view get_agent "$(jq -nc --arg a "$AGENT" '{account_id:$a}')")" || die "FAILED: get_agent view"
  if [ "$(printf '%s' "$existing" | jq -r 'if . == null then "null" else "record" end')" = "null" ]; then dep='0.005 NEAR'; else dep='0 NEAR'; fi
  tx "$AGENT" register_agent "$(jq -c '.register_agent' "$LOCAL_MODE")" "$dep"

  # 6: allow the agent by account and fingerprint
  owner_tx allow_agent "$(jq -nc --arg a "$AGENT" --arg f "$fp" '{account_id:$a,fingerprint:$f}')"

  # 7: assets
  for id in $(printf '%s' "$EXPECTED" | jq -r '.assets | keys_unsorted[]'); do
    entry="$(printf '%s' "$EXPECTED" | jq -c --arg id "$id" '.assets[$id]')"
    owner_tx asset_set "$(jq -nc --arg id "$id" --argjson e "$entry" '{asset:$id,entry:$e}')"
  done

  # 8: address book
  n="$(printf '%s' "$EXPECTED" | jq '.book | length')"
  for ((i = 0; i < n; i++)); do
    entry="$(printf '%s' "$EXPECTED" | jq -c --argjson i "$i" '.book[$i] | {key, cap, daily_untrusted_budget, daily_limit, label}')"
    owner_tx book_add "$entry"
  done

  # 9, 10: flags and the task key
  owner_tx set_flags "$(printf '%s' "$EXPECTED" | jq -c '{flags: .flags}')"
  owner_tx set_task_key "$(jq -nc --arg k "$TASK_KEY" '{public_key:$k}')"

  # 11: the EVM nonce, never lowered (skipped when the policy has no EVM asset)
  if [ "$HAS_EVM" != "true" ]; then echo "nonce skipped: no EVM asset in the policy"; return 0; fi
  n="$(chain_nonce)" || die "FAILED: could not read the pending nonce of the derived address from $BASE_RPC"
  cur="$(view get_nonce "$(jq -nc --arg p "$NONCE_PATH" '{path:$p}')")" || die "FAILED: get_nonce view"
  cur="$(printf '%s' "$cur" | jq -r 'if . == null then "null" else tostring end')"
  if [ "$FORCE_NONCE" = "0" ] && [ "$cur" != "null" ] && [ "$cur" -ge "$n" ]; then
    echo "nonce kept $cur (chain $n)"
  else
    owner_tx set_nonce "$(jq -nc --arg p "$NONCE_PATH" --arg n "$n" '{path:$p,nonce:$n}')"
  fi
}

# ---- verify (sends nothing) ----
DRIFTS=0
ITEM_BAD=0
check() {   # check <item> <field> <expected> <got>
  if [ "$3" != "$4" ]; then
    echo "DRIFT $1 field $2 expected $3 got $4"
    ITEM_BAD=1
    DRIFTS=$((DRIFTS + 1))
  fi
}
item_start() { ITEM_BAD=0; }
item_end() { [ "$ITEM_BAD" = "1" ] || echo "ok $1"; }
unreadable() { echo "DRIFT $1 field view expected readable got error"; DRIFTS=$((DRIFTS + 1)); }

verify() {
  local got exp id key name f i n chain cur d vuntil
  # get_policy: not paused, flags equal
  item_start
  if got="$(view get_policy '{}')"; then
    check policy paused false "$(jqs "$got" paused)"
    for f in $(printf '%s' "$EXPECTED" | jq -r '.flags | keys_unsorted[]'); do
      check policy "flags.$f" "$(printf '%s' "$EXPECTED" | jq -r --arg f "$f" '.flags[$f] | tostring')" \
        "$(printf '%s' "$got" | jq -r --arg f "$f" '.flags[$f] | if . == null then "null" else tostring end')"
    done
    item_end policy
  else unreadable policy; fi

  # get_contract_info
  item_start
  if got="$(view get_contract_info '{}')"; then
    check contract_info attestation_expiration_time_ms "$ATT_MS" "$(jqs "$got" attestation_expiration_time_ms)"
    item_end contract_info
  else unreadable contract_info; fi

  # assets, every field, then the exact id set
  for id in $(printf '%s' "$EXPECTED" | jq -r '.assets | keys_unsorted[]'); do
    item_start
    if got="$(view get_asset "$(jq -nc --arg a "$id" '{asset:$a}')")" && [ "$(printf '%s' "$got" | jq -r 'type')" = "object" ]; then
      for f in symbol decimals hard_cap daily_cap max_fee_per_gas max_gas quick_task_cap path; do
        check "asset $id" "$f" "$(printf '%s' "$EXPECTED" | jq -r --arg id "$id" --arg f "$f" '.assets[$id][$f] | if . == null then "null" else tostring end')" "$(jqs "$got" "$f")"
      done
      item_end "asset $id"
    else
      echo "DRIFT asset $id field present expected yes got no"
      DRIFTS=$((DRIFTS + 1))
    fi
  done
  item_start
  if got="$(view list_assets '{}')"; then
    check assets ids "$(printf '%s' "$EXPECTED" | jq -r '.assets | keys | join(",")')" "$(printf '%s' "$got" | jq -r '[.[][0]] | sort | join(",")')"
    item_end assets
  else unreadable assets; fi

  # address book, every entry, then the exact key set
  n="$(printf '%s' "$EXPECTED" | jq '.book | length')"
  for ((i = 0; i < n; i++)); do
    key="$(printf '%s' "$EXPECTED" | jq -r --argjson i "$i" '.book[$i].key')"
    name="$(printf '%s' "$EXPECTED" | jq -r --argjson i "$i" '.book[$i].name')"
    item_start
    if got="$(view get_book_entry "$(jq -nc --arg k "$key" '{key:$k}')")" && [ "$(printf '%s' "$got" | jq -r 'type')" = "object" ]; then
      for f in cap daily_untrusted_budget daily_limit label; do
        check "book $name" "$f" "$(printf '%s' "$EXPECTED" | jq -r --argjson i "$i" --arg f "$f" '.book[$i][$f] | if . == null then "null" else tostring end')" "$(jqs "$got" "$f")"
      done
      item_end "book $name"
    else
      echo "DRIFT book $name field present expected yes got no"
      DRIFTS=$((DRIFTS + 1))
    fi
  done
  item_start
  if got="$(view get_book '{}')"; then
    check book keys "$(printf '%s' "$EXPECTED" | jq -r '[.book[].key] | sort | join(",")')" "$(printf '%s' "$got" | jq -r '[.[][0]] | sort | join(",")')"
    item_end book
  else unreadable book; fi

  # task key
  item_start
  exp="$(task_key)"
  if got="$(view get_task_key '{}')"; then
    if [ -z "$exp" ]; then
      echo "DRIFT task_key field expected (no task key: set TASK_PUBLIC_KEY or run node scripts/task-key.mjs init) got $(printf '%s' "$got" | jq -r 'if . == null then "null" else . end')"
      ITEM_BAD=1
      DRIFTS=$((DRIFTS + 1))
    else
      check task_key public_key "$exp" "$(printf '%s' "$got" | jq -r 'if . == null then "null" else . end')"
    fi
    item_end task_key
  else unreadable task_key; fi

  # the agent: allowed, valid, and until when
  item_start
  if got="$(view is_agent_allowed "$(jq -nc --arg a "$AGENT" '{account_id:$a}')")"; then
    check agent_allowed value true "$(printf '%s' "$got" | jq -r 'tostring')"
    item_end agent_allowed
  else unreadable agent_allowed; fi
  item_start
  if got="$(view is_agent_valid "$(jq -nc --arg a "$AGENT" '{account_id:$a}')")"; then
    check agent_valid value true "$(printf '%s' "$got" | jq -r 'tostring')"
    item_end agent_valid
  else unreadable agent_valid; fi
  if got="$(view get_agent "$(jq -nc --arg a "$AGENT" '{account_id:$a}')")" && [ "$(printf '%s' "$got" | jq -r 'type')" = "object" ]; then
    vuntil="$(printf '%s' "$got" | jq -r '.valid_until_ms')"
    d="$(python3 -I -c 'import sys,datetime; print(datetime.datetime.fromtimestamp(int(sys.argv[1])/1000, datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"))' "$vuntil" 2> /dev/null || echo "$vuntil")"
    echo "agent valid until $d"
  fi

  # the nonce: at least the chain's pending count (nothing to verify without an EVM asset)
  if [ "$HAS_EVM" != "true" ]; then echo "nonce skipped: no EVM asset in the policy";
  else
  item_start
  if chain="$(chain_nonce)" && cur="$(view get_nonce "$(jq -nc --arg p "$NONCE_PATH" '{path:$p}')")"; then
    cur="$(printf '%s' "$cur" | jq -r 'if . == null then "null" else tostring end')"
    if [ "$cur" = "null" ] || [ "$cur" -lt "$chain" ]; then
      echo "DRIFT nonce field get_nonce expected at least $chain got $cur"
      ITEM_BAD=1
      DRIFTS=$((DRIFTS + 1))
    elif [ "$cur" -gt "$chain" ]; then
      echo "nonce ahead by $((cur - chain))"
    fi
    item_end nonce
  else unreadable nonce; fi
  fi

  if [ "$DRIFTS" -eq 0 ]; then
    echo "POLICY MATCHES fixtures/policy.json"
    return 0
  fi
  echo "POLICY DRIFT: $DRIFTS difference(s) from fixtures/policy.json"
  return 1
}

if [ "$VERIFY" = "0" ]; then
  command -v "$NEAR" > /dev/null || die "FAILED: near CLI not found"
  bootstrap
fi
verify
exit $?
