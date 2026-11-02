#!/usr/bin/env bash
# AIR-033: mutation testing of contracts/airlock-verdict with cargo-mutants 26.0.0.
# Usage: scripts/mutation.sh [--reuse]
# Every viable mutant must be killed by the unit tests (the differential test tests/diff_quick.rs included), by a timeout (a hung test
# suite is a detection) or by Kani, or it must be listed with a reason in docs/mutation.md (override with MUTATION_DOC=<absolute path>).
# Steps: 1 preconditions; 2 the 2,000 differential cases and the Lean tags once; 3 baseline of the differential test; 4 cargo mutants;
# 5 the survivors are re-checked with Kani on the harness group of the mutated file (a kill needs a `Status: FAILURE` check, and the same
# group must first verify on the unmutated copy); 6 the survivors are matched with the table of docs/mutation.md; 7 the summary.
# --reuse skips steps 2 to 4 when target/mutants/mutants.out/outcomes.json exists (the bookkeeping of steps 5 to 7 still runs).
# Kill criterion: when steps 4 and 5 together pass 2 hours (MUTATION_BUDGET_S), Kani is dropped and the last line says so.
# Deviation from the ticket text: cargo-mutants runs `--in-place` on a scratch tree (crate plus fixtures/) of this script, because the
# tests include ../../fixtures/verdict-vectors.* and the default temporary copy of the crate alone cannot compile them (every mutant
# came out unviable); the tree under contracts/ is never mutated. The scratch tree has its own CARGO_TARGET_DIR, so no stale build
# of the shared target directory can be tested by mistake.
# Exit codes: 0 all survivors justified, 1 any failure, 2 missing cargo-mutants 26.0.0.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1
# shellcheck disable=SC1091
source scripts/env.sh
unset KANI_LOG   # Kani reads KANI_LOG as its tracing filter; the banner must stay on line 1
ROOT=$PWD
CRATE=$ROOT/contracts/airlock-verdict
OUT=$ROOT/target/mutants
DOC=${MUTATION_DOC:-$ROOT/docs/mutation.md}
BUDGET_S=${MUTATION_BUDGET_S:-7200}
REUSE=0
case "${1:-}" in
  "") ;;
  --reuse) REUSE=1 ;;
  *) echo "usage: scripts/mutation.sh [--reuse]" >&2; exit 2 ;;
esac

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$ROOT/target"
fail() { echo "$1"; exit 1; }

# 1. preconditions
if [ "$(cargo mutants --version 2>/dev/null)" != "cargo-mutants 26.0.0" ]; then
  echo "cargo-mutants 26.0.0 is required: cd ~ && cargo +stable install cargo-mutants --locked --version 26.0.0"
  exit 2
fi
command -v patch > /dev/null || fail "MUTATION FAILED (patch is missing)"

START=$SECONDS
if [ "$REUSE" -eq 1 ] && [ -f "$OUT/mutants.out/outcomes.json" ]; then
  echo "reusing $OUT/mutants.out/outcomes.json"
else
  # 2. cases and the Lean tags
  CASES=$ROOT/target/mut.cases
  LEAN=$ROOT/target/mut.lean
  { python3 scripts/gen_verdict_cases.py 800 7 uniform
    python3 scripts/gen_verdict_cases.py 800 11 boundary
    python3 scripts/gen_verdict_cases.py 400 13 toggle; } > "$CASES" || fail "MUTATION FAILED (case generator)"
  (cd proofs && lake build verdict-run > /dev/null 2>&1) || fail "MUTATION FAILED (lake build verdict-run)"
  LEAN_ABORT_ON_PANIC=1 proofs/.lake/build/bin/verdict-run < "$CASES" > "$LEAN" || fail "MUTATION FAILED (verdict-run)"
  [ "$(wc -l < "$CASES" | tr -d ' ')" = 2000 ] && [ "$(wc -l < "$LEAN" | tr -d ' ')" = 2000 ] \
    || fail "MUTATION FAILED (the case file and the Lean tags need 2000 lines each)"

  # the scratch tree: the crate and the fixtures its tests include, with a target directory of its own
  mkdir -p "$WORK/tree/contracts" "$WORK/tree/fixtures"
  cp -R "$CRATE" "$WORK/tree/contracts/airlock-verdict"
  rm -rf "$WORK/tree/contracts/airlock-verdict/target"
  cp "$ROOT"/fixtures/verdict-vectors.* "$WORK/tree/fixtures/"
  SCRATCH=$WORK/tree/contracts/airlock-verdict
  export CARGO_TARGET_DIR=$WORK/target
  export DIFF_CASES=$CASES DIFF_EXPECT=$LEAN

  # 3. baseline
  base=$(cd "$SCRATCH" && cargo test --test diff_quick -- --nocapture 2>&1)
  printf '%s\n' "$base" | grep -q 'diff_quick: compared 2000 cases' \
    || { printf '%s\n' "$base" | tail -8; fail "MUTATION FAILED (baseline)"; }

  # 4. cargo mutants
  rm -rf "$OUT"
  mkdir -p "$OUT"
  (cd "$SCRATCH" && cargo mutants --in-place -o "$OUT")
  rc=$?
  case "$rc" in
    0 | 2 | 3) ;;
    *) fail "MUTATION FAILED (baseline, cargo mutants exit $rc)" ;;
  esac
  unset DIFF_CASES DIFF_EXPECT CARGO_TARGET_DIR
fi
MO=$OUT/mutants.out
[ -f "$MO/outcomes.json" ] || fail "MUTATION FAILED (no outcomes.json)"
[ -f "$MO/missed.txt" ] || touch "$MO/missed.txt"

# counts and the survivor list: tab separated file|line|col|diff_path|name, in the order of missed.txt
python3 - "$MO" "$WORK/survivors.tsv" "$WORK/counts.txt" << 'PY' || fail "MUTATION FAILED (outcomes.json does not match missed.txt)"
import json, sys
mo, tsv, counts = sys.argv[1:4]
d = json.load(open(mo + "/outcomes.json"))
missed_lines = [l.rstrip("\n") for l in open(mo + "/missed.txt") if l.strip()]
caught = missed = timeouts = unviable = 0
rows = []
for o in d["outcomes"]:
    m = o["scenario"]
    if m == "Baseline" or "Mutant" not in m:
        continue
    s = o["summary"]
    if s == "CaughtMutant": caught += 1
    elif s == "Unviable": unviable += 1
    elif s == "Timeout": timeouts += 1
    elif s == "MissedMutant":
        missed += 1
        mm = m["Mutant"]
        rows.append((mm["file"], mm["span"]["start"]["line"], mm["span"]["start"]["column"], o["diff_path"]))
if len(rows) != len(missed_lines):
    sys.exit("survivors in outcomes.json: %d, lines in missed.txt: %d" % (len(rows), len(missed_lines)))
with open(tsv, "w") as f:
    for (file, line, col, diff), name in zip(rows, missed_lines):
        if not name.startswith("%s:%d:%d:" % (file, line, col)):
            sys.exit("missed.txt line does not start with %s:%d:%d: %s" % (file, line, col, name))
        f.write("\t".join([file, str(line), str(col), diff, name]) + "\n")
with open(counts, "w") as f:
    f.write("%d %d %d %d\n" % (caught, missed, timeouts, unviable))
PY
read -r CAUGHT MISSED TIMEOUTS UNVIABLE < "$WORK/counts.txt"
echo "cargo-mutants: caught $CAUGHT, missed $MISSED, timeouts $TIMEOUTS, unviable $UNVIABLE"

# 5. Kani on the survivors
group_of() { # <file>: the harness filters of that source file (substring filters, as AIR-021 and AIR-025 pin them)
  case "$1" in
    src/lib.rs) echo "p01 p02 p03 p04 p05 p06 p07 p08 p09 p11 p21 p22 cover_every_reason" ;;
    src/ledger.rs) echo "p13 l1_ l2_ l3_ l4_ l5_" ;;
    src/approve.rs) echo "p12 approve_each" ;;
    src/decimal.rs) echo "placement_round_trip formatted_text_is_canonical parse_digits_never_panics" ;;
    src/labels.rs) echo "p17" ;;
    src/keys.rs) echo "p16" ;;
    src/flood.rs) echo "flood_" ;;
    *) echo "" ;;
  esac
}
kani_run() { # <copy dir> <file>: runs the group of <file> in the crate of <copy dir>, output on stdout
  local flags="" h
  for h in $(group_of "$2"); do flags="$flags --harness $h"; done
  # shellcheck disable=SC2086
  (cd "$1/crate" && CARGO_TARGET_DIR="$1/target" timeout 300 cargo kani $flags 2>&1)
}
KANI_KILLED=0
KANI_SKIPPED=0
CONTROLLED=" "
KANI_NOTE=""
if [ "$MISSED" -gt 0 ]; then
  if [ $((SECONDS - START)) -gt "$BUDGET_S" ]; then
    KANI_SKIPPED=1
  else
    n=0
    while IFS=$'\t' read -r file line col diff name; do
      n=$((n + 1))
      if [ $((SECONDS - START)) -gt "$BUDGET_S" ]; then KANI_SKIPPED=1; KANI_KILLED=0; break; fi
      [ -n "$(group_of "$file")" ] || { echo "no Kani group for $file: $name"; continue; }
      copy=$WORK/k$n
      mkdir -p "$copy/crate"
      cp -R "$CRATE/Cargo.toml" "$CRATE/rust-toolchain.toml" "$CRATE/src" "$copy/crate/"
      [ -f "$CRATE/Cargo.lock" ] && cp "$CRATE/Cargo.lock" "$copy/crate/"
      mkdir -p "$copy/ctl"
      case "$CONTROLLED" in
        *" $file "*) ;;
        *)
          mkdir -p "$WORK/ctl"
          rm -rf "$WORK/ctl/crate" "$WORK/ctl/target"
          mkdir -p "$WORK/ctl/crate"
          cp -R "$CRATE/Cargo.toml" "$CRATE/rust-toolchain.toml" "$CRATE/src" "$WORK/ctl/crate/"
          [ -f "$CRATE/Cargo.lock" ] && cp "$CRATE/Cargo.lock" "$WORK/ctl/crate/"
          ctl=$(kani_run "$WORK/ctl" "$file")
          printf '%s\n' "$ctl" | grep -qE '^Complete - [1-9][0-9]* successfully verified harnesses, 0 failures' \
            || { printf '%s\n' "$ctl" | tail -5; fail "MUTATION FAILED (the clean Kani control run of the group of $file does not verify)"; }
          CONTROLLED="$CONTROLLED$file "
          ;;
      esac
      (cd "$copy/crate" && patch -p0 -s < "$MO/$diff") > "$copy/patch.log" 2>&1 \
        || { cat "$copy/patch.log"; fail "MUTATION FAILED (the patch of $name does not apply)"; }
      out=$(kani_run "$copy" "$file")
      if printf '%s\n' "$out" | grep -q 'Status: FAILURE'; then
        KANI_KILLED=$((KANI_KILLED + 1))
        echo "killed by Kani: $name" >&2
        printf '%s\n' "$name" >> "$WORK/kani-killed.txt"
      else
        echo "survivor: $name"
      fi
      rm -rf "$copy"
    done < "$WORK/survivors.tsv"
  fi
fi
if [ "$KANI_SKIPPED" -eq 1 ]; then
  KANI_KILLED=0
  rm -f "$WORK/kani-killed.txt"
  KANI_NOTE=" (Kani step skipped)"
fi
touch "$WORK/kani-killed.txt"

# 6. justification: every survivor that Kani did not kill needs a row, and every row needs a survivor
grep -vxFf "$WORK/kani-killed.txt" <(cut -f5 "$WORK/survivors.tsv") > "$WORK/remaining.txt" || true
[ -f "$DOC" ] || fail "MUTATION FAILED ($DOC is missing)"
grep '^| ' "$DOC" | tail -n +3 > "$WORK/rows.txt" || true
python3 - "$WORK/remaining.txt" "$WORK/rows.txt" << 'PY'
import sys
remaining = [l.rstrip("\n") for l in open(sys.argv[1]) if l.strip()]
rows = [l.rstrip("\n") for l in open(sys.argv[2]) if l.strip()]
bad = 0
used = set()
for name in remaining:
    hit = None
    for i, r in enumerate(rows):
        if r.startswith("| " + name + " | ") and len(r[len("| " + name + " | "):].strip(" |")) >= 10:
            hit = i
            break
    if hit is None:
        print("UNJUSTIFIED: " + name)
        bad = 1
    else:
        used.add(hit)
for i, r in enumerate(rows):
    if i not in used:
        print("STALE ROW: " + r[2:])
        bad = 1
sys.exit(bad)
PY
[ $? -eq 0 ] || exit 1

# 7. summary
N=$((CAUGHT + MISSED + TIMEOUTS))
K=$((CAUGHT + TIMEOUTS + KANI_KILLED))
S=$((N - K))
echo "unviable $UNVIABLE, timeouts $TIMEOUTS, killed by tests $CAUGHT, killed by Kani $KANI_KILLED"
echo "MUTATION: killed $K of $N, $S survivors, all survivors justified in docs/mutation.md$KANI_NOTE"
exit 0
