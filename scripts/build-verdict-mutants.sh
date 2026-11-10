#!/usr/bin/env bash
# AIR-361: builds the broken copies of the verdict that the /break page runs beside the real gate. Each row of scripts/canary/break-proof.tsv
# names a patch in scripts/canary that takes one rule out of contracts/airlock-verdict. For each row the crate and its wasm wrapper are copied
# into a fixed folder, ${CARGO_TARGET_DIR}/verdict-mutants/<id>/ (fixed, so the bytes repeat), the patch is applied, and the wrapper is built
# exactly as scripts/build-verdict-wasm.sh builds the real one. The result is web/public/mutants/<id>.wasm.
# Before any copy counts, an unpatched copy is built in the same way and must equal the committed web/public/verdict.wasm byte for byte,
# so a copy differs from the real gate only by its patch, never by the folder it was built in.
#   --check  builds into the same folders, writes nothing, and exits 1 unless every fresh copy equals the committed file.
#   --kani   also runs Kani on each copy with the row's harness (300 s timeout, the rules of scripts/mutants.sh: a copy counts as caught only
#            when the log says `VERIFICATION:- FAILED` and holds a `Status: FAILURE` check), runs the same harnesses on an unpatched control
#            that must verify, runs the crate's vectors, rules and diff_quick tests on each copy, and writes the excerpt to
#            web/public/mutants/<id>.kani.txt (with --check it compares nothing and writes nothing, it only judges).
# After a build, run scripts/break-proof-attacks.ts to rewrite manifest.json.
# Usage: scripts/build-verdict-mutants.sh [--check] [--kani]
# Last line: `VERDICT MUTANTS OK <n>` or `VERDICT MUTANTS FAILED (<reason>)`.
set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck disable=SC1091
source scripts/env.sh
unset KANI_LOG # Kani reads KANI_LOG as its tracing filter
CHECK=0
KANI=0
for a in "$@"; do
  case "$a" in
    --check) CHECK=1 ;;
    --kani) KANI=1 ;;
    *) echo "usage: scripts/build-verdict-mutants.sh [--check] [--kani]" >&2; exit 2 ;;
  esac
done
TSV=scripts/canary/break-proof.tsv
OUT=web/public/mutants
BASE="${CARGO_TARGET_DIR:-$PWD/target}/verdict-mutants"
REAL=web/public/verdict.wasm
mkdir -p "$BASE"
[ "$CHECK" -eq 1 ] || mkdir -p "$OUT"

fail() { echo "VERDICT MUTANTS FAILED ($1)"; exit 1; }

with_timeout() {
  if command -v timeout >/dev/null 2>&1; then timeout 300 "$@"; else perl -e 'alarm 300; exec @ARGV' "$@"; fi
}

# fresh_copy <dir>: the verdict crate, its wasm wrapper and the vector files the crate's tests read, at their repo-relative paths
fresh_copy() {
  local d=$1
  rm -rf "$d"
  mkdir -p "$d/contracts/airlock-verdict" "$d/contracts/airlock-verdict-wasm" "$d/fixtures"
  cp -R contracts/airlock-verdict/src contracts/airlock-verdict/examples contracts/airlock-verdict/tests "$d/contracts/airlock-verdict/"
  cp contracts/airlock-verdict/Cargo.toml contracts/airlock-verdict/Cargo.lock contracts/airlock-verdict/rust-toolchain.toml "$d/contracts/airlock-verdict/"
  cp -R contracts/airlock-verdict-wasm/src "$d/contracts/airlock-verdict-wasm/"
  cp contracts/airlock-verdict-wasm/Cargo.toml contracts/airlock-verdict-wasm/Cargo.lock contracts/airlock-verdict-wasm/rust-toolchain.toml "$d/contracts/airlock-verdict-wasm/"
  cp fixtures/verdict-vectors.json fixtures/verdict-vectors.lines fixtures/verdict-vectors.expect "$d/fixtures/"
}

# build_wasm <dir> <name>: the build line of scripts/build-verdict-wasm.sh, with the target folder next to the copy; prints the wasm path
build_wasm() {
  local d=$1 t="$BASE/$2.target"
  (cd "$d/contracts/airlock-verdict-wasm" && cargo build -q --release --target wasm32-unknown-unknown --target-dir "$t")
  echo "$t/wasm32-unknown-unknown/release/airlock_verdict_wasm.wasm"
}

sha() { shasum -a 256 "$1" | cut -d' ' -f1; }
# a local path never reaches a committed file: the copy folder becomes the repo root, any home folder becomes ~
clean_paths() { sed -e "s#$1/##g" -e 's#/Users/[^/ ]*#~#g' -e 's#/home/[^/ ]*#~#g'; }
failed_check() { grep -q '^VERIFICATION:- FAILED' "$1" && grep -q 'Status: FAILURE' "$1"; }

[ -s "$TSV" ] || fail "scripts/canary/break-proof.tsv is missing"
ROWS=$(grep -v '^#' "$TSV" | grep -c .)
[ "$ROWS" -ge 1 ] || fail "no rows in break-proof.tsv"

# the control: an unpatched copy must build to the committed real gate
fresh_copy "$BASE/control"
built=$(build_wasm "$BASE/control" control)
[ "$(sha "$built")" = "$(sha "$REAL")" ] || fail "an unpatched copy built in $BASE/control is not byte for byte web/public/verdict.wasm"
echo "control: an unpatched copy builds to web/public/verdict.wasm ($(sha "$REAL"))"

if [ "$KANI" -eq 1 ]; then
  flags=""
  for h in $(grep -v '^#' "$TSV" | cut -f5); do flags="$flags --harness $h"; done
  # shellcheck disable=SC2086
  (cd "$BASE/control/contracts/airlock-verdict" && CARGO_TARGET_DIR="$BASE/control.kani" with_timeout cargo kani $flags > "$BASE/control.kani.log" 2>&1) || true
  grep -qE "^Complete - $ROWS successfully verified harnesses, 0 failures" "$BASE/control.kani.log" || { tail -5 "$BASE/control.kani.log"; fail "the unpatched control does not verify every harness of break-proof.tsv"; }
  echo "control: $ROWS harnesses verified on the unpatched crate"
fi

n=0
while IFS=$'\t' read -r id patch title attack harness lean; do
  case "$id" in '' | '#'*) continue ;; esac
  : "$title" "$attack" "$lean"
  d="$BASE/$id"
  fresh_copy "$d"
  patch -p1 -s -d "$d" < "scripts/canary/$patch" || fail "$id: scripts/canary/$patch does not apply"
  built=$(build_wasm "$d" "$id") || fail "$id: the copy does not build"
  fresh=$(sha "$built")
  [ "$fresh" != "$(sha "$REAL")" ] || fail "$id: the copy is the real gate"
  if [ "$CHECK" -eq 1 ]; then
    [ -f "$OUT/$id.wasm" ] || fail "$id: $OUT/$id.wasm is missing"
    [ "$(sha "$OUT/$id.wasm")" = "$fresh" ] || fail "$id: committed $(sha "$OUT/$id.wasm") fresh $fresh"
  else
    cp "$built" "$OUT/$id.wasm"
    chmod 644 "$OUT/$id.wasm"
  fi
  line="$id $fresh"
  if [ "$KANI" -eq 1 ]; then
    log="$BASE/$id.kani.log"
    (cd "$d/contracts/airlock-verdict" && CARGO_TARGET_DIR="$BASE/$id.kani" with_timeout cargo kani --harness "$harness" > "$log" 2>&1) || true
    failed_check "$log" || { tail -5 "$log"; fail "$id: harness $harness did not fail on the copy"; }
    tlog="$BASE/$id.test.log"
    (cd "$d/contracts/airlock-verdict" && CARGO_TARGET_DIR="$BASE/$id.test" cargo test --no-fail-fast --test vectors --test rules --test diff_quick > "$tlog" 2>&1) || true
    if [ "$CHECK" -eq 0 ]; then
      {
        echo "copy: $id (scripts/canary/$patch applied to contracts/airlock-verdict)"
        echo "harness: $harness, recorded $(date -u +%Y-%m-%dT%H:%MZ)"
        head -1 "$log"
        echo
        grep -E '^Checking harness ' "$log" | head -1
        # every failing check: its Check line and the indented lines under it
        awk '/^Check [0-9]+:/ {blk=$0; keep=0; next} /^\t - / && blk!="" {blk=blk "\n" $0; if ($0 ~ /Status: FAILURE/) keep=1; next} blk!="" {if (keep) print blk "\n"; blk=""; keep=0}' "$log"
        sed -n '/^SUMMARY:/,/^Verification Time:/p' "$log"
        echo
        echo "control: the same harness on the unpatched crate"
        awk -v h="$harness" '$0 ~ "^Checking harness .*" h {on=1} on && /^VERIFICATION:-/ {print; exit}' "$BASE/control.kani.log"
        echo
        echo "cargo test on the copy (tests vectors, rules and diff_quick):"
        grep -E '^ +Running tests/|^test .* \.\.\. FAILED$|^test result:' "$tlog" | sed -e 's/^ *//' -e 's/ (.*)$//' || echo "(no test output)"
        echo "(diff_quick compares with the Lean answers only when DIFF_CASES is set, so here it passes without comparing.)"
      } | clean_paths "$d" > "$OUT/$id.kani.txt"
    fi
    line="$line, $harness fails"
  fi
  echo "$line"
  n=$((n + 1))
done < "$TSV"

[ "$n" -eq "$ROWS" ] || fail "built $n of $ROWS rows"
echo "VERDICT MUTANTS OK $n"
