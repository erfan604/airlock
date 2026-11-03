#!/usr/bin/env bash
# AIR-301: set up the Steal this agent challenge on NEAR testnet. The owner runs this once; nothing else creates or deploys the account.
#   scripts/challenge-setup.sh [--dry-run]
# What it does, in order (each step stops the script on failure):
#   1. creates the sub-account CHALLENGE_POLICY (default challenge.erfan-airlock.testnet) from the owner account and funds it
#   2. deploys contracts/airlock-policy/res/airlock_policy.wasm to it with the init call (scripts/deploy-testnet.sh, which checks the code hash)
#   3. configures it with scripts/bootstrap-policy.sh from challenge/policy.challenge.json: NEAR only, 5 NEAR per request, 10 NEAR per day,
#      the three demo payees, a task key of its own (a fresh seed file outside the repo), the agent registered and allowed
#   4. generates TWO fresh function-call keys on the agent account, each with receiver the challenge policy, method submit_batch only:
#        door b, the published key (allowance CHALLENGE_KEY_ALLOWANCE, default 1 NEAR), whose secret goes to the env file only;
#        door a, the service key the live engine signs with (allowance CHALLENGE_SERVICE_KEY_ALLOWANCE, default 1 NEAR), saved as a
#        near-cli credentials file (account_id, public_key, private_key; mode 600, directory mode 700) outside the repo at
#        ~/.near-credentials/testnet/<agent>/ed25519_<public key>.json. The two keys are different; the old keys of the agent are not touched.
#   5. writes the env file for `pnpm challenge` to CHALLENGE_ENV_FILE (default ~/.airlock-challenge.env, mode 600, outside the repo; the
#      script refuses to overwrite an existing one), with CHALLENGE_AGENT_CREDENTIALS pointing at the door a file, reads the agent's keys back
#      from the chain to check both are there with the right receiver and method, and verifies the policy
# --dry-run prints the plan and the deploy dry run (balance and code hash only) and sends nothing, creates no key and writes no file.
# Signing goes through the near CLI's own keychain option (sign-with-keychain; the full-access key of the agent and of the owner live in the
# keychain). The two function-call secret keys are written only to their files (door b to the env file, door a to its credentials file) and are
# never printed; no other secret is read. near-cli-rs 0.30.1 argument forms (checked with `near <subcommand> --help`): add-key takes
# --contract-account-id and --function-names. Testnet only.
# Variables: CHALLENGE_OWNER (erfan-airlock.testnet), CHALLENGE_POLICY (challenge.erfan-airlock.testnet), CHALLENGE_AGENT (erfan-agent.testnet),
# CHALLENGE_AGENT_CREDENTIALS (where the NEW door a credentials file is written; default ~/.near-credentials/testnet/<agent>/ed25519_<pk>.json;
# it must not exist yet and must be outside the repo), CHALLENGE_FUND_NEAR (25; the coordinator uses 15), CHALLENGE_NEAR_FLOAT_MIN (5; the
# coordinator uses 3; written to the env file), CHALLENGE_KEY_ALLOWANCE (1 NEAR), CHALLENGE_SERVICE_KEY_ALLOWANCE (1 NEAR),
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
CREDS="${CHALLENGE_AGENT_CREDENTIALS:-}"   # empty: the default path is built from the door a public key, after it exists
FUND="${CHALLENGE_FUND_NEAR:-25}"
FLOAT_MIN="${CHALLENGE_NEAR_FLOAT_MIN:-5}"
ALLOWANCE="${CHALLENGE_KEY_ALLOWANCE:-1 NEAR}"
SERVICE_ALLOWANCE="${CHALLENGE_SERVICE_KEY_ALLOWANCE:-1 NEAR}"
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
[[ "$FUND" -gt 0 ]] || refuse "CHALLENGE_FUND_NEAR must be above zero"
[[ "$FLOAT_MIN" =~ ^[0-9]+(\.[0-9]+)?$ ]] || refuse "CHALLENGE_NEAR_FLOAT_MIN must be a number of NEAR"
[[ "$ALLOWANCE" =~ ^[0-9]+(\.[0-9]+)?\ NEAR$ ]] || refuse "CHALLENGE_KEY_ALLOWANCE must look like '1 NEAR'"
[[ "$SERVICE_ALLOWANCE" =~ ^[0-9]+(\.[0-9]+)?\ NEAR$ ]] || refuse "CHALLENGE_SERVICE_KEY_ALLOWANCE must look like '1 NEAR'"
# the door a credentials file holds a secret: never inside the repo, never over an existing file
if [ -n "$CREDS" ]; then
  case "$CREDS" in /*) ;; *) refuse "CHALLENGE_AGENT_CREDENTIALS must be an absolute path" ;; esac
  case "$CREDS" in "$ROOT"/*) refuse "CHALLENGE_AGENT_CREDENTIALS is inside the repo" ;; esac
fi
CRED_DIR="$HOME/.near-credentials/testnet/$AGENT"
if [ "$DRY" = "0" ]; then
  command -v "$NEAR" > /dev/null || refuse "near CLI not found"
  [ ! -e "$ENV_FILE" ] || refuse "$ENV_FILE exists; move it away first (this script never overwrites an env file)"
  [ -z "$CREDS" ] || [ ! -e "$CREDS" ] || refuse "$CREDS exists; this script never overwrites a credentials file"
  case "$CRED_DIR" in "$ROOT"/*) refuse "the credentials directory is inside the repo" ;; esac
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
echo "  door b key       published, function-call, receiver $POLICY, method submit_batch, allowance $ALLOWANCE (secret goes to the env file)"
echo "  door a key       service, function-call, receiver $POLICY, method submit_batch, allowance $SERVICE_ALLOWANCE (new, separate from door b)"
echo "  door a creds     ${CREDS:-$CRED_DIR/ed25519_<public key>.json} (mode 600, outside the repo, account_id $AGENT)"
echo "  float minimum    $FLOAT_MIN NEAR (CHALLENGE_NEAR_FLOAT_MIN)"
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
LOCAL_SHA="$(shasum -a 256 "$ROOT/contracts/airlock-policy/res/airlock_policy.wasm" | cut -c1-64)"
if "$NEAR" account view-account-summary "$POLICY" network-config testnet now 2> /dev/null | grep -q "$LOCAL_SHA"; then
  echo "step 2: $POLICY already runs the committed wasm ($LOCAL_SHA), deploy kept"   # a rerun after a later step failed
else
  echo "step 2: deploy"
  deploy > /dev/null || die "FAILED: deploy (run it again with output: AIRLOCK_ACCOUNTS_FILE=... scripts/deploy-testnet.sh)"
fi

# ---- 3. configure ----
echo "step 3: configure the policy"
if [ ! -f "$TASK_KEY_FILE" ]; then
  AIRLOCK_TASK_KEY_FILE="$TASK_KEY_FILE" node "$ROOT/scripts/task-key.mjs" init > /dev/null || die "FAILED: task key init"
fi
TASK_PUB="$(AIRLOCK_TASK_KEY_FILE="$TASK_KEY_FILE" node "$ROOT/scripts/task-key.mjs" pubkey)" || die "FAILED: task key pubkey"
AIRLOCK_ACCOUNTS_FILE="$ACCTS_DIR/accounts.json" AIRLOCK_POLICY_FILE="$POLICY_FILE" TASK_PUBLIC_KEY="$TASK_PUB" NEAR="$NEAR" "$BOOTSTRAP" > "$ACCTS_DIR/bootstrap.out" 2>&1 || { tail -12 "$ACCTS_DIR/bootstrap.out" >&2; die "FAILED: bootstrap"; }

# ---- 4. the published key ----
echo "step 4: the two function-call keys (door b published, door a service)"
PAIR="$(node "$ROOT/scripts/challenge-keygen.mjs")" || die "FAILED: key generation (door b)"
PUB="$(printf '%s' "$PAIR" | jq -r .public)"
SECRET="$(printf '%s' "$PAIR" | jq -r .secret)"
PAIR_A="$(node "$ROOT/scripts/challenge-keygen.mjs")" || die "FAILED: key generation (door a)"
PUB_A="$(printf '%s' "$PAIR_A" | jq -r .public)"
SECRET_A="$(printf '%s' "$PAIR_A" | jq -r .secret)"
PAIR=""; PAIR_A=""
[ -n "$PUB" ] && [ -n "$SECRET" ] && [ -n "$PUB_A" ] && [ -n "$SECRET_A" ] || die "FAILED: key generation gave no key"
[ "$PUB" != "$PUB_A" ] || die "FAILED: door a and door b got the same key"
[ -n "$CREDS" ] || CREDS="$CRED_DIR/${PUB_A/:/_}.json"
[ ! -e "$CREDS" ] || die "FAILED: $CREDS exists; this script never overwrites a credentials file"

# door a: the credentials file first (a failed add-key removes it again), written 600 in a 700 directory
(umask 077; mkdir -p "$(dirname "$CREDS")") || die "FAILED: cannot create $(dirname "$CREDS")"
[ "$(dirname "$CREDS")" != "$CRED_DIR" ] || chmod 700 "$CRED_DIR"
(umask 077; printf '{\n  "account_id": "%s",\n  "public_key": "%s",\n  "private_key": "%s"\n}\n' "$AGENT" "$PUB_A" "$SECRET_A" > "$CREDS") || die "FAILED: cannot write $CREDS"
chmod 600 "$CREDS"
[ "$(jq -r .account_id "$CREDS")" = "$AGENT" ] && [ "$(jq -r .public_key "$CREDS")" = "$PUB_A" ] || { rm -f "$CREDS"; die "FAILED: the credentials file does not read back"; }

add_key() {   # add_key <public key> <allowance>
  "$NEAR" account add-key "$AGENT" grant-function-call-access --allowance "$2" --contract-account-id "$POLICY" --function-names submit_batch use-manually-provided-public-key "$1" network-config testnet sign-with-keychain send > /dev/null 2>&1
}
add_key "$PUB_A" "$SERVICE_ALLOWANCE" || { rm -f "$CREDS"; die "FAILED: add-key $AGENT (door a)"; }
add_key "$PUB" "$ALLOWANCE" || die "FAILED: add-key $AGENT (door b); the door a key is already on the account and its file is $CREDS"

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
  echo "CHALLENGE_NEAR_FLOAT_MIN=$FLOAT_MIN"
  echo "# the visitor is the socket address; behind a proxy replace the next line with CHALLENGE_PROXY_HEADER and CHALLENGE_TRUSTED_PROXIES"
  echo "CHALLENGE_DIRECT=1"
  echo "LLM_MODE=live"
  echo "# add NEARAI_API_KEY here (the model key); this script does not know it"
} > "$ENV_FILE"
chmod 600 "$ENV_FILE"

# read the agent's keys back from the chain: both new keys must be there, function-call, on the challenge policy, submit_batch
KEYS="$("$NEAR" account list-keys "$AGENT" network-config testnet now 2> /dev/null)"
for k in "$PUB_A" "$PUB"; do
  line="$(printf '%s\n' "$KEYS" | grep -F "$k" | head -1)"
  case "$line" in *submit_batch*"$POLICY"*) ;; *) die "FAILED: key $k is not on $AGENT as a submit_batch key for $POLICY" ;; esac
done
echo "verified: door a and door b are on $AGENT (submit_batch on $POLICY)"

AIRLOCK_ACCOUNTS_FILE="$ACCTS_DIR/accounts.json" AIRLOCK_POLICY_FILE="$POLICY_FILE" TASK_PUBLIC_KEY="$TASK_PUB" NEAR="$NEAR" "$BOOTSTRAP" --verify | tail -3
echo "CHALLENGE SETUP DONE $POLICY"
echo "door a credentials: $CREDS (mode 600); door b secret: only in $ENV_FILE"
echo "next: add NEARAI_API_KEY to $ENV_FILE, then: set -a; . $ENV_FILE; set +a; pnpm challenge"
echo "note: $POLICY still has the full-access key that create-account saved to the keychain. For the public run, delete it so nobody can redeploy"
echo "      the contract: near account delete-key $POLICY <public key from: near account list-keys $POLICY network-config testnet now>"
