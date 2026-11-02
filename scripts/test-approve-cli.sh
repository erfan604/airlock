#!/usr/bin/env bash
# AIR-087: offline tests of scripts/approve-cli.sh and scripts/pending-cli.sh with a fake `near` on PATH.
# The fake logs one line per call in $FAKE_LOG (arguments joined by `|`) and mirrors the two call shapes only:
#   contract call-function as-read-only CONTRACT METHOD json-args ARGS network-config testnet now  -> prints $FAKE_STATE/<method>.json
#   contract call-function as-transaction ...                                                        -> prints `Transaction ID: FAKE1`
# Each case runs in its own temp dir. Last line: APPROVE CLI OK
set -uo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APPROVE="$here/approve-cli.sh"
PENDING="$here/pending-cli.sh"
for f in "$APPROVE" "$PENDING" "$here/../fixtures/accounts.testnet.json"; do
  [ -f "$f" ] || { echo "FAIL setup: $f is missing"; exit 1; }
done
fail() { echo "FAIL $1: $2"; exit 1; }

ROOT="$(mktemp -d)"
trap 'rm -rf "$ROOT"' EXIT
mkdir -p "$ROOT/bin"
cat > "$ROOT/bin/near" <<'EOF'
#!/usr/bin/env bash
{ printf 'near'; for a in "$@"; do printf '|%s' "$a"; done; printf '\n'; } >> "$FAKE_LOG"
mode="$3"; method="$5"
case "$mode" in
  as-read-only)
    if [ -f "$FAKE_STATE/$method.json" ]; then cat "$FAKE_STATE/$method.json"; else echo "no fake state" >&2; exit 1; fi ;;
  as-transaction) echo "Transaction ID: FAKE1" ;;
  *) echo "unexpected call shape" >&2; exit 1 ;;
esac
EOF
chmod +x "$ROOT/bin/near"

FUTURE=99999999999999
# new_case <name>: fresh dir, sets FAKE_LOG, FAKE_STATE
new_case() {
  D="$ROOT/$1"; mkdir -p "$D/state"
  export FAKE_LOG="$D/log" FAKE_STATE="$D/state"
  : > "$FAKE_LOG"
  export PATH="$ROOT/bin:$BASE_PATH"
}
BASE_PATH="$PATH"
# view <state> <expires_ms> <payee> <rec> <amt> <pc>: writes get_request.json
view() {
  jq -n --arg state "$1" --arg exp "$2" --arg payee "$3" --argjson r "$4" --argjson a "$5" --argjson p "$6" '{
    agent:"erfan-agent.testnet", amount:"9400000000000000000000000", asset:"near", book_status:"in_book", created_ms:"1000",
    digest:"7c9e39f3d889cd171a3bc1fc9631191a476fff04612ce04b918936f320cd02f0",
    display:{amount_decimal:"9.4", asset_symbol:"NEAR"}, expires_ms:$exp, id:"7", labels:{amount:$a, pc:$p, recipient:$r},
    payee:$payee, reason:"UntrustedAmount", request_id:"ab:0", state:$state, task_id:"t"}' > "$FAKE_STATE/get_request.json"
}
nlog() { wc -l < "$FAKE_LOG" | tr -d ' '; }
ntx() { n="$(grep -c 'as-transaction' "$FAKE_LOG")"; echo "${n:-0}"; }

# 1 card_values_equal_the_stored_view
new_case c1; view Pending "$FUTURE" "near:accountant.erfan-airlock.testnet" 2 32 1
out="$("$APPROVE" 7)"; rc=$?
[ "$rc" = 0 ] || fail card_values "exit $rc"
for lab in 'APPROVE CARD pending id 7' 'to       near:accountant.erfan-airlock.testnet' 'asset    NEAR' 'amount   9.4' 'why      UntrustedAmount' \
  'book     in_book' 'labels   recipient=Book amount=Untrusted:email pc=Owner' 'expires  ' 'digest   7c9e39f3' 'args     ' 'command  '; do
  printf '%s\n' "$out" | grep -qF -- "$lab" || fail card_values "missing line: $lab"
done
got="$(printf '%s\n' "$out" | sed -n 's/^args     //p' | jq -S -c .)"
want="$(jq -nS -c '{id:"7",to:"near:accountant.erfan-airlock.testnet",asset:"NEAR",amount:"9.4",why:"UntrustedAmount",book:"in_book"}')"
[ -n "$got" ] && [ "$got" = "$want" ] || fail card_values "args $got != $want"
[ "$(printf '%s\n' "$out" | sed -n 's/^args     //p')" = '{"id":"7","to":"near:accountant.erfan-airlock.testnet","asset":"NEAR","amount":"9.4","why":"UntrustedAmount","book":"in_book"}' ] \
  || fail card_values "args order is not id, to, asset, amount, why, book"
[ "$(nlog)" = 1 ] || fail card_values "near was called $(nlog) times, want 1 read"
echo "ok card_values_equal_the_stored_view"

# 2 command_contains_one_yocto_and_the_published_tgas
new_case c2; view Pending "$FUTURE" "near:accountant.erfan-airlock.testnet" 2 32 1
n="$(sed -n 's/^APPROVE_PREPAID_TGAS="\${APPROVE_PREPAID_TGAS:-\([0-9][0-9]*\)}"$/\1/p' "$APPROVE")"
[ -n "$n" ] || fail command "APPROVE_PREPAID_TGAS line not found"
out="$("$APPROVE" 7)"
printf '%s\n' "$out" | grep -qF "prepaid-gas '$n Tgas'" || fail command "no prepaid-gas '$n Tgas'"
printf '%s\n' "$out" | grep -qF "attached-deposit '1 yoctoNEAR'" || fail command "no one yocto"
printf '%s\n' "$out" | grep -qF "approve json-args" || fail command "no approve"
printf '%s\n' "$out" | grep -qF "sign-as erfan-airlock.testnet network-config testnet sign-with-keychain send" || fail command "owner signing tail"
out="$(APPROVE_PREPAID_TGAS=222 "$APPROVE" 7)"
printf '%s\n' "$out" | grep -qF "prepaid-gas '222 Tgas'" || fail command "env override ignored"
out="$("$APPROVE" 7 --reject)"
printf '%s\n' "$out" | grep -qF "reject json-args '{\"id\":\"7\"}'" || fail command "reject args"
printf '%s\n' "$out" | grep -qF "prepaid-gas '30 Tgas'" || fail command "reject gas"
printf '%s\n' "$out" | grep -qF "attached-deposit '1 yoctoNEAR'" || fail command "reject yocto"
echo "ok command_contains_one_yocto_and_the_published_tgas"

# 3 nothing_runs_without_run_and_yes
new_case c3; view Pending "$FUTURE" "near:accountant.erfan-airlock.testnet" 2 32 1
"$APPROVE" 7 > /dev/null; "$APPROVE" 7 --reject > /dev/null
[ "$(ntx)" = 0 ] || fail nothing_runs "default or --reject sent a transaction"
for inp in 'no' '' 'yes '; do
  printf '%s\n' "$inp" | "$APPROVE" 7 --run > /dev/null 2>&1; rc=$?
  [ "$rc" = 1 ] || fail nothing_runs "input '$inp' exit $rc, want 1"
done
"$APPROVE" 7 --run < /dev/null > /dev/null 2>&1; rc=$?
[ "$rc" = 1 ] || fail nothing_runs "empty stdin exit $rc, want 1"
[ "$(ntx)" = 0 ] || fail nothing_runs "a non-yes input sent a transaction"
out="$(printf 'yes\n' | "$APPROVE" 7 --run 2> /dev/null)"; rc=$?
[ "$rc" = 0 ] || fail nothing_runs "yes exit $rc"
[ "$(ntx)" = 1 ] || fail nothing_runs "yes sent $(ntx) transactions, want 1"
grep 'as-transaction' "$FAKE_LOG" | grep -q '|approve|' || fail nothing_runs "logged call is not approve"
printf '%s\n' "$out" | grep -qx 'Transaction ID: FAKE1' || fail nothing_runs "no Transaction ID line"
echo "ok nothing_runs_without_run_and_yes"

# 4 refuses_non_pending_and_expired
for st in Executed Rejected Expired; do
  new_case "c4$st"; view "$st" "$FUTURE" "near:a.testnet" 0 0 0
  out="$(printf 'yes\n' | "$APPROVE" 7 --run 2> /dev/null)"; rc=$?
  [ "$rc" = 1 ] || fail refuses "$st exit $rc"
  printf '%s\n' "$out" | grep -qx "NOT PENDING: state $st" || fail refuses "$st message: $out"
  [ "$(ntx)" = 0 ] || fail refuses "$st sent a transaction"
done
new_case c4past; view Pending 1000 "near:a.testnet" 0 0 0
out="$(printf 'yes\n' | "$APPROVE" 7 --run 2> /dev/null)"; rc=$?
[ "$rc" = 1 ] || fail refuses "expired exit $rc"
printf '%s\n' "$out" | grep -q '^EXPIRED' || fail refuses "expired message: $out"
[ "$(ntx)" = 0 ] || fail refuses "expired sent a transaction"
new_case c4null; echo null > "$FAKE_STATE/get_request.json"
"$APPROVE" 7 > /dev/null 2>&1; rc=$?
[ "$rc" = 1 ] || fail refuses "unknown id exit $rc"
echo "ok refuses_non_pending_and_expired"

# 5 rejects_bad_ids
new_case c5; view Pending "$FUTURE" "near:a.testnet" 0 0 0
big="12345678901"
for bad in 0 007 +7 1.5 "$big" '' '1" ; x'; do
  "$APPROVE" "$bad" > /dev/null 2>&1; rc=$?
  [ "$rc" = 2 ] || fail bad_ids "'$bad' exit $rc, want 2"
done
[ "$(nlog)" = 0 ] || fail bad_ids "near was called for a bad id"
echo "ok rejects_bad_ids"

# 6 labels_decode
new_case c6
for spec in "2:Book" "32:Untrusted:email" "33:Owner+Untrusted:email" "0:none"; do
  m="${spec%%:*}"; want="${spec#*:}"
  view Pending "$FUTURE" "near:a.testnet" "$m" 0 0
  got="$("$APPROVE" 7 | sed -n 's/^labels   recipient=\([^ ]*\) .*/\1/p')"
  [ "$got" = "$want" ] || fail labels "mask $m printed '$got', want '$want'"
done
echo "ok labels_decode"

# 7 pending_table
new_case c7
jq -n '[{id:"1",payee:"near:a.testnet",display:{asset_symbol:"NEAR",amount_decimal:"9.4"},reason:"UntrustedAmount",book_status:"in_book",expires_ms:"1793612086607"},
        {id:"2",payee:"evm:84532:0xabc",display:{asset_symbol:"ETH.base",amount_decimal:"0.01"},reason:"UntrustedRecipient",book_status:"new",expires_ms:"1793612086607"}]' > "$FAKE_STATE/get_pending.json"
out="$("$PENDING")"; rc=$?
[ "$rc" = 0 ] || fail pending_table "exit $rc"
[ "$(printf '%s\n' "$out" | wc -l | tr -d ' ')" = 3 ] || fail pending_table "want header plus two rows: $out"
printf '%s\n' "$out" | grep -q 'NEAR 9.4' || fail pending_table "row one"
printf '%s\n' "$out" | grep -q 'ETH.base 0.01' || fail pending_table "row two"
grep -qF '|{"from_index":0,"limit":20}|' "$FAKE_LOG" || fail pending_table "get_pending args"
echo '[]' > "$FAKE_STATE/get_pending.json"
[ "$("$PENDING")" = "no pending requests" ] || fail pending_table "empty list"
echo "ok pending_table"

# 8 args_survive_hostile_text
new_case c8
hostile="near:evil' \$(touch $ROOT/pwned) \"x y"
view Pending "$FUTURE" "$hostile" 0 0 0
out="$("$APPROVE" 7)"
got="$(printf '%s\n' "$out" | sed -n 's/^args     //p' | jq -r .to)"
[ "$got" = "$hostile" ] || fail hostile "payee changed: $got"
printf 'yes\n' | "$APPROVE" 7 --run > /dev/null 2>&1
[ ! -e "$ROOT/pwned" ] || fail hostile "payee text was executed"
line="$(grep 'as-transaction' "$FAKE_LOG")"
[ "$(printf '%s' "$line" | awk -F'|' '{print NF}')" = 18 ] || fail hostile "transaction argument count changed: $line"
sent="$(printf '%s' "$line" | awk -F'|' '{print $8}' | jq -r .to)"
[ "$sent" = "$hostile" ] || fail hostile "sent payee differs"
echo "ok args_survive_hostile_text"

echo "APPROVE CLI OK"
