#!/usr/bin/env bash
# Fixture tests for scripts/check.sh (AIR-002). Each case builds a small repo in its own mktemp -d (scripts and .claude copied
# from this repo, plus the files of the case, one commit as erfan-7116 because gitleaks and check-commits.sh need one), runs
# CHECK_ROOT=<fixture> scripts/check.sh <mode> and asserts the exit code and the failing row (or the last line).
# Cases: 1 Lean sorry (full), 2 missing required path, 3 failing Rust test, 4 passing Rust test, 5 case 4 under CHECK_STRICT=1.
# A case that expects a failure and sees check.sh exit 0 prints UNEXPECTED PASS; so does a case that expects a green run and sees
# exit 0 without the table, TOTAL and ALL GREEN lines (a script that exits 0 and prints nothing proves nothing).
# Usage: scripts/test-check.sh     (any directory; the repo root is the parent of this script's folder)
# Last line: CHECK TESTS OK (5 of 5)
set -uo pipefail

SELF=$(cd "$(dirname "$0")" && pwd -P)
ROOT=$(cd "$SELF/.." && pwd -P)
CHECK="$SELF/check.sh"
TOTAL_CASES=5
OK=0
CLEAN=""
T=""
OUT=""
RC=0
trap 'for d in $CLEAN; do rm -rf "$d"; done' EXIT

[ -f "$CHECK" ] || { echo "no $CHECK"; echo "CHECK TESTS FAILED (0 of $TOTAL_CASES ok)"; exit 1; }
[ -f "$ROOT/proofs/lean-toolchain" ] || { echo "no $ROOT/proofs/lean-toolchain (case 1 copies it)"; echo "CHECK TESTS FAILED (0 of $TOTAL_CASES ok)"; exit 1; }

# a fresh fixture in T: the repo's scripts and .claude, nothing else yet
mkfix() {
  T=$(mktemp -d) || exit 1
  CLEAN="$CLEAN $T"
  cp -R "$ROOT/scripts" "$ROOT/.claude" "$T/"
  # the NEAR skills bootstrap.sh installs are gitignored in the product repo (their curl examples trip gitleaks), and a fixture
  # has no .gitignore, so leave them out
  rm -rf "$T"/.claude/skills/near-*
}

# git init plus one commit of everything in T (by name, one entry at a time), author and committer erfan-7116
commit_fix() {
  local e b
  (
    cd "$T" || exit 1
    git init -q || exit 1
    for e in "$T"/* "$T"/.[!.]*; do
      [ -e "$e" ] || continue
      b=${e##*/}
      case "$b" in .git|target) continue;; esac
      git add -- "$b" || exit 1
    done
    GIT_AUTHOR_NAME=erfan-7116 GIT_AUTHOR_EMAIL=erfan@welcomeaide.com \
      GIT_COMMITTER_NAME=erfan-7116 GIT_COMMITTER_EMAIL=erfan@welcomeaide.com \
      git commit -q -m 'test(check): fixture for check.sh'
  ) || { echo "fixture commit failed in $T"; exit 1; }
}

# a crate under contracts/airlock-verdict, formatted and lint clean; its one test asserts double(2) == $1
mkcrate() {
  mkdir -p "$T/contracts/airlock-verdict/src"
  printf '%s\n' '[package]' 'name = "fixture-verdict"' 'version = "0.1.0"' 'edition = "2021"' > "$T/contracts/airlock-verdict/Cargo.toml"
  printf '%s\n' \
    'pub fn double(x: u32) -> u32 {' \
    '    x * 2' \
    '}' \
    '' \
    '#[cfg(test)]' \
    'mod tests {' \
    '    use super::double;' \
    '' \
    '    #[test]' \
    '    fn doubles() {' \
    "        assert_eq!(double(2), $1);" \
    '    }' \
    '}' > "$T/contracts/airlock-verdict/src/lib.rs"
}

# run_check <mode> [VAR=value ...]: sets OUT (stdout and stderr) and RC. CI and CHECK_STRICT are cleared first so the caller's
# shell cannot change a case (check.sh refuses CHECK_ROOT when CI is set). The target dir lives in the fixture and is deleted
# with it: one dir shared by two fixtures with the same crate path is the stale-binary trap env.sh describes.
run_check() {
  local mode=$1; shift
  OUT=$(env -u CI -u CHECK_STRICT CHECK_ROOT="$T" CARGO_TARGET_DIR="$T/target" "$@" "$CHECK" "$mode" 2>&1)
  RC=$?
}

report() { # kind case message
  printf '%s case %s: %s\n' "$1" "$2" "$3"
}

# finish_case <n> <description> <want exit code> <pattern>...
# A pattern is an extended regex matched against every output line; "L:<regex>" matches the last line only; "!<regex>" must not match.
finish_case() {
  local n=$1 desc=$2 want=$3 p last bad=""
  shift 3
  last=$(printf '%s\n' "$OUT" | tail -1)
  if [ "$want" -eq 0 ]; then
    if [ "$RC" -ne 0 ]; then
      report FAIL "$n" "$desc: exit $RC, wanted 0"
      printf '%s\n' "$OUT" | tail -25 | sed 's/^/    | /'
      return
    fi
  else
    if [ "$RC" -eq 0 ]; then
      report "UNEXPECTED PASS" "$n" "$desc: check.sh exited 0, wanted $want"
      return
    fi
    if [ "$RC" -ne "$want" ]; then
      report FAIL "$n" "$desc: exit $RC, wanted $want"
      printf '%s\n' "$OUT" | tail -25 | sed 's/^/    | /'
      return
    fi
  fi
  for p in "$@"; do
    case "$p" in
      L:*) grep -Eq -e "${p#L:}" <<<"$last" || bad="$bad [last line: ${p#L:}]";;
      '!'*) if grep -Eq -e "${p#!}" <<<"$OUT"; then bad="$bad [must not match: ${p#!}]"; fi;;
      *) grep -Eq -e "$p" <<<"$OUT" || bad="$bad [$p]";;
    esac
  done
  if [ -n "$bad" ]; then
    if [ "$RC" -eq 0 ]; then
      report "UNEXPECTED PASS" "$n" "$desc: exit 0 but the output lacks:$bad"
    else
      report FAIL "$n" "$desc: output check failed:$bad"
      printf '%s\n' "$OUT" | tail -25 | sed 's/^/    | /'
    fi
    return
  fi
  OK=$((OK + 1))
  report PASS "$n" "$desc"
}

echo "check.sh fixture tests (case 1 runs Lean, cases 3 to 5 build a small Rust crate)"

echo "case 1: Lean file with a sorry, full"
mkfix
mkdir -p "$T/proofs"
cp "$ROOT/proofs/lean-toolchain" "$T/proofs/lean-toolchain"
printf '%s\n' 'name = "fixture_proofs"' 'defaultTargets = ["FixtureProofs"]' '' '[[lean_lib]]' 'name = "FixtureProofs"' 'roots = ["Verdict", "Bad"]' > "$T/proofs/lakefile.toml"
# the lean step is guarded by proofs/Verdict.lean (the kit ships proofs/ without proof files), so the fixture has one clean file too
printf '%s\n' 'theorem ok : 1 = 1 := rfl' > "$T/proofs/Verdict.lean"
printf '%s\n' 'theorem bad : 1 = 2 := sorry' > "$T/proofs/Bad.lean"
commit_fix
run_check full
# the fixture holds scripts/kani-check.sh but no contracts/airlock-verdict/harnesses.toml (the guard of the kani step, AIR-029), so
# the kani row must be a SKIP: a guard on the script itself would run cargo kani on a crate that is not there and fail it
finish_case 1 "full fails on a sorry, row lean is FAIL, row kani is SKIP" 1 \
  '^lean +[0-9]+s +FAIL$' '^kani +[0-9]+s +SKIP$' 'proofs/Bad.lean uses sorry' '!^FAILED \(full\):.* kani' 'L:^FAILED \(full\): .*lean'

echo "case 2: check.required names a missing path, quick"
mkfix
printf '%s\n' '# fixture: a comment, a blank line, a path that exists and one that does not' '' 'scripts/env.sh' 'scripts/nope.sh' > "$T/scripts/check.required"
commit_fix
run_check quick
finish_case 2 "a missing required path fails the run" 1 \
  '^MISSING REQUIRED: scripts/nope.sh$' '!MISSING REQUIRED: scripts/env.sh' '^required +[0-9]+s +FAIL$' 'L:^FAILED \(quick\): .*required'

echo "case 3: crate whose test asserts false, quick"
mkfix
mkcrate 5
commit_fix
run_check quick
finish_case 3 "quick fails on a failing test, only row verdict-test is FAIL" 1 \
  '^verdict-fmt +[0-9]+s +ok$' '^verdict-clippy +[0-9]+s +ok$' '^verdict-test +[0-9]+s +FAIL$' 'test result: FAILED' \
  'L:^FAILED \(quick\): verdict-test$'

echo "case 4: crate whose test passes, quick"
mkfix
mkcrate 4
commit_fix
run_check quick
finish_case 4 "quick exits 0, prints the table, TOTAL and ALL GREEN" 0 \
  '^verdict-fmt +[0-9]+s +ok$' '^verdict-clippy +[0-9]+s +ok$' '^verdict-test +[0-9]+s +ok$' '^policy-test +[0-9]+s +SKIP$' \
  '^TOTAL [0-9]+s$' 'L:^ALL GREEN \(quick'

echo "case 5: case 4 with CHECK_STRICT=1"
mkfix
mkcrate 4
commit_fix
run_check quick CHECK_STRICT=1
finish_case 5 "CHECK_STRICT=1 turns the skipped components into FAIL" 1 \
  '^verdict-test +[0-9]+s +ok$' '^policy-test +[0-9]+s +FAIL$' '^TOTAL [0-9]+s$' 'L:^FAILED \(quick\)'

if [ "$OK" -eq "$TOTAL_CASES" ]; then
  echo "CHECK TESTS OK ($OK of $TOTAL_CASES)"
  exit 0
fi
echo "CHECK TESTS FAILED ($OK of $TOTAL_CASES ok)"
exit 1
