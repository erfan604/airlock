#!/usr/bin/env bash
# AIR-029: runs every Kani harness of the verdict crate and fails on a vacuous or wrongly failing proof, not only on a failed run.
# cargo kani stays SUCCESSFUL when a cover is unsatisfiable and when a should_panic harness fails at the wrong assertion, so the
# whole log goes to scripts/kani_parse.py with contracts/airlock-verdict/harnesses.toml (see its header for what it names).
# A failing run is still parsed (`|| true`), so every problem is listed at once. Prints the KANI OK summary line or the problems.
# Usage: scripts/kani-check.sh   (the repo root is the parent of this script's folder)
# Overrides, for the tests: KANI_CRATE=<crate dir, default contracts/airlock-verdict> and KANI_CHECK_LOG=<log file, default target/kani.log>
# (a relative path is taken from the repo root). Not KANI_LOG: Kani reads that name itself, see below.
# Exit 0 clean, 1 on any problem (the status of kani_parse.py). Bash 3.2 compatible (macOS /bin/bash).
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$here/.."
mkdir -p target
LOG="${KANI_CHECK_LOG:-$PWD/target/kani.log}"
CRATE="${KANI_CRATE:-contracts/airlock-verdict}"
case "$LOG" in /*) ;; *) LOG="$PWD/$LOG";; esac   # the run below happens inside the crate, so a relative log path would land there
# Kani reads KANI_LOG as its tracing filter: any value there that is not a filter makes it print a warning before its banner, and the
# parser reads the banner on line 1 (reproduced 2026-10-26: "kani version is not 0.68: warning: some trace filter directives").
unset KANI_LOG
# shellcheck disable=SC1091
source scripts/env.sh
(cd "$CRATE" && cargo kani > "$LOG" 2>&1) || true
python3 scripts/kani_parse.py "$LOG" "$CRATE/harnesses.toml"
