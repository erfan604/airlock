#!/usr/bin/env bash
# Usage: scripts/check.sh [quick|full|nightly]   (default quick)
# quick:   per-commit gate: fmt, clippy and tests of each contract, workspace typecheck and tests, money lint, differential
#          (2,000 vectors), vector consumers, command guard self-test, commit rules, gitleaks. Budget 120 s warm (measure
#          again after AIR-061 and record the number here).
# full:    quick plus Kani, Lean, axiom audit, differential (40,000 vectors), contract wasm build and sandbox suites (two
#          neard versions), web build and the toolchain pin table. Run before a push, a gate or a claim.
# nightly: full plus the long runs. None are planned after the 2026-10-21 scope cut, so nightly equals full; the one million
#          vector differential (scripts/diff-verdict.sh --nightly) is run once by hand before Freeze.
# Every step is a row of the table printed at the end (name, seconds, ok, FAIL or SKIP). A failing step does not stop the run,
# so the table lists every failure; the exit code is 1 if any row is FAIL. The last line is exactly one of
#   ALL GREEN (<mode>)   ALL GREEN (<mode>, skipped: <labels>)   FAILED (<mode>): <row names>
# A component that is not in the tree yet is named as skipped, never silently green. CHECK_STRICT=1 turns every SKIP into a
# FAIL. scripts/check.required lists paths whose absence fails the run in every mode (MISSING REQUIRED: <path>).
# CHECK_ROOT=<dir> runs against another tree (scripts/, .claude/ and every step are read from there); it is for
# scripts/test-check.sh only and is refused when CI is set. Adding a step later: one step_if line here and one line in
# scripts/check.required, in the commit that adds the script.
set -euo pipefail

MODE="${1-quick}"
case "$MODE" in quick|full|nightly) ;; *) echo "usage: scripts/check.sh [quick|full|nightly]" >&2; exit 2;; esac
[ "$#" -le 1 ] || { echo "usage: scripts/check.sh [quick|full|nightly]" >&2; exit 2; }

if [ -n "${CHECK_ROOT:-}" ]; then
  if [ -n "${CI:-}" ]; then echo "check.sh: CHECK_ROOT is for tests only and is refused when CI is set" >&2; exit 2; fi
  [ -d "$CHECK_ROOT" ] || { echo "check.sh: CHECK_ROOT is not a directory: $CHECK_ROOT" >&2; exit 2; }
  ROOT=$(cd "$CHECK_ROOT" && pwd -P)
else
  ROOT=$(cd "$(dirname "$0")/.." && pwd -P)
fi
cd "$ROOT"
source scripts/env.sh
mkdir -p target

START=$SECONDS
ROWS=""      # the table, one preformatted line per step
FAILED=""    # row names that are FAIL, each with a leading space
SKIPPED=""   # labels of absent components, each once, each with a leading space
STRICT=0
if [ -n "${CHECK_STRICT:-}" ] && [ "$CHECK_STRICT" != 0 ]; then STRICT=1; fi

add_row() { # name seconds status
  ROWS+=$(printf '%-28s %5ss  %s\n' "$1" "$2" "$3")$'\n'
}

# step <name> <cmd...>: run the command (own subshell, working directory ROOT), record seconds and ok or FAIL, never stop the run
step() {
  local name=$1 t0 rc=0
  shift
  printf '\n== %s\n' "$name"
  t0=$SECONDS
  ( "$@" ) || rc=$?
  if [ "$rc" -eq 0 ]; then
    add_row "$name" "$((SECONDS - t0))" ok
  else
    printf 'FAIL %s (exit %s)\n' "$name" "$rc"
    add_row "$name" "$((SECONDS - t0))" FAIL
    FAILED+=" $name"
  fi
  return 0
}

# step_if <path> <label> <name> <cmd...>: when <path> is absent, record a SKIP row named <name> and add <label> to SKIPPED once
# (CHECK_STRICT turns the SKIP into a FAIL); otherwise step <name> <cmd...>. A group guarded by one path calls it once per row.
step_if() {
  local path=$1 label=$2 name=$3
  shift 3
  if [ -e "$path" ]; then step "$name" "$@"; return 0; fi
  if [ "$STRICT" -eq 1 ]; then
    printf '\n== %s\nFAIL %s: %s is missing and CHECK_STRICT is set\n' "$name" "$name" "$path"
    add_row "$name" 0 FAIL
    FAILED+=" $name"
  else
    printf '\n== %s\nSKIP %s: %s is not in the tree yet\n' "$name" "$name" "$path"
    add_row "$name" 0 SKIP
    case "$SKIPPED " in *" $label "*) ;; *) SKIPPED+=" $label";; esac
  fi
  return 0
}

in_dir() { local d=$1; shift; (cd "$d" && "$@"); }   # run a command in a subfolder
quiet() { local out; if out=$("$@" 2>&1); then return 0; fi; printf '%s\n' "$out" | tail -30; return 1; }   # silent unless it fails

check_required() {
  local line p n=0 bad=0
  [ -f scripts/check.required ] || { echo "MISSING REQUIRED: scripts/check.required"; return 1; }
  while IFS= read -r line || [ -n "$line" ]; do
    p=$(printf '%s' "$line" | tr -d '\r' | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')
    case "$p" in ''|'#'*) continue;; esac
    n=$((n + 1))
    [ -e "$p" ] || { echo "MISSING REQUIRED: $p"; bad=1; }
  done < scripts/check.required
  [ "$bad" -eq 0 ] && echo "$n required path(s) present"
  return "$bad"
}

gitleaks_scan() {
  command -v gitleaks >/dev/null || { echo "gitleaks not installed: brew install gitleaks"; return 1; }   # missing is a FAIL, not a skip
  gitleaks git --no-banner --redact --log-level error .
}

# Every proofs/*.lean, after a lake build of the library (the files import each other, and proofs/lean-toolchain pins Lean).
# Lean 4.35 prints: declaration uses `sorry` (backticks); older versions used straight quotes. Here-strings, not echo into
# grep -q: under pipefail an early grep exit can turn a match into a pipeline failure.
lean_proofs() {
  local files f out bad=0
  shopt -s nullglob
  files=(proofs/*.lean)
  [ "${#files[@]}" -gt 0 ] || { echo "FAIL no proofs/*.lean files"; return 1; }
  command -v lake >/dev/null || { echo "FAIL lake not on PATH (scripts/env.sh adds ~/.elan/bin)"; return 1; }
  if ! out=$(cd proofs && lake build 2>&1); then printf '%s\n' "$out" | tail -20; echo "FAIL lake build"; return 1; fi
  for f in "${files[@]}"; do
    if ! out=$(cd proofs && lake env lean "$(basename "$f")" 2>&1); then
      printf '%s\n' "$out" | head -5; echo "FAIL $f (lean exited nonzero)"; bad=1; continue
    fi
    if grep -q ': error' <<<"$out"; then grep ': error' <<<"$out" | head -5; echo "FAIL $f"; bad=1; continue; fi
    if grep -qE "sorryAx|declaration uses .sorry." <<<"$out"; then echo "FAIL $f uses sorry"; bad=1; fi
  done
  return "$bad"
}

evidence_pins() {
  if scripts/evidence-pins.sh > target/pins.md; then echo "wrote target/pins.md"; return 0; fi
  grep MISMATCH target/pins.md || cat target/pins.md
  return 1
}

# ---- quick: every mode runs these ----
step required check_required

step_if contracts/airlock-verdict verdict verdict-fmt in_dir contracts/airlock-verdict cargo fmt --check
step_if contracts/airlock-verdict verdict verdict-clippy in_dir contracts/airlock-verdict cargo clippy -q --all-targets -- -D warnings
step_if contracts/airlock-verdict verdict verdict-test in_dir contracts/airlock-verdict cargo test -q

# AIR-103's mock signer crate, linted before the policy crate whose sandbox tests deploy its wasm
step_if contracts/mock-mpc mock-mpc mock-mpc-fmt in_dir contracts/mock-mpc cargo fmt --check                     # AIR-103
step_if contracts/mock-mpc mock-mpc mock-mpc-clippy in_dir contracts/mock-mpc cargo clippy -q --all-targets -- -D warnings

step_if contracts/airlock-policy policy policy-fmt in_dir contracts/airlock-policy cargo fmt --check
step_if contracts/airlock-policy policy policy-clippy in_dir contracts/airlock-policy cargo clippy -q --all-targets -- -D warnings
step_if contracts/airlock-policy policy policy-test in_dir contracts/airlock-policy cargo test -q --lib

step_if package.json workspace workspace-typecheck pnpm -r typecheck
step_if package.json workspace workspace-test pnpm -r test

step_if scripts/lint-money.sh lint-money lint-money scripts/lint-money.sh                       # AIR-004
step_if scripts/gen_verdict_cases.py diff diff scripts/diff-verdict.sh --quick                 # AIR-023, 2,000 vectors
step_if scripts/check-vector-consumers.sh vectors vectors scripts/check-vector-consumers.sh    # AIR-024
# guarded by the manifest, not by the script: the kit ships scripts/check-payloads.sh, the payload files arrive with AIR-125,
# which appends fixtures/payloads.sha256 to check.required
step_if fixtures/payloads.sha256 payloads payloads scripts/check-payloads.sh                    # AIR-125
# no board step: the tickets stay in the research repo (AIR-006), so run
# python3 kit/scripts/board.py --dir plan/tickets --check from $AIRLOCK_RESEARCH
step guard-selftest python3 .claude/hooks/guard_bash.py --self-test
step_if scripts/check-commits.sh commits commits scripts/check-commits.sh
step gitleaks gitleaks_scan

# ---- full: quick plus ----
if [ "$MODE" != quick ]; then
  # guarded by the crate's harnesses.toml, not by scripts/kani-check.sh: the kit ships the script on Day 1 but contracts/airlock-verdict
  # only exists once AIR-021 writes it, so a script guard never skips and full would run cargo kani in a folder that is not there.
  # The toml belongs in check.required once it exists, so the step can never quietly turn back into a skip.
  step_if contracts/airlock-verdict/harnesses.toml kani kani scripts/kani-check.sh              # AIR-029
  # guarded by the first proof file, not the folder: the kit ships proofs/ with only lakefile.toml and lean-toolchain, so a
  # folder guard never skips and full would fail before AIR-022 (Nov 1). AIR-022 appends proofs/Verdict.lean to check.required,
  # so once it exists the step can never quietly turn back into a skip.
  step_if proofs/Verdict.lean lean lean lean_proofs
  # guarded by the file the generator's first run writes (AIR-028 then appends it to check.required); the kit ships the script
  step_if docs/harnesses.md harness-table harness-table python3 scripts/harness-table.py --check  # AIR-028
  step_if scripts/lean-axioms.sh lean-axioms lean-axioms scripts/lean-axioms.sh                 # AIR-030
  step_if scripts/gen_verdict_cases.py diff diff-commit scripts/diff-verdict.sh --commit        # 40,000 vectors
  step_if contracts/mock-mpc mock-mpc mock-mpc-build quiet scripts/build-mock-mpc.sh            # AIR-103, before the policy suites
  step_if contracts/mock-mpc mock-mpc mock-mpc-test in_dir contracts/mock-mpc cargo test -q
  step_if contracts/airlock-policy policy policy-build in_dir contracts/airlock-policy quiet cargo near build non-reproducible-wasm --no-abi
  step_if contracts/airlock-policy policy policy-sandbox in_dir contracts/airlock-policy cargo test -q
  # second contract pass on the protocol 88 sandbox (neard 2.14.0, stable since 2026-10-26; testnet runs protocol 88): env.sh
  # points NEAR_SANDBOX_BIN_PATH at 2.11.0 (protocol 83), and balances differ (notes/sandbox_p88_2026-10-24.md: no gas rebate,
  # dearer account creation). Never assert exact balances or rebates in contract tests. The binary is cached next to the
  # 2.11.0 one (plan/ERFAN_TODO.md has the one-line download); an absent binary is named as skipped (label sandbox-p88).
  P88_BIN="$HOME/.cache/airlock-sandbox/near-sandbox-2.14.0/near-sandbox"
  if [ -e contracts/airlock-policy ]; then
    step_if "$P88_BIN" sandbox-p88 policy-sandbox-p88 in_dir contracts/airlock-policy env NEAR_SANDBOX_BIN_PATH="$P88_BIN" cargo test -q
  else
    step_if contracts/airlock-policy policy policy-sandbox-p88 true
  fi
  # AIR-066 allows exactly I01 and I05 to have no test until AIR-108 writes them; AIR-108 deletes the flag (a protected edit)
  step_if scripts/invariant-map.sh invariants invariants scripts/invariant-map.sh --allow-missing "I01 I05"   # AIR-066
  step_if scripts/bench-replay-check.sh bench-replay bench-replay scripts/bench-replay-check.sh   # AIR-228
  step_if web/package.json web web quiet pnpm -C web build
  step evidence-pins evidence_pins
fi

# ---- nightly: full plus ----
if [ "$MODE" = nightly ]; then
  : # nothing planned (AIR-031, AIR-032 and AIR-065 were cut). A ticket that owns a nightly script adds its step_if here and its
    # check.required line in the same commit.
fi

printf '\n%s' "$ROWS"
printf 'TOTAL %ss\n' "$((SECONDS - START))"
if [ -n "$FAILED" ]; then
  printf 'FAILED (%s):%s\n' "$MODE" "$FAILED"
  exit 1
fi
if [ -n "$SKIPPED" ]; then
  printf 'ALL GREEN (%s, skipped:%s)\n' "$MODE" "$SKIPPED"
else
  printf 'ALL GREEN (%s)\n' "$MODE"
fi
