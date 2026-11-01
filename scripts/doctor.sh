#!/usr/bin/env bash
# Checks every tool and pin the build depends on. Exit 1 if anything is missing or wrong.
set -uo pipefail
export PATH="$HOME/.cargo/bin:$HOME/.elan/bin:$PATH"
export NVM_DIR="$HOME/.nvm"; [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" >/dev/null && nvm use 24 >/dev/null 2>&1
fail=0
check() { # name, command, expected substring
  local out; out=$(eval "$2" 2>&1 | head -1)
  if [[ "$out" == *"$3"* ]]; then printf '  ok    %-22s %s\n' "$1" "$out"; else printf '  FAIL  %-22s got "%s", want "%s"\n' "$1" "$out" "$3"; fail=1; fi
}
echo "AIRLOCK toolchain doctor"
check "rustc 1.86 toolchain" "rustup run 1.86.0 rustc --version" "rustc 1.86.0"
check "wasm32 target (1.86)" "rustup +1.86.0 target list --installed | grep wasm32" "wasm32-unknown-unknown"
check "cargo-near" "cargo near --version" "0.22"
check "kani" "cargo kani --version" "0.68"
check "lean" "lean --version" "4.35"
check "lake on PATH" "command -v lake" "/.elan/bin/lake"
check "rustfmt (1.86)" "rustup run 1.86.0 cargo fmt --version" "rustfmt"
check "clippy (1.86)" "rustup run 1.86.0 cargo clippy --version" "clippy"
check "rustfmt (stable)" "cargo fmt --version" "rustfmt"
check "clippy (stable)" "cargo clippy --version" "clippy"
check "ffmpeg (video)" "ffmpeg -version" "ffmpeg version"
check "ffprobe (video)" "ffprobe -version" "ffprobe version"
check "neard sandbox 2.11.0" "$HOME/.cache/airlock-sandbox/near-sandbox-2.11.0/near-sandbox --version" "2.11.0"
check "llvm clang (wasm)" "/opt/homebrew/opt/llvm/bin/clang --version" "clang version"
check "node 24" "node --version" "v24."
check "pnpm" "pnpm --version" "."
check "near cli" "near --version 2>&1 | grep near-cli-rs" "near-cli-rs"
check "gitleaks" "gitleaks version" "8."
check "gh" "gh --version" "gh version"
check "NEAR AI key (Erfan)" "grep -q '^NEARAI_API_KEY=.\{16,\}' ~/.airlock-research.env 2>/dev/null && echo present || echo 'missing: write NEARAI_API_KEY to ~/.airlock-research.env (research folder, plan/ERFAN_TODO.md, Accounts and keys item 1)'" "present"
check "testnet RPC" "curl -s -m 10 https://rpc.testnet.near.org/status | grep -o '\"chain_id\":\"testnet\"'" "testnet"
check "MPC signer live" "near contract call-function as-read-only v1.signer-prod.testnet version json-args '{}' network-config testnet now 2>&1 | grep -o '\"3\.[0-9.]*\"'" "\"3."
# the signer can be upgraded without notice. Accepted: the code hashes of releases 3.17.0, 3.17.1, 3.17.2 (recomputed from
# the near/mpc release wasm on 2026-10-24) and 3.18.0 (live since 2026-10-30, recomputed 2026-11-01; it removes only the
# latest_key_version view, sign args, deposit, gas and response are unchanged). A FAIL here means a
# release outside that set: re-check the sign request shape and gas in kit CLAUDE.md "Toolchain facts" before trusting a demo run
check "MPC signer code 3.17.x/3.18.0" "curl -s -m 10 -A airlock https://test.rpc.fastnear.com -H 'content-type: application/json' -d '{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"query\",\"params\":{\"request_type\":\"view_account\",\"finality\":\"final\",\"account_id\":\"v1.signer-prod.testnet\"}}' | grep -oE 'DAE5ng4ZFR2ctMx9SizQBqmGkVbKUutgZ4ZECD4R8Sm9|DrZ9PnDATDW5G9UiMUveLrnkCaHSNJAtWCRkW5Yg4qtX|Dg8Pt8mkGxnpFAUSWHoji95Ss8g3yeF6gz3FjMuzp4ZX|CpGX8ywXJwvWPgZFDDCTCuPJBHF7BATT51gSfc3APERJ' | head -1 | grep -c ." "1"
df -h /System/Volumes/Data | awk 'NR==2 {print "  disk free: " $4}'
[ $fail -eq 0 ] && echo "DOCTOR: ALL OK" || echo "DOCTOR: fix the FAIL lines"
exit $fail
