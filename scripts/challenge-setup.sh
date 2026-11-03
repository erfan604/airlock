#!/usr/bin/env bash
# AIR-301: set up the Steal this agent challenge on NEAR testnet. The owner runs this once; nothing else creates or deploys the account.
#   scripts/challenge-setup.sh [--dry-run]
# What it does, in order (each step stops the script on failure):
#   1. creates the sub-account CHALLENGE_POLICY (default challenge.erfan-airlock.testnet) from the owner account and funds it
#   2. deploys contracts/airlock-policy/res/airlock_policy.wasm to it with the init call (scripts/deploy-testnet.sh, which checks the code hash)
#   3. configures it with scripts/bootstrap-policy.sh from challenge/policy.challenge.json: NEAR only, 5 NEAR per request, 10 NEAR per day,
#      the three demo payees, a task key of its own (a fresh seed file outside the repo), the agent registered and allowed
#   4. generates the published key pair and adds its public half to the agent account as a function-call key: receiver the challenge policy,
#      method submit_batch only, allowance CHALLENGE_KEY_ALLOWANCE (default 1 NEAR)
#   5. writes the env file for `pnpm challenge` to CHALLENGE_ENV_FILE (default ~/.airlock-challenge.env, mode 600, outside the repo; the
#      script refuses to overwrite an existing one) and verifies the policy
# --dry-run prints the plan and the deploy dry run (balance and code hash only) and sends nothing, creates no key and writes no file.
# Signing goes through the near CLI's own keychain option (sign-with-keychain). The published secret key is written only to the env file and is
# never printed; no other secret is read. Testnet only.
# Variables: CHALLENGE_OWNER (erfan-airlock.testnet), CHALLENGE_POLICY (challenge.erfan-airlock.testnet), CHALLENGE_AGENT (erfan-agent.testnet),
# CHALLENGE_AGENT_CREDENTIALS (~/.near-credentials/testnet/<agent>.json), CHALLENGE_FUND_NEAR (25), CHALLENGE_KEY_ALLOWANCE (1 NEAR),
# CHALLENGE_ENV_FILE, CHALLENGE_TASK_KEY_FILE (~/.airlock-challenge-task-key). Test hooks (scripts/test-challenge-setup.sh): NEAR,
# CHALLENGE_DEPLOY_SCRIPT, CHALLENGE_BOOTSTRAP_SCRIPT.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NEAR="${NEAR:-near}"
DRY=0
case "${1-}" in
  "") ;;
  --dry-run) DRY=1 ;;
  *) echo "usage: scripts/challenge-setup.sh [--dry-run]" >&2; exit 2 ;;
esac
[ "$#" -le 1 ] || { echo "usage: scripts/challenge-setup.sh [--dry-run]" >&2; exit 2; }

OWNER="${CHALLENGE_OWNER:-erfan-airlock.testnet}"
POLICY="${CHALLENGE_POLICY:-challenge.erfan-airlock.testnet}"
AGENT="${CHALLENGE_AGENT:-erfan-agent.testnet}"
CREDS="${CHALLENGE_AGENT_CREDENTIALS:-$HOME/.near-credentials/testnet/$AGENT.json}"
FUND="${CHALLENGE_FUND_NEAR:-25}"
ALLOWANCE="${CHALLENGE_KEY_ALLOWANCE:-1 NEAR}"
ENV_FILE="${CHALLENGE_ENV_FILE:-$HOME/.airlock-challenge.env}"
TASK_KEY_FILE="${CHALLENGE_TASK_KEY_FILE:-$HOME/.airlock-challenge-task-key}"
DEPLOY="${CHALLENGE_DEPLOY_SCRIPT:-$ROOT/scripts/deploy-testnet.sh}"
BOOTSTRAP="${CHALLENGE_BOOTSTRAP_SCRIPT:-$ROOT/scripts/bootstrap-policy.sh}"
WASM="$ROOT/contracts/airlock-policy/res/airlock_policy.wasm"
POLICY_FILE="$ROOT/challenge/policy.challenge.json"

die() { echo "$1" >&2; exit 1; }
refuse() { echo "REFUSED: $1" >&2; exit 2; }

# ---- inputs, checked before any call ----
for c in jq node curl; do command -v "$c" > /dev/null || refuse "$c not found"; done
for v in "$OWNER" "$POLICY" "$AGENT"; do
  case "$v" in *.testnet) ;; *) refuse "'$v' is not a .testnet account" ;; esac
done
case "$POLICY" in *."$OWNER") ;; *) refuse "$POLICY is not a sub-account of $OWNER" ;; esac
[ -f "$WASM" ] || refuse "$WASM is missing"
[ -f "$POLICY_FILE" ] || refuse "$POLICY_FILE is missing"
[[ "$FUND" =~ ^[0-9]+$ ]] || refuse "CHALLENGE_FUND_NEAR must be a whole number of NEAR"
[[ "$ALLOWANCE" =~ ^[0-9]+(\.[0-9]+)?\ NEAR$ ]] || refuse "CHALLENGE_KEY_ALLOWANCE must look like '1 NEAR'"
if [ "$DRY" = "0" ]; then
  command -v "$NEAR" > /dev/null || refuse "near CLI not found"
  [ ! -e "$ENV_FILE" ] || refuse "$ENV_FILE exists; move it away first (this script never overwrites an env file)"
  [ -f "$CREDS" ] || refuse "the agent credentials file $CREDS is missing"
  [ "$(jq -r '.account_id // empty' "$CREDS" 2> /dev/null)" = "$AGENT" ] || refuse "$CREDS is not the credentials file of $AGENT"
fi

# the accounts file the two scripts read: the challenge policy is the policy, the demo payees are the ones policy-v2 books
ACCTS_DIR="$(mktemp -d)"
trap 'rm -rf "$ACCTS_DIR"' EXIT
jq -n --arg o "$OWNER" --arg p "$POLICY" --arg a "$AGENT" \
  '{owner:$o, policy:$p, agent:$a, accountant:("accountant." + $o), landlord:("landlord." + $o), sam:("sam." + $o), contractor_evm:"0x0000000000000000000000000000000000000001"}' > "$ACCTS_DIR/accounts.json"

echo "challenge setup (testnet)"
echo "  owner            $OWNER"
echo "  policy account   $POLICY (new sub-account, funded with $FUND NEAR)"
echo "  agent            $AGENT"
echo "  published key    function-call, receiver $POLICY, method submit_batch, allowance $ALLOWANCE"
echo "  policy fixture   challenge/policy.challenge.json (NEAR only, 5 NEAR per request, 10 NEAR per day)"
echo "  env file         $ENV_FILE (mode 600)"
echo "  task key file    $TASK_KEY_FILE"

deploy() {
  AIRLOCK_ACCOUNTS_FILE="$ACCTS_DIR/accounts.json" AIRLOCK_RES_DIR="$ACCTS_DIR/res" AIRLOCK_SKIP_BUILD=1 AIRLOCK_WASM_SRC="$WASM" "$DEPLOY" "$@"
}

if [ "$DRY" = "1" ]; then
  echo "DRY RUN: the deploy script's own dry run follows (a balance read only; before the account exists it reports the shortfall)"
  deploy --dry-run || true
  echo "DRY RUN: nothing signed, nothing sent, no key made, no file written"
  exit 0
fi

# ---- 1. the sub-account ----
exists="$("$NEAR" account view-account-summary "$POLICY" network-config testnet now 2> /dev/null | grep -c "$POLICY" || true)"
if [ "$exists" = "0" ]; then
  echo "step 1: create $POLICY"
  "$NEAR" account create-account fund-myself "$POLICY" "$FUND NEAR" autogenerate-new-keypair save-to-keychain sign-as "$OWNER" network-config testnet sign-with-keychain send > /dev/null 2>&1 || die "FAILED: create-account $POLICY"
else
  echo "step 1: $POLICY already exists, kept"
fi

# ---- 2. deploy ----
echo "step 2: deploy"
deploy > /dev/null || die "FAILED: deploy (run it again with output: AIRLOCK_ACCOUNTS_FILE=... scripts/deploy-testnet.sh)"

# ---- 3. configure ----
echo "step 3: configure the policy"
if [ ! -f "$TASK_KEY_FILE" ]; then
  AIRLOCK_TASK_KEY_FILE="$TASK_KEY_FILE" node "$ROOT/scripts/task-key.mjs" init > /dev/null || die "FAILED: task key init"
fi
TASK_PUB="$(AIRLOCK_TASK_KEY_FILE="$TASK_KEY_FILE" node "$ROOT/scripts/task-key.mjs" pubkey)" || die "FAILED: task key pubkey"
AIRLOCK_ACCOUNTS_FILE="$ACCTS_DIR/accounts.json" AIRLOCK_POLICY_FILE="$POLICY_FILE" TASK_PUBLIC_KEY="$TASK_PUB" NEAR="$NEAR" "$BOOTSTRAP" > "$ACCTS_DIR/bootstrap.out" 2>&1 || { tail -12 "$ACCTS_DIR/bootstrap.out" >&2; die "FAILED: bootstrap"; }

# ---- 4. the published key ----
echo "step 4: the published function-call key"
PAIR="$(node "$ROOT/scripts/challenge-keygen.mjs")" || die "FAILED: key generation"
PUB="$(printf '%s' "$PAIR" | jq -r .public)"
SECRET="$(printf '%s' "$PAIR" | jq -r .secret)"
[ -n "$PUB" ] && [ -n "$SECRET" ] || die "FAILED: key generation gave no key"
"$NEAR" account add-key "$AGENT" grant-function-call-access --allowance "$ALLOWANCE" --receiver-account-id "$POLICY" --method-names submit_batch use-manually-provided-public-key "$PUB" network-config testnet sign-with-keychain send > /dev/null 2>&1 || die "FAILED: add-key $AGENT"

# ---- 5. the env file ----
echo "step 5: write $ENV_FILE"
umask 077
{
  echo "# AIR-301 challenge environment, written by scripts/challenge-setup.sh on $(date -u +%Y-%m-%dT%H:%M:%SZ). Outside the repo, mode 600."
  echo "CHALLENGE_MODE=live"
  echo "CHALLENGE_POLICY_ACCOUNT=$POLICY"
  echo "CHALLENGE_OWNER_ACCOUNT=$OWNER"
  echo "CHALLENGE_AGENT_ACCOUNT=$AGENT"
  echo "CHALLENGE_AGENT_CREDENTIALS=$CREDS"
  echo "CHALLENGE_TASK_KEY_FILE=$TASK_KEY_FILE"
  echo "CHALLENGE_KEY_PUBLIC=$PUB"
  echo "CHALLENGE_KEY_SECRET=$SECRET"
  echo "CHALLENGE_KEY_ALLOWANCE='$ALLOWANCE'"
  echo "CHALLENGE_LLM_CAP_USD=1.00"
  echo "CHALLENGE_NEAR_DAILY_CAP=10"
  echo "CHALLENGE_NEAR_FLOAT_MIN=5"
  echo "# the visitor is the socket address; behind a proxy replace the next line with CHALLENGE_PROXY_HEADER and CHALLENGE_TRUSTED_PROXIES"
  echo "CHALLENGE_DIRECT=1"
  echo "LLM_MODE=live"
  echo "# add NEARAI_API_KEY here (the model key); this script does not know it"
} > "$ENV_FILE"
chmod 600 "$ENV_FILE"

AIRLOCK_ACCOUNTS_FILE="$ACCTS_DIR/accounts.json" AIRLOCK_POLICY_FILE="$POLICY_FILE" TASK_PUBLIC_KEY="$TASK_PUB" NEAR="$NEAR" "$BOOTSTRAP" --verify | tail -3
echo "CHALLENGE SETUP DONE $POLICY"
echo "next: add NEARAI_API_KEY to $ENV_FILE, then: set -a; . $ENV_FILE; set +a; pnpm challenge"
echo "note: $POLICY still has the full-access key that create-account saved to the keychain. For the public run, delete it so nobody can redeploy"
echo "      the contract: near account delete-key $POLICY <public key from: near account list-keys $POLICY network-config testnet now>"
