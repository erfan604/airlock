#!/usr/bin/env bash
# AIR-029: regenerate scripts/fixtures/kani-probe.log (all eight probe harnesses) and kani-probe-ok.log (ok_with_cover and
# expected_failure only) with the pinned Kani, from a copy of scripts/fixtures/kani-probe in a mktemp -d with its own
# CARGO_TARGET_DIR. Run it after a Kani upgrade only (the parser refuses any version but 0.68) and commit both logs.
# The full probe run fails by design (a vacuous proof, a wrong-assertion should_panic and a plain failure), so each run ends
# `|| true`. The output goes through sed because the logs name the scratch directory and the privacy screen (AIR-252) must
# not see a home path. Bash 3.2 compatible (macOS /bin/bash).
# Usage: scripts/fixtures/make-kani-fixtures.sh
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
work="$(mktemp -d)"; trap 'rm -rf "$work"' EXIT
export CARGO_TARGET_DIR="$work/target"   # set before env.sh, which keeps a value that is already set
# shellcheck disable=SC1091
source "$here/../env.sh"
command -v cargo-kani >/dev/null || { echo "cargo-kani not on PATH (scripts/env.sh adds ~/.cargo/bin)"; exit 1; }
cp -R "$here/kani-probe" "$work/probe"
scrub() { sed -E 's#/(Users|private|home|var|tmp)/[^ "]*#/ABS#g'; }
cd "$work/probe"
cargo kani 2>&1 | scrub > "$here/kani-probe.log" || true
cargo kani --harness ok_with_cover --harness expected_failure 2>&1 | scrub > "$here/kani-probe-ok.log" || true
echo "wrote kani-probe.log ($(wc -l < "$here/kani-probe.log" | tr -d ' ') lines) and kani-probe-ok.log ($(wc -l < "$here/kani-probe-ok.log" | tr -d ' ') lines)"
head -1 "$here/kani-probe.log"
