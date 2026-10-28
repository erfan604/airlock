#!/usr/bin/env bash
# AIR-103: builds the test-only MPC signer mock (contracts/mock-mpc) with cargo-near and copies the wasm to the policy crate's sandbox
# tests (contracts/airlock-policy/tests/contracts/mock_mpc.wasm), replacing the Shade template's mock, which has no modes, no
# `last_request` and no yield. The wasm is committed so a fresh clone runs the policy sandbox tests without building it; `check.sh full`
# rebuilds it first. This is the only script that names the file: no deploy script may ship the mock.
# Prints one stdout line, `mock_mpc.wasm <n> bytes`; cargo-near's own output goes to stderr.
set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck disable=SC1091
source scripts/env.sh
(cd contracts/mock-mpc && cargo near build non-reproducible-wasm --no-abi) >&2
SRC="${CARGO_TARGET_DIR:-contracts/mock-mpc/target}/near/mock_mpc.wasm"
DST=contracts/airlock-policy/tests/contracts/mock_mpc.wasm
[ -s "$SRC" ] || { echo "build-mock-mpc: $SRC was not written" >&2; exit 1; }
cp "$SRC" "$DST"
echo "mock_mpc.wasm $(wc -c < "$DST" | tr -d ' ') bytes"
