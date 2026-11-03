#!/usr/bin/env bash
# AIR-301: offline tests of scripts/challenge-setup.sh and scripts/challenge-keygen.mjs. A scratch bin dir holds a fake `near` that logs one line
# per call (arguments joined by `|`) in $FAKE_LOG, and the deploy and bootstrap scripts are replaced by stubs through the script's test hooks. No
# network, no key, no signing. Cases: dry_run_sends_nothing, refusals, full_run_order, env_file_mode_and_content, secret_never_printed,
# env_file_passes_live_config, keygen_form. Last line: CHALLENGE SETUP TESTS OK
set -uo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$here/.."
SETUP="$here/challenge-setup.sh"
fail() { echo "FAIL $1: $2"; exit 1; }
[ -x "$SETUP" ] || fail setup "$SETUP is not executable"

T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT
mkdir -p "$T/bin" "$T/home"
cat > "$T/bin/near" <<'EOF'
#!/usr/bin/env bash
{ printf 'near'; for a in "$@"; do printf '|%s' "$a"; done; printf '\n'; } >> "$FAKE_LOG"
exit 0
EOF
cat > "$T/deploy.sh" <<'EOF'
#!/usr/bin/env bash
echo "deploy|$*|accounts=$(jq -r .policy "$AIRLOCK_ACCOUNTS_FILE")|skip=$AIRLOCK_SKIP_BUILD" >> "$FAKE_LOG"
echo "wasm sha256: fake"
EOF
cat > "$T/bootstrap.sh" <<'EOF'
#!/usr/bin/env bash
echo "bootstrap|$*|policy=$(jq -r .policy "$AIRLOCK_ACCOUNTS_FILE")|file=$(basename "$AIRLOCK_POLICY_FILE")|taskkey=$TASK_PUBLIC_KEY" >> "$FAKE_LOG"
echo "POLICY MATCHES fixtures/policy.json"
EOF
chmod +x "$T/bin/near" "$T/deploy.sh" "$T/bootstrap.sh"
export FAKE_LOG="$T/log"
: > "$FAKE_LOG"
echo '{"account_id":"erfan-agent.testnet","public_key":"ed25519:x","private_key":"ed25519:y"}' > "$T/home/creds.json"

run() {   # run <args...>: the script under the hooks, output in $T/out, exit code returned
  env PATH="$T/bin:$PATH" HOME="$T/home" NEAR="$T/bin/near" CHALLENGE_DEPLOY_SCRIPT="$T/deploy.sh" CHALLENGE_BOOTSTRAP_SCRIPT="$T/bootstrap.sh" \
    CHALLENGE_AGENT_CREDENTIALS="$T/home/creds.json" CHALLENGE_ENV_FILE="$T/home/env" CHALLENGE_TASK_KEY_FILE="$T/home/task-key" "$@" > "$T/out" 2>&1
}

# dry_run_sends_nothing
run "$SETUP" --dry-run || fail dry_run_sends_nothing "exit $?"
grep -q 'DRY RUN: nothing signed' "$T/out" || fail dry_run_sends_nothing "no dry run line"
grep -q '^near|' "$FAKE_LOG" && fail dry_run_sends_nothing "near was called"
[ ! -e "$T/home/env" ] && [ ! -e "$T/home/task-key" ] || fail dry_run_sends_nothing "a file was written"
grep -q '^deploy|--dry-run|accounts=challenge.erfan-airlock.testnet|skip=1' "$FAKE_LOG" || fail dry_run_sends_nothing "deploy dry run not run on the challenge account"

# refusals: exit 2 and no near call
: > "$FAKE_LOG"
touch "$T/home/env"
run "$SETUP"; [ $? -eq 2 ] || fail refusals "existing env file not refused"
rm -f "$T/home/env"
run env CHALLENGE_AGENT_CREDENTIALS="$T/home/nope.json" "$SETUP"; [ $? -eq 2 ] || fail refusals "missing credentials not refused"
echo '{"account_id":"someone-else.testnet"}' > "$T/home/other.json"
run env CHALLENGE_AGENT_CREDENTIALS="$T/home/other.json" "$SETUP"; [ $? -eq 2 ] || fail refusals "credentials of another account not refused"
run env CHALLENGE_POLICY=other.testnet "$SETUP" --dry-run; [ $? -eq 2 ] || fail refusals "a policy that is not a sub-account of the owner not refused"
run env CHALLENGE_KEY_ALLOWANCE='lots' "$SETUP" --dry-run; [ $? -eq 2 ] || fail refusals "a bad allowance not refused"
run env CHALLENGE_POLICY=challenge.erfan-airlock.near "$SETUP" --dry-run; [ $? -eq 2 ] || fail refusals "a non testnet account not refused"
run "$SETUP" --nope; [ $? -eq 2 ] || fail refusals "an unknown flag not refused"
grep -q '^near|' "$FAKE_LOG" && fail refusals "near was called by a refused run"

# full run: order of the calls
: > "$FAKE_LOG"
run "$SETUP" || { tail -5 "$T/out"; fail full_run_order "exit $?"; }
grep -q 'CHALLENGE SETUP DONE challenge.erfan-airlock.testnet' "$T/out" || fail full_run_order "no done line"
order="$(sed -E 's/\|.*//' "$FAKE_LOG" | tr '\n' ' ')"
# account lookup (near), create-account (near), deploy, bootstrap, add-key (near), bootstrap --verify
[ "$order" = "near near deploy bootstrap near bootstrap " ] || fail full_run_order "order was: $order"
sed -n 1p "$FAKE_LOG" | grep -q '^near|account|view-account-summary' || fail full_run_order "the first call should look up the account"
grep -q 'create-account|fund-myself|challenge.erfan-airlock.testnet|25 NEAR|autogenerate-new-keypair|save-to-keychain|sign-as|erfan-airlock.testnet|network-config|testnet|sign-with-keychain|send' "$FAKE_LOG" || fail full_run_order "create-account call"
grep -q 'add-key|erfan-agent.testnet|grant-function-call-access|--allowance|1 NEAR|--receiver-account-id|challenge.erfan-airlock.testnet|--method-names|submit_batch|use-manually-provided-public-key|ed25519:' "$FAKE_LOG" || fail full_run_order "add-key call is not submit_batch only, receiver the challenge policy, 1 NEAR"
grep -q '^deploy|.*accounts=challenge.erfan-airlock.testnet|skip=1' "$FAKE_LOG" || fail full_run_order "deploy not on the challenge account with the committed wasm"
grep -q '^bootstrap||policy=challenge.erfan-airlock.testnet|file=policy.challenge.json|taskkey=ed25519:' "$FAKE_LOG" || fail full_run_order "bootstrap not given the challenge policy and its own task key"
grep -q '^bootstrap|--verify' "$FAKE_LOG" || fail full_run_order "no verify"
[ -s "$T/home/task-key" ] || fail full_run_order "no task key seed written"

# env file: mode, content
mode="$(stat -f '%Lp' "$T/home/env" 2> /dev/null || stat -c '%a' "$T/home/env")"
[ "$mode" = "600" ] || fail env_file_mode_and_content "mode is $mode"
for v in CHALLENGE_MODE=live CHALLENGE_POLICY_ACCOUNT=challenge.erfan-airlock.testnet CHALLENGE_OWNER_ACCOUNT=erfan-airlock.testnet CHALLENGE_AGENT_ACCOUNT=erfan-agent.testnet CHALLENGE_LLM_CAP_USD=1.00 CHALLENGE_NEAR_DAILY_CAP=10 CHALLENGE_NEAR_FLOAT_MIN=5 CHALLENGE_DIRECT=1 LLM_MODE=live "CHALLENGE_KEY_ALLOWANCE='1 NEAR'"; do
  grep -qxF "$v" "$T/home/env" || fail env_file_mode_and_content "missing $v"
done
grep -q '^CHALLENGE_KEY_PUBLIC=ed25519:' "$T/home/env" && grep -q '^CHALLENGE_KEY_SECRET=ed25519:' "$T/home/env" || fail env_file_mode_and_content "key lines"
grep -q NEARAI_API_KEY= "$T/home/env" && fail env_file_mode_and_content "the model key must not be written by the script"

# the secret never reaches the output or the call log
secret="$(sed -n 's/^CHALLENGE_KEY_SECRET=//p' "$T/home/env")"
grep -qF "$secret" "$T/out" && fail secret_never_printed "secret in the output"
grep -qF "$secret" "$FAKE_LOG" && fail secret_never_printed "secret in a call"

# the env file satisfies the live configuration of the service
(
  cd "$ROOT/challenge" || exit 1
  set -a; . "$T/home/env"; set +a
  npx tsx -e "import { parseConfig } from './src/config.ts'; const c = parseConfig(process.env, '/repo'); if (c.mode !== 'live' || c.key?.methods.join() !== 'submit_batch' || c.key.receiver !== c.live?.policyAccount || c.limits.nearDailyCapYocto !== '10000000000000000000000000' || c.key.allowance !== '1 NEAR') process.exit(1);"
) || fail env_file_passes_live_config "parseConfig refused the env file"

node "$here/challenge-keygen.mjs" --selftest | grep -q 'challenge keygen ok' || fail keygen_form "selftest"
echo "CHALLENGE SETUP TESTS OK"
