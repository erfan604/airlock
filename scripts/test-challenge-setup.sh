#!/usr/bin/env bash
# AIR-301: offline tests of scripts/challenge-setup.sh and scripts/challenge-keygen.mjs. A scratch bin dir holds a fake `near` that logs one line
# per call (arguments joined by `|`) in $FAKE_LOG, and the deploy and bootstrap scripts are replaced by stubs through the script's test hooks. No
# network, no key, no signing. Cases: dry_run_sends_nothing, refusals, full_run_order, door_a_key_and_file, env_file_mode_and_content,
# overrides (CHALLENGE_FUND_NEAR, CHALLENGE_NEAR_FLOAT_MIN), secret_never_printed, env_file_passes_live_config, keygen_form. Last line: CHALLENGE SETUP TESTS OK
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
# list-keys: answer with the keys that earlier add-key calls gave (FAKE_NOKEYS=1: an empty chain)
if [ "${1-}" = account ] && [ "${2-}" = list-keys ] && [ -z "${FAKE_NOKEYS-}" ]; then
  grep '^near|account|add-key' "$FAKE_LOG" | awk -F'|' '{ for (i = 1; i <= NF; i++) if ($i == "--contract-account-id") c = $(i+1); for (i = 1; i <= NF; i++) if ($i == "use-manually-provided-public-key") k = $(i+1); print "| 1 | " k " | 1 | only do [\"submit_batch\"] function calls on " c " with an allowance of 1 NEAR |" }'
fi
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
CRED_DIR="$T/home/.near-credentials/testnet/erfan-agent.testnet"

run() {   # run <args...>: the script under the hooks, output in $T/out, exit code returned
  env PATH="$T/bin:$PATH" HOME="$T/home" NEAR="$T/bin/near" CHALLENGE_DEPLOY_SCRIPT="$T/deploy.sh" CHALLENGE_BOOTSTRAP_SCRIPT="$T/bootstrap.sh" \
    CHALLENGE_ENV_FILE="$T/home/env" CHALLENGE_TASK_KEY_FILE="$T/home/task-key" "$@" > "$T/out" 2>&1
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
echo old > "$T/home/old-creds.json"
run env CHALLENGE_AGENT_CREDENTIALS="$T/home/old-creds.json" "$SETUP"; [ $? -eq 2 ] || fail refusals "an existing credentials file not refused"
[ "$(cat "$T/home/old-creds.json")" = old ] || fail refusals "an existing credentials file was touched"
run env CHALLENGE_AGENT_CREDENTIALS="$ROOT/inside-repo.json" "$SETUP"; [ $? -eq 2 ] || fail refusals "a credentials path inside the repo not refused"
run env CHALLENGE_AGENT_CREDENTIALS="relative.json" "$SETUP"; [ $? -eq 2 ] || fail refusals "a relative credentials path not refused"
run env CHALLENGE_FUND_NEAR=abc "$SETUP" --dry-run; [ $? -eq 2 ] || fail refusals "a bad fund amount not refused"
run env CHALLENGE_FUND_NEAR=0 "$SETUP" --dry-run; [ $? -eq 2 ] || fail refusals "a zero fund amount not refused"
run env CHALLENGE_NEAR_FLOAT_MIN=lots "$SETUP" --dry-run; [ $? -eq 2 ] || fail refusals "a bad float minimum not refused"
run env CHALLENGE_SERVICE_KEY_ALLOWANCE='lots' "$SETUP" --dry-run; [ $? -eq 2 ] || fail refusals "a bad service allowance not refused"
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
# account lookup (near), create-account (near), code hash lookup (near), deploy, bootstrap, add-key door a, add-key door b, list-keys (near), bootstrap --verify
[ "$order" = "near near near deploy bootstrap near near near bootstrap " ] || fail full_run_order "order was: $order"
sed -n 1p "$FAKE_LOG" | grep -q '^near|account|view-account-summary' || fail full_run_order "the first call should look up the account"
grep -q 'create-account|fund-myself|challenge.erfan-airlock.testnet|25 NEAR|autogenerate-new-keypair|save-to-keychain|sign-as|erfan-airlock.testnet|network-config|testnet|sign-with-keychain|send' "$FAKE_LOG" || fail full_run_order "create-account call"
[ "$(grep -c 'add-key|erfan-agent.testnet|grant-function-call-access|--allowance|1 NEAR|--contract-account-id|challenge.erfan-airlock.testnet|--function-names|submit_batch|use-manually-provided-public-key|ed25519:.*|network-config|testnet|sign-with-keychain|send' "$FAKE_LOG")" = 2 ] || fail full_run_order "want two add-key calls (door a and door b), each submit_batch only, contract the challenge policy, 1 NEAR, keychain"
grep -q -- '--receiver-account-id\|--method-names' "$FAKE_LOG" && fail full_run_order "add-key used flags near-cli-rs 0.30.1 does not have"
grep -q '^deploy|.*accounts=challenge.erfan-airlock.testnet|skip=1' "$FAKE_LOG" || fail full_run_order "deploy not on the challenge account with the committed wasm"
grep -q '^bootstrap||policy=challenge.erfan-airlock.testnet|file=policy.challenge.json|taskkey=ed25519:' "$FAKE_LOG" || fail full_run_order "bootstrap not given the challenge policy and its own task key"
grep -q '^bootstrap|--verify' "$FAKE_LOG" || fail full_run_order "no verify"
[ -s "$T/home/task-key" ] || fail full_run_order "no task key seed written"

# door a: a separate key from door b, its credentials file outside the repo, mode 600, account_id set, saved under the agent's directory
pubs="$(grep '^near|account|add-key' "$FAKE_LOG" | sed -E 's/.*use-manually-provided-public-key\|(ed25519:[^|]*)\|.*/\1/')"
pub_a="$(printf '%s\n' "$pubs" | sed -n 1p)"; pub_b="$(printf '%s\n' "$pubs" | sed -n 2p)"
[ -n "$pub_a" ] && [ "$pub_a" != "$pub_b" ] || fail door_a_key_and_file "door a and door b keys are not two different keys"
[ "$pub_b" = "$(sed -n 's/^CHALLENGE_KEY_PUBLIC=//p' "$T/home/env")" ] || fail door_a_key_and_file "door b is not the published key"
creds="$CRED_DIR/${pub_a/:/_}.json"
[ -f "$creds" ] || fail door_a_key_and_file "no credentials file at $creds"
cmode="$(stat -f '%Lp' "$creds" 2> /dev/null || stat -c '%a' "$creds")"; [ "$cmode" = "600" ] || fail door_a_key_and_file "credentials mode is $cmode"
dmode="$(stat -f '%Lp' "$CRED_DIR" 2> /dev/null || stat -c '%a' "$CRED_DIR")"; [ "$dmode" = "700" ] || fail door_a_key_and_file "credentials directory mode is $dmode"
[ "$(jq -r .account_id "$creds")" = "erfan-agent.testnet" ] && [ "$(jq -r .public_key "$creds")" = "$pub_a" ] || fail door_a_key_and_file "credentials account_id or public_key"
jq -r .private_key "$creds" | grep -q '^ed25519:' || fail door_a_key_and_file "credentials private_key form"
[ "$(sed -n 's/^CHALLENGE_AGENT_CREDENTIALS=//p' "$T/home/env")" = "$creds" ] || fail door_a_key_and_file "env file does not point at the door a credentials file"
secret_a="$(jq -r .private_key "$creds")"
[ "$secret_a" != "$(sed -n 's/^CHALLENGE_KEY_SECRET=//p' "$T/home/env")" ] || fail door_a_key_and_file "door a and door b share a secret"
grep -qF "$secret_a" "$T/home/env" && fail door_a_key_and_file "door a secret in the env file"
grep -qF "$secret_a" "$T/out" && fail door_a_key_and_file "door a secret in the output"
grep -qF "$secret_a" "$FAKE_LOG" && fail door_a_key_and_file "door a secret in a call"
grep -q 'verified: door a and door b are on erfan-agent.testnet' "$T/out" || fail door_a_key_and_file "no read-back line"

# a second run (env file moved away) makes new keys and never touches the first credentials file
before="$(cat "$creds")"
mv "$T/home/env" "$T/home/env.1"
: > "$FAKE_LOG"
run "$SETUP" || fail door_a_key_and_file "second run exit $?"
[ "$(cat "$creds")" = "$before" ] || fail door_a_key_and_file "the first credentials file changed"
[ "$(ls "$CRED_DIR" | wc -l | tr -d ' ')" = 2 ] || fail door_a_key_and_file "second run did not make its own credentials file"

# the chain does not show the keys: the script refuses and says so
mv "$T/home/env" "$T/home/env.2"
run env FAKE_NOKEYS=1 "$SETUP"; [ $? -ne 0 ] || fail door_a_key_and_file "missing keys on chain not detected"
grep -q 'FAILED: key .* is not on erfan-agent.testnet' "$T/out" || fail door_a_key_and_file "no mismatch message"
rm -f "$T/home/env"
mv "$T/home/env.1" "$T/home/env"

# overrides end to end: fund 15, float minimum 3, own credentials path, own service allowance
: > "$FAKE_LOG"
mv "$T/home/env" "$T/home/env.keep"
run env CHALLENGE_FUND_NEAR=15 CHALLENGE_NEAR_FLOAT_MIN=3 CHALLENGE_AGENT_CREDENTIALS="$T/home/own/door-a.json" CHALLENGE_SERVICE_KEY_ALLOWANCE='2 NEAR' "$SETUP" || { tail -5 "$T/out"; fail overrides "exit $?"; }
grep -q 'create-account|fund-myself|challenge.erfan-airlock.testnet|15 NEAR|' "$FAKE_LOG" || fail overrides "fund 15 not used"
grep -qx 'CHALLENGE_NEAR_FLOAT_MIN=3' "$T/home/env" || fail overrides "float minimum 3 not in the env file"
grep -qx "CHALLENGE_AGENT_CREDENTIALS=$T/home/own/door-a.json" "$T/home/env" || fail overrides "credentials path override not in the env file"
[ -f "$T/home/own/door-a.json" ] || fail overrides "credentials not written at the override path"
grep -q 'add-key|erfan-agent.testnet|grant-function-call-access|--allowance|2 NEAR|' "$FAKE_LOG" || fail overrides "service allowance override not used"
run env CHALLENGE_FUND_NEAR=15 CHALLENGE_NEAR_FLOAT_MIN=3 "$SETUP" --dry-run || fail overrides "dry run exit $?"
grep -q 'funded with 15 NEAR' "$T/out" && grep -q 'float minimum    3 NEAR' "$T/out" || fail overrides "dry run does not show the overrides"
rm -f "$T/home/env"
mv "$T/home/env.keep" "$T/home/env"
rm -f "$T/home/env.2"
: > "$FAKE_LOG"

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
