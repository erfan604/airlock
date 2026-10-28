# Source me: toolchain env for compiling NEAR contracts with C dependencies (ring) on macOS.
export PATH="$HOME/.cargo/bin:$HOME/.elan/bin:$PATH"   # cargo, rustup, lake and lean
# Node 24 and its pnpm (the default shell has Node 22 and no pnpm); same lines as doctor.sh
export NVM_DIR="$HOME/.nvm"; [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" >/dev/null && nvm use 24 >/dev/null 2>&1
if [ -x /opt/homebrew/opt/llvm/bin/clang ]; then
  export CC_wasm32_unknown_unknown=/opt/homebrew/opt/llvm/bin/clang
  export AR_wasm32_unknown_unknown=/opt/homebrew/opt/llvm/bin/llvm-ar
fi
export CFLAGS_wasm32_unknown_unknown="-mcpu=mvp"
# One Cargo target dir per worktree, under ~/.cache/airlock-target/<worktree folder> (P is airlock, lanes airlock-lane<N>).
# Never one dir for all worktrees: cargo hashes path crates relative to the workspace, so two worktrees with the same layout
# share build outputs, and a lane whose sources are older than the other lane's artifacts runs the other lane's test binary
# without recompiling (reproduced 2026-10-26). A CARGO_TARGET_DIR set before sourcing (mutant copies, fresh clone) wins.
_airlock_top="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$HOME/.cache/airlock-target/$(basename "$_airlock_top")}"
unset _airlock_top
# research repo with the plan, dossiers and tickets (private, local only); tickets reference paths relative to it
export AIRLOCK_RESEARCH="${AIRLOCK_RESEARCH:-$HOME/apps/airlock-research}"
# node:test prints its summary as TAP ("# fail 0", the form every ticket checks); Node 24's default reporter prints
# "ℹ fail 0" even when piped. Plain node runs ignore this option.
case " ${NODE_OPTIONS:-} " in *" --test-reporter="*) ;; *) export NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--test-reporter=tap";; esac
# neard for the contract sandbox tests (near-sandbox 0.3.9 expects neard 2.11.0): reuse a cached copy instead of a 67 MB download
SANDBOX_BIN="$HOME/.cache/airlock-sandbox/near-sandbox-2.11.0/near-sandbox"
# an if, not `[ ... ] && export`: as the last line that form makes `source scripts/env.sh` return 1 when the cache is missing,
# and every `source scripts/env.sh && ...` check would then stop there
if [ -x "$SANDBOX_BIN" ]; then export NEAR_SANDBOX_BIN_PATH="$SANDBOX_BIN"; fi
