#!/usr/bin/env bash
# AIR-021: runs the checked-in verdict mutants (scripts/canary/*.patch, listed in scripts/canary/mutants.tsv) against the
# Kani harnesses of contracts/airlock-verdict and proves that each harness fails on the bug it exists to catch.
# Usage: scripts/mutants.sh        (from any folder; prints one line per mutant and ends with the verdict line)
# mutants.tsv columns, tab separated: id, patch file (inside scripts/canary), harness name substring or `-`. Several substrings
# separated by a comma mean every one of them must kill the mutant. `-` marks a patch that must survive Kani (its unit tests
# and the differential catch it): it runs the whole crate and every harness must still verify.
# Rules (plan/tickets/AIR-021 Scope, from the cold-start review of AIR-082):
#  (a) every copy of the crate runs cargo kani with its own CARGO_TARGET_DIR, because two copies of one package that share
#      the target directory make Kani reuse a stale build;
#  (b) before any mutant counts, a clean copy runs every harness named in mutants.tsv and must verify (a control, so a broken
#      setup is not read as a kill);
#  (c) a mutant is killed only when the log of its harness says `VERIFICATION:- FAILED` and holds at least one
#      `Status: FAILURE` check, each run under a 300 s timeout, because a timeout or a killed process also prints FAILED and has
#      no failing check. A patch that does not apply or does not compile is reported as BROKEN, never as a kill.
# Each patch is named with a literal path on its own line below (the list is fixed, so the command guard can read every patch).
# Last line: `MUTANTS OK (<k> killed, <s> expected survivor)` and exit 0, or `MUTANTS FAILED (<reason>)` and exit 1.
set -u
cd "$(dirname "$0")/.." || exit 1
# shellcheck disable=SC1091
source scripts/env.sh
unset KANI_LOG   # Kani reads KANI_LOG as its tracing filter, and the version banner must stay on line 1
CRATE=contracts/airlock-verdict
TSV=scripts/canary/mutants.tsv
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
KILLED=0
SURVIVORS=0
BAD=0
RAN=" "

with_timeout() {
  if command -v timeout >/dev/null 2>&1; then timeout 300 "$@"; else perl -e 'alarm 300; exec @ARGV' "$@"; fi
}

# fresh_copy <name>: a clean copy of the crate under $WORK/<name>/contracts/airlock-verdict (repo-root-relative patch paths apply
# inside $WORK/<name>); its target directory is $WORK/<name>/target.
fresh_copy() {
  local d="$WORK/$1"
  mkdir -p "$d/contracts/airlock-verdict"
  cp -R "$CRATE/src" "$d/contracts/airlock-verdict/src"
  cp "$CRATE/Cargo.toml" "$CRATE/rust-toolchain.toml" "$d/contracts/airlock-verdict/"
  if [ -f "$CRATE/Cargo.lock" ]; then cp "$CRATE/Cargo.lock" "$d/contracts/airlock-verdict/"; fi
}

# run_kani <copy name> <log name> [cargo kani arguments]: runs Kani in the copy with its private target directory
run_kani() {
  local d="$WORK/$1" log="$WORK/$2"
  shift 2
  (cd "$d/contracts/airlock-verdict" && CARGO_TARGET_DIR="$d/target" with_timeout cargo kani "$@" > "$log" 2>&1)
}

failed_check() { grep -q '^VERIFICATION:- FAILED' "$1" && grep -q 'Status: FAILURE' "$1"; }
compile_error() { grep -qE '^error\[E[0-9]+\]|^error: could not compile' "$1"; }
not_applied() { echo "$1 BROKEN (the patch does not apply to the crate)"; BAD=1; }
failed_harness() { grep -E '^Checking harness ' "$1" | head -1 | sed -e 's/^Checking harness //' -e 's/\.\.\.$//' -e 's/^proofs:://'; }

# tsv_field <id> <column>
tsv_field() { awk -F'\t' -v id="$1" -v col="$2" '$1 == id {print $col}' "$TSV"; }

# judge <id> <patch file name as written in this script>: the patch is already applied to the copy named <id>
judge() {
  local id=$1 patch=$2 subs sub n=0 names=""
  RAN="$RAN$id "
  if [ "$(tsv_field "$id" 2)" != "$patch" ]; then
    echo "$id BROKEN (mutants.tsv names patch '$(tsv_field "$id" 2)', this script runs '$patch')"
    BAD=1
    return
  fi
  subs=$(tsv_field "$id" 3)
  if [ -z "$subs" ]; then
    echo "$id BROKEN (no row in mutants.tsv)"
    BAD=1
    return
  fi
  if [ "$subs" = "-" ]; then
    run_kani "$id" "$id.log"
    if compile_error "$WORK/$id.log"; then
      echo "$id BROKEN (does not compile)"
      BAD=1
    elif grep -qE '^Complete - [1-9][0-9]* successfully verified harnesses, 0 failures' "$WORK/$id.log"; then
      echo "$id SURVIVED (expected: Kani does not catch it, unit tests and the differential do)"
      SURVIVORS=$((SURVIVORS + 1))
    else
      echo "$id killed by $(failed_harness "$WORK/$id.log") (UNEXPECTED: this patch must survive Kani)"
      BAD=1
    fi
    return
  fi
  for sub in $(printf '%s' "$subs" | tr ',' ' '); do
    run_kani "$id" "$id.$sub.log" --harness "$sub"
    if compile_error "$WORK/$id.$sub.log"; then
      echo "$id BROKEN (does not compile)"
      BAD=1
      return
    fi
    if failed_check "$WORK/$id.$sub.log"; then
      names="$names $(failed_harness "$WORK/$id.$sub.log")"
      n=$((n + 1))
    else
      echo "$id SURVIVED (harness $sub did not fail: expected it to kill this mutant)"
      BAD=1
      return
    fi
  done
  echo "$id killed by$names"
  KILLED=$((KILLED + 1))
}

[ -s "$TSV" ] || { echo "MUTANTS FAILED (scripts/canary/mutants.tsv is missing)"; exit 1; }

# (b) the control: a clean copy runs every harness named in mutants.tsv
fresh_copy control
flags=""
count=0
for sub in $(awk -F'\t' '$1 !~ /^#/ && NF >= 3 && $3 != "-" {print $3}' "$TSV" | tr ',' '\n' | sort -u); do
  flags="$flags --harness $sub"
  count=$((count + 1))
done
# shellcheck disable=SC2086
run_kani control control.log $flags
verified=$(grep -E '^Complete - [0-9]+ successfully verified harnesses, 0 failures' "$WORK/control.log" | sed -e 's/^Complete - //' -e 's/ successfully.*//')
if [ -z "$verified" ] || [ "$verified" -lt "$count" ] || failed_check "$WORK/control.log"; then
  tail -5 "$WORK/control.log"
  echo "MUTANTS FAILED (the clean control run does not verify every harness named in mutants.tsv)"
  exit 1
fi
echo "control: $verified harnesses verified on the clean crate"

# (a) and (c): one fresh copy, with its own target directory, per mutant
fresh_copy M1; patch -p1 -s -d "$WORK/M1" < scripts/canary/m01-skip-pc-rule.patch && judge M1 m01-skip-pc-rule.patch || not_applied M1
fresh_copy M2; patch -p1 -s -d "$WORK/M2" < scripts/canary/m02-oracle-recipient.patch && judge M2 m02-oracle-recipient.patch || not_applied M2
fresh_copy M3; patch -p1 -s -d "$WORK/M3" < scripts/canary/m03-default-payee.patch && judge M3 m03-default-payee.patch || not_applied M3
fresh_copy M3b; patch -p1 -s -d "$WORK/M3b" < scripts/canary/m03b-default-payee-no-rule5.patch && judge M3b m03b-default-payee-no-rule5.patch || not_applied M3b
fresh_copy M4; patch -p1 -s -d "$WORK/M4" < scripts/canary/m04-untrusted-no-cap.patch && judge M4 m04-untrusted-no-cap.patch || not_applied M4
fresh_copy M5; patch -p1 -s -d "$WORK/M5" < scripts/canary/m05-no-hard-cap.patch && judge M5 m05-no-hard-cap.patch || not_applied M5
fresh_copy M6; patch -p1 -s -d "$WORK/M6" < scripts/canary/m06-no-task-remainder.patch && judge M6 m06-no-task-remainder.patch || not_applied M6
fresh_copy M7; patch -p1 -s -d "$WORK/M7" < scripts/canary/m07-no-payee-limit.patch && judge M7 m07-no-payee-limit.patch || not_applied M7
fresh_copy M8; patch -p1 -s -d "$WORK/M8" < scripts/canary/m08-ignore-unresolved.patch && judge M8 m08-ignore-unresolved.patch || not_applied M8
fresh_copy M9; patch -p1 -s -d "$WORK/M9" < scripts/canary/m09-no-missing-provenance.patch && judge M9 m09-no-missing-provenance.patch || not_applied M9
fresh_copy C1; patch -p1 -s -d "$WORK/C1" < scripts/canary/untrusted-recipient.patch && judge C1 untrusted-recipient.patch || not_applied C1
fresh_copy C4; patch -p1 -s -d "$WORK/C4" < scripts/canary/lying-book.patch && judge C4 lying-book.patch || not_applied C4
fresh_copy C3; patch -p1 -s -d "$WORK/C3" < scripts/canary/cap-off-by-one.patch && judge C3 cap-off-by-one.patch || not_applied C3

# every row of the table must have been run by a line above, and every line above must have a row
for id in $(awk -F'\t' '$1 !~ /^#/ && NF >= 3 {print $1}' "$TSV"); do
  case "$RAN" in
    *" $id "*) ;;
    *)
      echo "$id BROKEN (a row of mutants.tsv that this script never runs)"
      BAD=1
      ;;
  esac
done

if [ "$BAD" -ne 0 ]; then
  echo "MUTANTS FAILED ($KILLED killed, $SURVIVORS expected survivor, at least one mutant is not as expected)"
  exit 1
fi
echo "MUTANTS OK ($KILLED killed, $SURVIVORS expected survivor)"
