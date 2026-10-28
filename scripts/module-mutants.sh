#!/usr/bin/env bash
# Usage: scripts/module-mutants.sh [table]   (default scripts/canary/module-mutants.txt)
# Table rows: `id @@ file @@ perl substitution @@ harness substring @@ expected failure text` (`#` lines and blanks ignored).
# A clean control run of every harness named in the table must verify first. Then each row is applied to the scratch copy
# (restored between rows) and `cargo kani --harness <substring>` must report a check with `Status: FAILURE` whose
# Description contains the expected text (a timeout or a compile error also ends in FAILED and must not count as a kill).
set -u
cd "$(dirname "$0")/.."
source scripts/env.sh
TABLE="${1:-scripts/canary/module-mutants.txt}"
CRATE="${MUTANT_CRATE:-contracts/airlock-verdict}"
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
mkdir -p "$T/crate"
cp -R "$CRATE/Cargo.toml" "$CRATE/rust-toolchain.toml" "$CRATE/src" "$T/crate/"
[ -f "$CRATE/Cargo.lock" ] && cp "$CRATE/Cargo.lock" "$T/crate/"
export CARGO_TARGET_DIR="$T/target"      # one target dir per scratch copy: two copies of one package must never share a build
rows=$(grep -vE '^(#|[[:space:]]*$)' "$TABLE")
[ -n "$rows" ] || { echo "MODULE MUTANTS FAILED (empty table)"; exit 1; }
flags=""
for h in $(printf '%s\n' "$rows" | awk -F' @@ ' '{print $4}' | sort -u); do flags="$flags --harness $h"; done
ctl=$(cd "$T/crate" && cargo kani $flags 2>&1)
printf '%s\n' "$ctl" | grep -qE '^Complete - [1-9][0-9]* successfully verified harnesses, 0 failures' \
  || { printf '%s\n' "$ctl" | tail -5; echo "MODULE MUTANTS FAILED (the clean control run does not verify)"; exit 1; }
bad=0; n=0
while IFS= read -r line; do
  id=${line%% @@ *}; rest=${line#* @@ }
  file=${rest%% @@ *}; rest=${rest#* @@ }
  expr=${rest%% @@ *}; rest=${rest#* @@ }
  harness=${rest%% @@ *}; frag=${rest#* @@ }
  n=$((n + 1))
  cp "$CRATE/src/$file" "$T/crate/src/$file"
  perl -0pi -e "$expr" "$T/crate/src/$file"
  if cmp -s "$CRATE/src/$file" "$T/crate/src/$file"; then echo "$id NOT APPLIED (the expression matched nothing in $file)"; bad=1; continue; fi
  out=$(cd "$T/crate" && cargo kani --harness "$harness" 2>&1)
  if printf '%s\n' "$out" | awk -v f="$frag" '/Status: FAILURE/ {w=1; next} w && /Description:/ {if (index($0, f)) found=1; w=0} END {exit !found}'; then
    echo "$id killed by $harness ($frag)"
  else echo "$id SURVIVED $harness (no FAILURE check containing: $frag)"; bad=1; fi
done <<< "$rows"
[ "$bad" -eq 0 ] && echo "MODULE MUTANTS OK ($n killed)" || { echo "MODULE MUTANTS FAILED"; exit 1; }
