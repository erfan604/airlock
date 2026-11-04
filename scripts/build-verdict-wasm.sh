#!/usr/bin/env bash
# AIR-311: builds contracts/airlock-verdict-wasm for wasm32-unknown-unknown (release, Rust 1.86 from the crate's rust-toolchain.toml) and
# writes it to web/public/verdict.wasm, the module the console's Try page runs. --check builds into a separate target folder, writes
# nothing, and exits 1 unless the fresh build is byte for byte the committed file. Last line `VERDICT WASM OK <sha256>` (also with
# --check) or `VERDICT WASM MISMATCH committed <sha> fresh <sha>`.
# Usage: scripts/build-verdict-wasm.sh [--check]
set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck disable=SC1091
source scripts/env.sh
MODE=${1:-build}
case "$MODE" in build | --check) ;; *) echo "usage: scripts/build-verdict-wasm.sh [--check]" >&2; exit 2 ;; esac
OUT=web/public/verdict.wasm
TARGET="${CARGO_TARGET_DIR:-$PWD/target}/verdict-wasm"
(cd contracts/airlock-verdict-wasm && cargo build -q --release --target wasm32-unknown-unknown --target-dir "$TARGET")
BUILT="$TARGET/wasm32-unknown-unknown/release/airlock_verdict_wasm.wasm"
fresh=$(shasum -a 256 "$BUILT" | cut -d' ' -f1)
if [ "$MODE" = --check ]; then
  [ -f "$OUT" ] || { echo "VERDICT WASM MISMATCH committed missing fresh $fresh"; exit 1; }
  committed=$(shasum -a 256 "$OUT" | cut -d' ' -f1)
  if [ "$committed" != "$fresh" ]; then echo "VERDICT WASM MISMATCH committed $committed fresh $fresh"; exit 1; fi
else
  cp "$BUILT" "$OUT"
fi
echo "VERDICT WASM OK $fresh"
