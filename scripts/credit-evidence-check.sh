#!/usr/bin/env bash
# AIR-331: reads the committed evidence of AIRLOCK Credit (docs/EVIDENCE.md, section "AIRLOCK Credit") and the committed wasm files and
# checks what the README claims: the sha256 of the pool and card wasm equal the hashes written in the section, the section holds at least 33
# transaction links (each a full hash, none empty), and it names the facts the README states (the LP's 3.03 NEAR for 3, the refusal of the
# approver, the two refused deposits and the accepted one, the default with the collateral seized, the recovered loss, the price impaired
# before the default). It sends nothing and needs no network, and it does not re-read the chain: the coordinator's check of each hash is
# separate.
# Last line: CREDIT EVIDENCE OK <n> transactions. Exit 0 on success, 1 on a mismatch.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EV="$ROOT/docs/EVIDENCE.md"
fail() { echo "FAIL $1"; exit 1; }
[ -f "$EV" ] || fail "docs/EVIDENCE.md is missing"
SECTION="$(awk '/^## AIRLOCK Credit/{on=1; next} /^## /{on=0} on' "$EV")"
[ -n "$SECTION" ] || fail "no section AIRLOCK Credit in docs/EVIDENCE.md"
for w in contracts/airlock-credit/res/airlock_credit.wasm contracts/airlock-policy/res/airlock_policy.wasm; do
  [ -f "$ROOT/$w" ] || fail "$w is missing"
  sha="$(shasum -a 256 "$ROOT/$w" | cut -d' ' -f1)"
  printf '%s' "$SECTION" | grep -q "$sha" || fail "the sha256 of $w ($sha) is not in the section"
done
ALL="$(printf '%s' "$SECTION" | grep -o 'https://testnet.nearblocks.io/txns/[A-Za-z0-9]*' | wc -l | tr -d ' ')"
N="$(printf '%s' "$SECTION" | grep -oE 'https://testnet.nearblocks.io/txns/[A-Za-z0-9]{40,}' | sort -u | wc -l | tr -d ' ')"
[ "$N" -eq "$ALL" ] || fail "$ALL transaction links, only $N with a full hash"
[ "$N" -ge 33 ] || fail "only $N transaction links in the section"
for phrase in "worth 3.0300 NEAR for 3 NEAR deposited" "approve refused for the approver" "collateral seized" "recovery of the loss" "impaired" "roles verified on chain" "deposits are paused while a line is past due" "deposits are paused while a defaulted line is being recovered" "accepted at the recovered price"; do
  printf '%s' "$SECTION" | grep -q "$phrase" || fail "the section does not say: $phrase"
done
echo "CREDIT EVIDENCE OK $N transactions"
