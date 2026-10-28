#!/usr/bin/env bash
# AIR-029: end-to-end tests of scripts/kani-check.sh on small probe crates with the real Kani (about 4 s): a run that fails by design
# is still parsed and its nine problems printed (case 1), a clean run prints the KANI OK line (case 2), KANI_CRATE and a relative
# KANI_CHECK_LOG are honoured, and a stray KANI_LOG (Kani's own logging filter) is not passed on to Kani, whose warning would otherwise
# become line 1 of the log and read as "kani version is not 0.68". Needs cargo kani 0.68 (scripts/env.sh adds ~/.cargo/bin).
# Usage: scripts/test-kani-check.sh
# Last line: KANI CHECK TESTS OK <n>
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$here/.." && pwd)"
fail() { echo "FAIL $1: $2"; exit 1; }
N=0
W="$(mktemp -d)"; trap 'rm -rf "$W" "$ROOT/target/test-kani-check.log"; rmdir "$ROOT/target" 2>/dev/null || true' EXIT
export CARGO_TARGET_DIR="$W/target"
mkdir -p "$ROOT/target"
run() {   # run <crate dir> <toml>: copies the toml into the crate, runs the wrapper with a relative KANI_CHECK_LOG and a stray KANI_LOG; sets OUT and RC
  cp "$2" "$1/harnesses.toml"
  set +e; OUT="$(cd "$ROOT" && KANI_CRATE="$1" KANI_CHECK_LOG=target/test-kani-check.log KANI_LOG=target/x.log scripts/kani-check.sh 2>&1)"; RC=$?; set -e
}

# case 1: the full probe crate (eight harnesses, five of them wrong on purpose): the same nine lines as the fixture log
cp -R "$here/fixtures/kani-probe" "$W/full"
run "$W/full" "$here/fixtures/kani-probe.toml"
WANT="$(python3 "$here/kani_parse.py" "$here/fixtures/kani-probe.log" "$here/fixtures/kani-probe.toml" || true)"
[ "$RC" -eq 1 ] || fail full "exit $RC, want 1: $OUT"
[ "$(printf '%s\n' "$WANT" | wc -l | tr -d ' ')" -eq 9 ] || fail full "the fixture log no longer gives nine lines: $WANT"
[ "$OUT" = "$WANT" ] || fail full "output differs from the fixture run. want: $WANT / got: $OUT"
head -1 "$ROOT/target/test-kani-check.log" | grep -q '^Kani Rust Verifier 0\.68\.' || fail full "log line 1 is not the Kani banner (the relative KANI_CHECK_LOG must be written to the repo root, and a stray KANI_LOG must not reach Kani)"
N=$((N + 1))

# case 2: a crate with the two clean harnesses only
mkdir -p "$W/ok/src"; cp "$here/fixtures/kani-probe/Cargo.toml" "$W/ok/Cargo.toml"
{ sed -n '1,5p' "$here/fixtures/kani-probe/src/lib.rs"; sed -n '/fn ok_with_cover/,/^    }$/p;/fn expected_failure/p' "$here/fixtures/kani-probe/src/lib.rs"; echo '}'; } > "$W/ok/src/lib.rs"
run "$W/ok" "$here/fixtures/kani-probe-ok.toml"
[ "$RC" -eq 0 ] || fail clean "exit $RC, want 0: $OUT"
[ "$OUT" = "KANI OK: 2 harnesses, 2 covers satisfied, 1 should_panic failed at the expected property" ] || fail clean "output: $OUT"
N=$((N + 1))

echo "KANI CHECK TESTS OK $N"
