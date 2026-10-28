#!/usr/bin/env bash
# Fixture tests for scripts/fresh-clone-check.sh and scripts/g5-check.sh (AIR-281; cases 10 to 14 are AIR-254's steps (a) to (e)).
# Each case builds its own tree in a mktemp -d: origin.git (a bare repository whose HEAD is main), work (the working repository: a
# clone of it holding the real scripts under test, a stub scripts/env.sh, scripts/check.sh and scripts/evidence-pins.sh, the stubs of
# the five G5 steps (scripts/demo.ts and scripts/evidence-check.ts are shell scripts that the stub pnpm runs, then
# scripts/bench-replay-check.sh, scripts/claims-run.sh and scripts/privacy-screen.sh), the stubs of the three more commands that --record
# runs since AIR-285 (scripts/kani-check.sh, scripts/lean-axioms.sh, scripts/diff-verdict.sh) next to the real
# scripts/evidence-transcript.sh, a docs/EVIDENCE.md and a docs/BENCH.md fixture and one pushed commit made as erfan-7116) and tmp (the
# TMPDIR the scripts under test get, so "the temp directories are gone" is a fact about that folder). The tools the steps look for sit
# outside the repository: nodebin/node and pnpmbin/pnpm (stubs, in two folders of their own so that the demo's PATH can be checked
# exactly) and rustbin/cargo and rustc, which the demo must never see; every run gets them first on its PATH.
# No git config anywhere: author and committer travel in GIT_AUTHOR_* and GIT_COMMITTER_*, and GIT_CONFIG_GLOBAL=/dev/null with
# GIT_CONFIG_NOSYSTEM=1 keeps the user's own git configuration out of the fixtures without touching it. No network:
# FRESH_CLONE_SKIP_INSTALL=1 (and G5_TEST_MODE=1 for g5-check.sh) because the fixtures have no lockfile.
# Cases:
#   1 clone script: both DURATION lines, the stub check saw an empty target directory other than the exported one, FRESH CLONE OK
#   2 a check that needs a file only the working tree has fails as FRESH CLONE FAIL quick
#   3 the TMPDIR folder is empty after a success and after a failure (quick, full, clone, a check that exits 0 without ALL GREEN, one that prints ALL GREEN and exits 1)
#   4 --keep leaves both directories and names them in the file
#   5 g5-check.sh with an unpushed commit reports the SHA of origin/main, not of HEAD
#   6 --record inserts one "## G5 fresh clone" section above "## Model choice", which stays the last heading
#   7 a second --record replaces the section; no "## Model choice" heading makes --record exit 1 and leave the file alone
#   8 a run without --record leaves git status of the working repository empty
#   9 FRESH_CLONE_SKIP_INSTALL=1 without G5_TEST_MODE ends G5 FAIL install was skipped; the clone script refuses it when CI is set
#  10 all five steps pass (claims with a pending count too, also with 0 rows): four DURATION lines (quick, full, demo, replay), one PRIVACY line, the steps in order, the arguments of
#     each, AIR-254's check 4 on the captured output, the last line G5 OK sha=; a demo ready in 0s; a last line printed on stderr;
#     each duration being its own step's time (a demo and a replay of two seconds each); a process the demo leaves behind not
#     holding up the run
#  11 each of (a) to (e) failing in every way a stub can fail (exits 1 without its last line, prints it and exits 1, exits 0 without
#     it, prints it with a count of 0 (for claims only without a pending count), a malformed pending count, and for (b) a regenerated
#     docs/BENCH.md): exit 1, the last line G5 FAIL <step>, no later step
#     ran, no DURATION line of the failed step, no record written, no temp directory left
#  12 the demo: PATH is exactly the node folder, the pnpm folder, /usr/bin and /bin (no Rust); HOME is an empty folder of the run
#     that is deleted afterwards; web/dist (built by check.sh full) is removed first; nothing else of the caller's environment
#     arrives except COREPACK_HOME (and only when that folder exists); cargo, rustc or rustup next to node or pnpm ends
#     G5 FAIL demo, and so does a PATH without node or without pnpm
#  13 the steps (b) to (d) run in the clone, after its scripts/env.sh was sourced once more, with the clone script's target
#     directory as CARGO_TARGET_DIR whatever the caller exported; env.sh failing for g5-check.sh ends G5 FAIL env
#  14 the privacy dry run: REPO read from the clone's origin (also the scp form, a token before the host and no .git suffix), run in
#     the clone, PRIVACY clean on exit 0, PRIVACY HITS <n> with n the output lines that do not start with a space (a missing
#     pattern file, a silent failure, a missing script and indented lines only count as 1), the matched text never printed, and the
#     run still ends G5 OK
# Usage: scripts/test-fresh-clone.sh     (any directory; the scripts under test sit next to this file)
# Last line: FRESH CLONE TESTS OK (14 of 14)
set -uo pipefail

SELF=$(cd "$(dirname "$0")" && pwd -P)
CLONE_SCRIPT="$SELF/fresh-clone-check.sh"
G5_SCRIPT="$SELF/g5-check.sh"
TOTAL_CASES=14
OK=0
CLEAN=""
T=""
OUT=""
RC=0
BAD=""
trap 'for d in $CLEAN; do case "$d" in */fct.*) rm -rf "$d";; esac; done' EXIT

export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1

if [ ! -f "$CLONE_SCRIPT" ] || [ ! -f "$G5_SCRIPT" ]; then
  echo "missing $CLONE_SCRIPT or $G5_SCRIPT"
  echo "FRESH CLONE TESTS FAILED (0 of $TOTAL_CASES ok)"
  exit 1
fi

git_as() {
  env GIT_AUTHOR_NAME=erfan-7116 GIT_AUTHOR_EMAIL=erfan@welcomeaide.com \
    GIT_COMMITTER_NAME=erfan-7116 GIT_COMMITTER_EMAIL=erfan@welcomeaide.com git "$@"
}

# ---- fixture files (all written into $T/work) ----
# write_env [g5fail]: the fixture's scripts/env.sh. It reads a variable that is never set (as nvm.sh does, which fails under set -u),
# exports FIXTURE_ENV_SOURCED so that a test can tell whether a step ran after it was sourced, and keeps an exported CARGO_TARGET_DIR
# like the real one. "g5fail" makes it fail when g5-check.sh sources it (the clone script and its check.sh still pass).
write_env() {
  {
    printf '%s\n' '# fixture env: keeps an exported CARGO_TARGET_DIR, like the real scripts/env.sh'
    [ "${1:-}" != g5fail ] || printf '%s\n' 'case "$0" in *g5-check.sh) echo "fixture env: refused for g5-check.sh"; return 1;; esac'
    printf '%s\n' '_probe=$FIXTURE_NEVER_SET_LIKE_NVM_SH' 'export FIXTURE_ENV_SOURCED=yes' \
      'export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$HOME/.cache/fct-fixture-target}"'
  } > "$T/work/scripts/env.sh"
}

# write_check <pass|local|failfull|silent|liar>: the fixture's scripts/check.sh; it prints the target directory it sees and how many entries
# that directory holds, so a test can tell an empty directory of the clone script's own making from the caller's exported one; its full
# mode leaves a web/dist behind, as the real one does with its web build
write_check() {
  local f="$T/work/scripts/check.sh"
  {
    printf '%s\n' '#!/usr/bin/env bash' 'set -euo pipefail' 'cd "$(dirname "$0")/.."' 'set +u' 'source scripts/env.sh' 'set -u'
    case "$1" in
      local) printf '%s\n' '[ -f local-only.txt ] || { echo "stub check: local-only.txt is missing"; exit 1; }';;
      failfull) printf '%s\n' '[ "$1" != full ] || { echo "stub check: full fails"; exit 1; }';;
      silent) printf '%s\n' 'echo "stub check: exits 0 and prints no ALL GREEN line"; exit 0';;
      liar) printf '%s\n' 'echo "ALL GREEN ($1)"; exit 1';;
    esac
    printf '%s\n' 'echo "STUB $1 target=$CARGO_TARGET_DIR entries=$(ls -A "$CARGO_TARGET_DIR" | wc -l | tr -d " ")"' \
      'if [ "$1" = full ]; then mkdir -p web/dist; : > web/dist/index.html; fi' \
      'echo "ALL GREEN ($1)"'
  } > "$f"
  chmod +x "$f"
}

# write_record_scripts: the commands that g5-check.sh --record runs besides the steps (AIR-285), as stubs that print one line and pass
write_record_scripts() {
  local s="$T/work/scripts"
  printf '%s\n' '#!/usr/bin/env bash' 'echo "KANI OK: 1 harnesses"' > "$s/kani-check.sh"
  printf '%s\n' '#!/usr/bin/env bash' 'echo "AXIOMS OK: 1 theorems"' 'echo "LEANCHECKER OK"' > "$s/lean-axioms.sh"
  printf '%s\n' '#!/usr/bin/env bash' 'echo "Lean and Rust verdicts identical on 40000 cases"' > "$s/diff-verdict.sh"
  chmod +x "$s/kani-check.sh" "$s/lean-axioms.sh" "$s/diff-verdict.sh"
}

write_pins() {
  printf '%s\n' '#!/usr/bin/env bash' \
    "printf '%s\\n' '| tool | pinned | actual | status |' '| --- | --- | --- | --- |' '| fixturetool | 1.2 | 1.2 | ok |' '' 'commit fixture'" \
    > "$T/work/scripts/evidence-pins.sh"
  chmod +x "$T/work/scripts/evidence-pins.sh"
}

# write_evidence <with|without>: docs/EVIDENCE.md with a Pins section and, for "with", the Model choice section last
write_evidence() {
  mkdir -p "$T/work/docs"
  {
    printf '%s\n' '# Evidence log' '' '## Pins' '' '| What | Network | Id / hash / link | Date |' '| --- | --- | --- | --- |' \
      '| Policy contract account | testnet | fixture.testnet | 2026-11-01 |' ''
    if [ "$1" = with ]; then
      printf '%s\n' '## Model choice' '' 'planner model: fixture-planner' 'quarantine model: fixture-quarantine' 'vanilla models: fixture-vanilla'
    else
      printf '%s\n' '## Notes' '' 'there is no model section here'
    fi
  } > "$T/work/docs/EVIDENCE.md"
}

# write_tools: the tools the G5 steps look for, outside the repository. node and pnpm are stubs in two folders of their own (step (a) puts
# exactly those two folders on the demo's PATH); "pnpm demo <args>" runs scripts/demo.ts and "pnpm tsx <file>" runs that file, both as
# shell scripts of the fixture. rustbin holds a cargo and a rustc that the demo must never find.
write_tools() {
  mkdir -p "$T/nodebin" "$T/pnpmbin" "$T/rustbin"
  printf '%s\n' '#!/usr/bin/env bash' 'echo v24.0.0' > "$T/nodebin/node"
  printf '%s\n' '#!/usr/bin/env bash' 'case "${1:-}" in' \
    '  demo) shift; exec bash scripts/demo.ts "$@";;' \
    '  tsx) shift; f=$1; shift; exec bash "$f" "$@";;' \
    '  *) echo "fixture pnpm: unexpected arguments: $*"; exit 9;;' 'esac' > "$T/pnpmbin/pnpm"
  printf '%s\n' '#!/usr/bin/env bash' 'echo "fixture cargo"' > "$T/rustbin/cargo"
  cp "$T/rustbin/cargo" "$T/rustbin/rustc"
  chmod +x "$T/nodebin/node" "$T/pnpmbin/pnpm" "$T/rustbin/cargo" "$T/rustbin/rustc"
}

# step_tail <kind> <ok line> <zero line>: the end of a fixture step. pass prints the ok line; fail exits 1 without it; liar prints it and
# exits 1; silent exits 0 without it; zero exits 0 with the zero line (the same form with a count of 0); slow sleeps 2 seconds first;
# err prints the ok line on stderr; leak leaves a background process that holds stdout open for 6 seconds, as a server left behind does;
# pend, allpend, badpend and zeropend append " (2 pending)" to the ok line, " (6 pending)" to the zero line, " (many pending)" to the
# ok line and " (0 pending)" to the zero line (claims-run.sh appends " (<p> pending)" while a row is pending)
step_tail() {
  case "$1" in
    pend) printf '%s\n' "echo \"$2 (2 pending)\"";;
    allpend) printf '%s\n' "echo \"$3 (6 pending)\"";;
    badpend) printf '%s\n' "echo \"$2 (many pending)\"";;
    zeropend) printf '%s\n' "echo \"$3 (0 pending)\"";;
    slow) printf '%s\n' 'sleep 2' "echo \"$2\"";;
    leak) printf '%s\n' '( sleep 6 ) &' "echo \"$2\"";;
    err) printf '%s\n' "echo \"$2\" >&2";;
    fail) printf '%s\n' 'echo "stub step: failed"' 'exit 1';;
    liar) printf '%s\n' "echo \"$2\"" 'exit 1';;
    silent) printf '%s\n' 'echo "stub step: done, nothing to report"';;
    zero) printf '%s\n' "echo \"$3\"";;
    *) printf '%s\n' "echo \"$2\"";;
  esac
}

# write_steps <variant>: the five G5 steps and docs/BENCH.md in $T/work, committed with the rest of scripts/ so that they run in the clone.
# The variant is pass, or a step name followed by a kind, several separated by commas: demo, replay, claims, evidence, priv + fail, liar,
# silent, zero, slow, err, leak, pend, allpend, badpend, zeropend (see step_tail);
# replaydiff regenerates docs/BENCH.md; privhits, privmissing, privsilent, privindent and privabsent are the privacy screen's ways to report. Each
# stub prints a STEP line with what a test needs to know (arguments, cwd, PATH, HOME, target directory); the privacy stub writes its
# record to $T/privacy.rec instead, because everything it prints is read by the script under test.
write_steps() {
  local v=${1:-pass} s="$T/work/scripts" dk=pass rk=pass ck=pass ek=pass pk=pass part
  for part in ${v//,/ }; do
    case "$part" in
      demo*) dk=${part#demo};;
      replay*) rk=${part#replay};;
      claims*) ck=${part#claims};;
      evidence*) ek=${part#evidence};;
      priv*) pk=${part#priv};;
    esac
  done
  mkdir -p "$T/work/docs"
  printf '%s\n' '# bench' '' '| model | n |' '| --- | --- |' '| fixture | 30 |' > "$T/work/docs/BENCH.md"
  {
    printf '%s\n' '#!/usr/bin/env bash' \
      'echo "STEP demo args=$* cwd=$(pwd -P)"' \
      'echo "STEP demo path=$PATH"' \
      'echo "STEP demo home=$HOME"' \
      'echo "STEP demo home_entries=$(ls -A "$HOME" | wc -l | tr -d " ")"' \
      'echo "STEP demo fixture_env=${FIXTURE_ENV_SOURCED:-no}"' \
      'echo "STEP demo web_dist=$([ -e web/dist ] && echo present || echo absent)"' \
      'echo "STEP demo sentinel=${AIRLOCK_TEST_SENTINEL:-unset} target=${CARGO_TARGET_DIR:-unset} corepack_home=${COREPACK_HOME:-unset}"' \
      'echo "STEP demo cargo=$(command -v cargo || echo none) rustc=$(command -v rustc || echo none)"' \
      'echo "console http://127.0.0.1:4173"'
    step_tail "$dk" 'ready in 2s' 'ready in 0s'
  } > "$s/demo.ts"
  {
    printf '%s\n' '#!/usr/bin/env bash' 'echo "STEP replay env=${FIXTURE_ENV_SOURCED:-no}"' 'echo "STEP replay cargo=$(command -v cargo || echo none)"' \
      'echo "STEP replay cwd=$(pwd -P) target=${CARGO_TARGET_DIR:-unset}"'
    [ "$rk" != diff ] || printf '%s\n' 'echo "| regenerated | 31 |" >> docs/BENCH.md'
    step_tail "$rk" 'BENCH REPLAY OK 30 runs, block unchanged' 'BENCH REPLAY OK 0 runs, block unchanged'
  } > "$s/bench-replay-check.sh"
  {
    printf '%s\n' '#!/usr/bin/env bash' 'echo "STEP claims env=${FIXTURE_ENV_SOURCED:-no}"' 'echo "STEP claims args=$* cwd=$(pwd -P) target=${CARGO_TARGET_DIR:-unset}"'
    step_tail "$ck" 'CLAIMS OFFLINE OK 12 rows' 'CLAIMS OFFLINE OK 0 rows'
  } > "$s/claims-run.sh"
  {
    printf '%s\n' '#!/usr/bin/env bash' 'echo "STEP evidence env=${FIXTURE_ENV_SOURCED:-no}"' 'echo "STEP evidence file=$0 args=$* cwd=$(pwd -P) target=${CARGO_TARGET_DIR:-unset}"'
    step_tail "$ek" 'EVIDENCE OK 7 links checked' 'EVIDENCE OK 0 links checked'
  } > "$s/evidence-check.ts"
  {
    printf '%s\n' '#!/usr/bin/env bash' "echo \"repo=\${REPO:-unset} cwd=\$(pwd -P)\" >> '$T/privacy.rec'"
    case "$pk" in
      hits) printf '%s\n' 'echo "FILE docs/notes.md"' 'echo "    3:contact jane.doe@example.com"' 'echo "HISTORY (git log --all)"' \
        'echo "    1f2e3d jane.doe@example.com"' 'echo " one space is not a label"' 'echo "ERROR could not list issues for acme/airlock"' \
        'echo "privacy screen: FIX the matches or errors above before going public"' 'exit 1';;
      missing) printf '%s\n' 'echo "no pattern file at /nowhere/privacy-patterns; create it (one regex per line) before screening"' 'exit 2';;
      silent) printf '%s\n' 'exit 1';;
      indent) printf '%s\n' 'echo "    3:only indented lines"' 'exit 1';;
      *) printf '%s\n' 'echo "privacy screen: clean (3 files, history, issues, PRs, review comments)"';;
    esac
  } > "$s/privacy-screen.sh"
  [ "$pk" != absent ] || rm -f "$s/privacy-screen.sh"
  chmod +x "$s/bench-replay-check.sh" "$s/claims-run.sh" "$s/demo.ts" "$s/evidence-check.ts"
  [ -f "$s/privacy-screen.sh" ] && chmod +x "$s/privacy-screen.sh"
  return 0
}

# commit_push <message> <path>...: stage by name, commit as erfan-7116, push main to the bare origin
commit_push() {
  local m=$1; shift
  ( cd "$T/work" && git add "$@" && git_as commit -q -m "$m" && git push -q origin main ) >/dev/null 2>&1 \
    || { echo "fixture commit or push failed in $T"; exit 1; }
}

# a fresh tree in T: bare origin, working repository with one pushed commit, an empty tmp folder, the stub tools and the passing steps.
# With GH_ORIGIN set the bare origin lives where its URL reads like a GitHub one: 1 is $T/github.com/acme/airlock.git, colon is
# $T/github.com:acme/airlock.git (the scp form), token puts x-access-token:SECRET@ before github.com, nogit has no .git suffix. OG is
# the path of the bare origin.
mkfix() {
  T=$(mktemp -d "${TMPDIR:-/tmp}/fct.XXXXXX") || exit 1
  CLEAN="$CLEAN $T"
  mkdir "$T/tmp"
  OGD=""
  OG="$T/origin.git"
  case "${GH_ORIGIN:-0}" in
    1) OGD="$T/github.com/acme"; OG="$OGD/airlock.git";;
    colon) OGD="$T/github.com:acme"; OG="$OGD/airlock.git";;
    token) OGD="$T/x-access-token:SECRET@github.com/acme"; OG="$OGD/airlock.git";;
    nogit) OGD="$T/github.com/acme"; OG="$OGD/airlock";;
  esac
  [ -z "$OGD" ] || mkdir -p "$OGD" || exit 1
  git init -q --bare "$OG" || exit 1
  git --git-dir="$OG" symbolic-ref HEAD refs/heads/main || exit 1
  git clone -q "$OG" "$T/work" 2>/dev/null || exit 1
  git -C "$T/work" symbolic-ref HEAD refs/heads/main || exit 1
  mkdir "$T/work/scripts"
  cp "$CLONE_SCRIPT" "$G5_SCRIPT" "$SELF/evidence-transcript.sh" "$T/work/scripts/" || exit 1
  chmod +x "$T/work/scripts/"*.sh
  write_env
  write_check pass
  write_record_scripts
  write_pins
  write_evidence with
  write_tools
  write_steps pass
  commit_push 'test(fresh-clone): fixture' scripts docs
}

# run <dir> [VAR=value ...] <command> [args]: sets OUT (stdout and stderr) and RC. The variables that change behaviour are cleared
# first, so the caller's shell cannot change a case; TMPDIR is the fixture's own folder; the stub node, pnpm, cargo and rustc come first
# on the PATH (a later PATH=... among the arguments replaces it).
run() {
  local dir=$1
  shift
  OUT=$(cd "$dir" && env -u CI -u G5_TEST_MODE -u FRESH_CLONE_SKIP_INSTALL -u CHECK_ROOT -u CHECK_STRICT -u CARGO_TARGET_DIR -u COREPACK_HOME -u AIRLOCK_TEST_SENTINEL \
    TMPDIR="$T/tmp" PATH="$T/nodebin:$T/pnpmbin:$T/rustbin:$PATH" "$@" 2>&1)
  RC=$?
}

# ---- assertions: each prints nothing and returns 0 or 1; chk records a failure under its description ----
has() { grep -Eq -e "$1" <<<"$OUT"; }
lacks() { ! grep -Eq -e "$1" <<<"$OUT"; }
contains() { grep -qF -e "$1" <<<"$OUT"; }
not_contains() { ! grep -qF -e "$1" <<<"$OUT"; }
has_line() { grep -qxF -e "$1" <<<"$OUT"; }
last_is() { [ "$(printf '%s\n' "$OUT" | tail -1)" = "$1" ]; }
last_has() { printf '%s\n' "$OUT" | tail -1 | grep -Eq -e "$1"; }
rc_is() { [ "$RC" -eq "$1" ]; }
rc_not0() { [ "$RC" -ne 0 ]; }
tmp_empty() { [ -z "$(ls -A "$T/tmp")" ]; }
in_ok() { local d=$1; shift; ( cd "$d" && "$@" ) >/dev/null 2>&1; }
# the text after a prefix on the first line of OUT that starts with it; the line number of the first line that matches a pattern
tail_of() { sed -n "s/^$1//p" <<<"$OUT" | head -1; }
lineno() { grep -nE -m1 -e "$1" <<<"$OUT" | cut -d: -f1; }
before() { [ "$(lineno "$1")" -lt "$(lineno "$2")" ] 2>/dev/null; }
# AIR-254's check 4, word for word, on a file
check4() {
  test "$(grep -cE '^DURATION (quick|full|demo|replay) [0-9]+s$' "$1")" = 4 && grep -E '^DURATION demo ' "$1" | awk '{exit !($3 + 0 < 61)}' && grep -qE '^PRIVACY (clean|HITS [0-9]+)$' "$1"
}
check4_fails() { ! check4 "$1"; }
chk() { local d=$1; shift; "$@" || BAD="$BAD [$d]"; }

# the lines of the "## G5 fresh clone" section (without its heading), and the file without that section
g5_section() { awk '/^## G5 fresh clone/{f=1; next} /^## /{f=0} f' "$1"; }
strip_section() { awk '/^## G5 fresh clone/{s=1; next} /^## /{s=0} !s' "$1"; }
headings() { grep '^## ' "$1" | paste -sd '|' -; }

end_case() { # n description
  if [ -z "$BAD" ]; then
    OK=$((OK + 1))
    echo "PASS case $1: $2"
  else
    echo "FAIL case $1: $2:$BAD"
    printf '%s\n' "$OUT" | tail -25 | sed 's/^/    | /'
  fi
}

echo "fresh clone fixture tests (bare origin, stub check.sh, no network)"

# ---- case 1 ----
echo "case 1: clone script on a passing fixture, CARGO_TARGET_DIR exported to another directory"
mkfix
BAD=""
X="$T/exported-target"
mkdir "$X" && : > "$X/marker"
run "$T/work" CARGO_TARGET_DIR="$X" FRESH_CLONE_SKIP_INSTALL=1 ./scripts/fresh-clone-check.sh
chk "exit 0" rc_is 0
chk "DURATION quick line" has '^DURATION quick [0-9]+s$'
chk "DURATION full line" has '^DURATION full [0-9]+s$'
chk "SKIP install (test mode) line" has '^SKIP install \(test mode\)$'
chk "both steps saw an empty target directory" test "$(grep -c '^STUB .* entries=0$' <<<"$OUT")" = 2
chk "the target directory is not the exported one" not_contains "target=$X "
chk "the exported directory was not touched" test -f "$X/marker"
chk "last line FRESH CLONE OK elapsed=<n>" last_has '^FRESH CLONE OK elapsed=[0-9]+$'
# no reliance on exported shell variables: the same run under env -i
OUT=$(cd "$T/work" && env -i HOME="$HOME" PATH="$PATH" TMPDIR="$T/tmp" FRESH_CLONE_SKIP_INSTALL=1 ./scripts/fresh-clone-check.sh 2>&1)
RC=$?
chk "env -i run: exit 0" rc_is 0
chk "env -i run: empty target directory in both steps" test "$(grep -c '^STUB .* entries=0$' <<<"$OUT")" = 2
chk "env -i run: last line FRESH CLONE OK" last_has '^FRESH CLONE OK elapsed=[0-9]+$'
end_case 1 "both DURATION lines, empty target directory of its own, FRESH CLONE OK elapsed=<n>"

# ---- case 2 ----
echo "case 2: check.sh needs a file that only the working tree has"
mkfix
BAD=""
write_check local
commit_push 'test(fresh-clone): check needs local-only.txt' scripts
: > "$T/work/local-only.txt"   # untracked, never committed
chk "the working tree itself passes the fixture check" in_ok "$T/work" ./scripts/check.sh quick
run "$T/work" FRESH_CLONE_SKIP_INSTALL=1 ./scripts/fresh-clone-check.sh
chk "exit 1" rc_is 1
chk "last line FRESH CLONE FAIL quick" last_is 'FRESH CLONE FAIL quick'
chk "no DURATION line for the failed step" lacks '^DURATION '
chk "the failing step's own message is shown" has 'local-only.txt is missing'
chk "TMPDIR folder is empty" tmp_empty
end_case 2 "local state is found: exit 1 and FRESH CLONE FAIL quick"

# ---- case 3 ----
echo "case 3: the TMPDIR folder is empty after a success and after every kind of failure"
mkfix
BAD=""
run "$T/work" FRESH_CLONE_SKIP_INSTALL=1 ./scripts/fresh-clone-check.sh
chk "a: success exits 0" rc_is 0
chk "a: success ends FRESH CLONE OK" last_has '^FRESH CLONE OK elapsed=[0-9]+$'
chk "a: TMPDIR folder is empty after a success" tmp_empty
mkfix
write_check local
commit_push 'test(fresh-clone): check needs local-only.txt' scripts
run "$T/work" FRESH_CLONE_SKIP_INSTALL=1 ./scripts/fresh-clone-check.sh
chk "b: quick failure exits 1" rc_is 1
chk "b: quick failure ends FRESH CLONE FAIL quick" last_is 'FRESH CLONE FAIL quick'
chk "b: TMPDIR folder is empty after a quick failure" tmp_empty
mkfix
write_check failfull
commit_push 'test(fresh-clone): full fails' scripts
run "$T/work" FRESH_CLONE_SKIP_INSTALL=1 ./scripts/fresh-clone-check.sh
chk "c: full failure exits 1" rc_is 1
chk "c: full failure ends FRESH CLONE FAIL full" last_is 'FRESH CLONE FAIL full'
chk "c: quick still printed its duration" has '^DURATION quick [0-9]+s$'
chk "c: no DURATION full line" lacks '^DURATION full '
chk "c: TMPDIR folder is empty after a full failure" tmp_empty
mkfix
rm -rf "$T/origin.git"
run "$T/work" FRESH_CLONE_SKIP_INSTALL=1 ./scripts/fresh-clone-check.sh
chk "d: clone failure exits 1" rc_is 1
chk "d: clone failure ends FRESH CLONE FAIL clone" last_is 'FRESH CLONE FAIL clone'
chk "d: TMPDIR folder is empty after a clone failure" tmp_empty
mkfix
write_check silent
commit_push 'test(fresh-clone): check exits 0 without ALL GREEN' scripts
run "$T/work" FRESH_CLONE_SKIP_INSTALL=1 ./scripts/fresh-clone-check.sh
chk "e: a check that exits 0 without an ALL GREEN line exits 1" rc_is 1
chk "e: ... and ends FRESH CLONE FAIL quick" last_is 'FRESH CLONE FAIL quick'
chk "e: TMPDIR folder is empty" tmp_empty
mkfix
write_check liar
commit_push 'test(fresh-clone): check prints ALL GREEN and exits 1' scripts
run "$T/work" FRESH_CLONE_SKIP_INSTALL=1 ./scripts/fresh-clone-check.sh
chk "f: a check that prints ALL GREEN and exits 1 exits 1" rc_is 1
chk "f: ... and ends FRESH CLONE FAIL quick" last_is 'FRESH CLONE FAIL quick'
chk "f: TMPDIR folder is empty" tmp_empty
end_case 3 "no temp directory is left behind, success or failure"

# ---- case 4 ----
echo "case 4: --keep leaves both directories and names them in the file"
mkfix
BAD=""
KEEPF="$T/keepfile"
run "$T/work" FRESH_CLONE_SKIP_INSTALL=1 ./scripts/fresh-clone-check.sh --keep "$KEEPF"
chk "exit 0" rc_is 0
chk "last line FRESH CLONE OK" last_has '^FRESH CLONE OK elapsed=[0-9]+$'
K_CLONE=$(sed -n 's/^CLONE=//p' "$KEEPF" 2>/dev/null)
K_TARGET=$(sed -n 's/^TARGET=//p' "$KEEPF" 2>/dev/null)
chk "the file names a CLONE directory that exists" test -n "$K_CLONE" -a -d "$K_CLONE"
chk "the file names a TARGET directory that exists" test -n "$K_TARGET" -a -d "$K_TARGET"
chk "the clone is a git clone of origin" test "$(git -C "${K_CLONE:-/nonexistent}" rev-parse HEAD 2>/dev/null)" = "$(git --git-dir="$T/origin.git" rev-parse refs/heads/main)"
chk "the target directory is empty and not the clone" test -z "$(ls -A "${K_TARGET:-/nonexistent}" 2>/dev/null)" -a "$K_TARGET" != "$K_CLONE"
chk "only those two directories are left in TMPDIR" test "$(ls -A "$T/tmp" | wc -l | tr -d ' ')" = 2
end_case 4 "--keep leaves CLONE and TARGET and names them"

# ---- case 5 ----
echo "case 5: g5-check.sh with a local commit that is not pushed"
mkfix
BAD=""
: > "$T/work/extra.txt"
( cd "$T/work" && git add extra.txt && git_as commit -q -m 'test(fresh-clone): local only' ) >/dev/null 2>&1
ORIGIN_SHA=$(git --git-dir="$T/origin.git" rev-parse refs/heads/main)
HEAD_SHA=$(git -C "$T/work" rev-parse HEAD)
chk "fixture: HEAD differs from origin/main" test "$ORIGIN_SHA" != "$HEAD_SHA"
run "$T/work" FRESH_CLONE_SKIP_INSTALL=1 G5_TEST_MODE=1 ./scripts/g5-check.sh
chk "exit 0" rc_is 0
chk "last line is G5 OK sha= the SHA of origin/main" last_is "G5 OK sha=$ORIGIN_SHA"
chk "the SHA of HEAD is nowhere in the output" not_contains "$HEAD_SHA"
chk "the clone script's DURATION lines are printed" has '^DURATION quick [0-9]+s$'
chk "the clone script's DURATION full line is printed" has '^DURATION full [0-9]+s$'
chk "TMPDIR folder is empty" tmp_empty
end_case 5 "the clone comes from origin: G5 OK sha= is origin/main, not HEAD"

# ---- case 6 ----
echo "case 6: --record on a fixture whose EVIDENCE.md has ## Pins and ## Model choice"
mkfix
BAD=""
EV="$T/work/docs/EVIDENCE.md"
cp "$EV" "$T/EVIDENCE.orig"
ORIGIN_SHA=$(git --git-dir="$T/origin.git" rev-parse refs/heads/main)
run "$T/work" FRESH_CLONE_SKIP_INSTALL=1 G5_TEST_MODE=1 ./scripts/g5-check.sh --record
chk "exit 0" rc_is 0
chk "last line G5 OK sha=" last_is "G5 OK sha=$ORIGIN_SHA"
chk "exactly one section heading" test "$(grep -c '^## G5 fresh clone$' "$EV")" = 1
chk "the headings are Pins, G5 fresh clone, Model choice, in that order" test "$(headings "$EV")" = '## Pins|## G5 fresh clone|## Model choice'
chk "## Model choice is still the last heading" test "$(grep '^## ' "$EV" | tail -1)" = '## Model choice'
g5_section "$EV" > "$T/section.txt"
SEC=$(cat "$T/section.txt")
chk "the section holds the clone SHA" grep -qF "$ORIGIN_SHA" "$T/section.txt"
chk "the section holds the DURATION quick line" grep -Eq '^DURATION quick [0-9]+s$' "$T/section.txt"
chk "the section holds the DURATION full line" grep -Eq '^DURATION full [0-9]+s$' "$T/section.txt"
chk "the section holds the DURATION demo line" grep -Eq '^DURATION demo [0-9]+s$' "$T/section.txt"
chk "the section holds the DURATION replay line" grep -Eq '^DURATION replay [0-9]+s$' "$T/section.txt"
chk "the section holds exactly the four DURATION lines the run printed" test "$(grep -c '^DURATION ' "$T/section.txt")" = 4
chk "the section does not hold the PRIVACY line" test "$(grep -c '^PRIVACY' "$T/section.txt")" = 0
chk "the section holds the pins table" grep -qF '| fixturetool | 1.2 | 1.2 | ok |' "$T/section.txt"
chk "the section holds the machine line" grep -qF "Machine: macOS $(sw_vers -productVersion 2>/dev/null), $(/usr/sbin/sysctl -n machdep.cpu.brand_string 2>/dev/null)" "$T/section.txt"
chk "the section holds a date" grep -Eq '^- Date: [0-9]{4}-[0-9]{2}-[0-9]{2} ' "$T/section.txt"
chk "the section names the warm caches" grep -qi 'warm' "$T/section.txt"
chk "the section does not leak the home folder, a temp path or an env file" test "$(grep -cE "$HOME|$T|\.env|origin\.git" "$T/section.txt")" = 0
strip_section "$EV" > "$T/stripped.txt"
chk "without the section the file is the original" cmp -s "$T/stripped.txt" "$T/EVIDENCE.orig"
chk "TMPDIR folder is empty" tmp_empty
: "$SEC"
end_case 6 "one G5 fresh clone section above Model choice with SHA, four durations, pins, machine"

# ---- case 7 ----
echo "case 7: a second --record, and EVIDENCE.md without ## Model choice"
mkfix
BAD=""
EV="$T/work/docs/EVIDENCE.md"
cp "$EV" "$T/EVIDENCE.orig"
OLD_SHA=$(git --git-dir="$T/origin.git" rev-parse refs/heads/main)
run "$T/work" FRESH_CLONE_SKIP_INSTALL=1 G5_TEST_MODE=1 ./scripts/g5-check.sh --record
chk "first record: exit 0" rc_is 0
: > "$T/work/bump.txt"
commit_push 'test(fresh-clone): another commit' bump.txt
NEW_SHA=$(git --git-dir="$T/origin.git" rev-parse refs/heads/main)
chk "fixture: the second commit has another SHA" test "$OLD_SHA" != "$NEW_SHA"
run "$T/work" FRESH_CLONE_SKIP_INSTALL=1 G5_TEST_MODE=1 ./scripts/g5-check.sh --record
chk "second record: exit 0" rc_is 0
chk "second record: last line G5 OK sha= the new SHA" last_is "G5 OK sha=$NEW_SHA"
chk "exactly one section heading after the second record" test "$(grep -c '^## G5 fresh clone$' "$EV")" = 1
chk "the section holds the new SHA" test "$(g5_section "$EV" | grep -cF "$NEW_SHA")" -ge 1
chk "the section no longer holds the old SHA" test "$(grep -cF "$OLD_SHA" "$EV")" = 0
chk "the headings are still Pins, G5 fresh clone, Model choice" test "$(headings "$EV")" = '## Pins|## G5 fresh clone|## Model choice'
strip_section "$EV" > "$T/stripped.txt"
chk "without the section the file is still the original" cmp -s "$T/stripped.txt" "$T/EVIDENCE.orig"
mkfix
write_evidence without
commit_push 'test(fresh-clone): evidence without Model choice' docs
EV="$T/work/docs/EVIDENCE.md"
cp "$EV" "$T/EVIDENCE.orig"
run "$T/work" FRESH_CLONE_SKIP_INSTALL=1 G5_TEST_MODE=1 ./scripts/g5-check.sh --record
chk "no Model choice: exit 1" rc_is 1
chk "no Model choice: the message is printed" has '^no ## Model choice heading$'
chk "no Model choice: the last line is a G5 FAIL" last_has '^G5 FAIL '
chk "no Model choice: the file is unchanged" cmp -s "$EV" "$T/EVIDENCE.orig"
chk "no Model choice: no G5 section was added" test "$(grep -c '^## G5 fresh clone' "$EV")" = 0
chk "no Model choice: TMPDIR folder is empty" tmp_empty
end_case 7 "--record replaces its section; a file without Model choice is refused and left alone"

# ---- case 8 ----
echo "case 8: a run without --record leaves the working repository untouched"
mkfix
BAD=""
chk "fixture: git status is empty before the run" test -z "$(git -C "$T/work" status --porcelain)"
cp "$T/work/docs/EVIDENCE.md" "$T/EVIDENCE.orig"
run "$T/work" FRESH_CLONE_SKIP_INSTALL=1 G5_TEST_MODE=1 ./scripts/g5-check.sh
chk "exit 0" rc_is 0
chk "last line G5 OK sha=" last_has '^G5 OK sha=[0-9a-f]{40}$'
chk "git status --porcelain is empty after the run" test -z "$(git -C "$T/work" status --porcelain)"
chk "docs/EVIDENCE.md is unchanged" cmp -s "$T/work/docs/EVIDENCE.md" "$T/EVIDENCE.orig"
chk "TMPDIR folder is empty" tmp_empty
end_case 8 "no --record: git status porcelain stays empty"

# ---- case 9 ----
echo "case 9: FRESH_CLONE_SKIP_INSTALL=1 without G5_TEST_MODE, and with CI set"
mkfix
BAD=""
run "$T/work" FRESH_CLONE_SKIP_INSTALL=1 ./scripts/g5-check.sh
chk "g5-check.sh exits 1" rc_is 1
chk "g5-check.sh last line is G5 FAIL install was skipped" last_is 'G5 FAIL install was skipped'
chk "g5-check.sh printed no G5 OK" lacks '^G5 OK'
chk "g5-check.sh left no temp directory" tmp_empty
run "$T/work" CI=1 FRESH_CLONE_SKIP_INSTALL=1 ./scripts/fresh-clone-check.sh
chk "clone script with CI set refuses: exit not 0" rc_not0
chk "clone script with CI set refuses: no FRESH CLONE OK" lacks '^FRESH CLONE OK'
chk "clone script with CI set refuses: the message names CI" has 'CI'
chk "clone script with CI set left no temp directory" tmp_empty
end_case 9 "a skipped install can never end G5 OK, and CI refuses the skip"

# ---- case 10 ----
echo "case 10: g5-check.sh with all five steps passing"
mkfix
BAD=""
ORIGIN_SHA=$(git --git-dir="$T/origin.git" rev-parse refs/heads/main)
run "$T/work" FRESH_CLONE_SKIP_INSTALL=1 G5_TEST_MODE=1 ./scripts/g5-check.sh
printf '%s\n' "$OUT" > "$T/g5.out"
chk "exit 0" rc_is 0
chk "last line G5 OK sha= the SHA of origin/main" last_is "G5 OK sha=$ORIGIN_SHA"
chk "exactly four DURATION lines" test "$(grep -c '^DURATION ' "$T/g5.out")" = 4
chk "the four are quick, full, demo and replay, in that order" test "$(grep '^DURATION ' "$T/g5.out" | awk '{printf "%s ", $2}')" = 'quick full demo replay '
chk "each has the form DURATION <name> <n>s" test "$(grep -cE '^DURATION (quick|full|demo|replay) [0-9]+s$' "$T/g5.out")" = 4
chk "exactly one PRIVACY line, and it is PRIVACY clean" test "$(grep -c '^PRIVACY ' "$T/g5.out")" = 1 -a "$(grep -c '^PRIVACY clean$' "$T/g5.out")" = 1
chk "the steps ran in the order demo, replay, claims, evidence" test "$(grep -o '^STEP [a-z]*' <<<"$OUT" | uniq | awk '{printf "%s ", $2}')" = 'demo replay claims evidence '
chk "DURATION demo is printed before the replay step starts" before '^DURATION demo ' '^STEP replay '
chk "DURATION replay is printed after the replay step and before the claims step" before '^STEP replay ' '^DURATION replay '
chk "... and before the claims step" before '^DURATION replay ' '^STEP claims '
chk "the evidence step comes before the PRIVACY line, which comes before the last line" before '^STEP evidence ' '^PRIVACY '
chk "the PRIVACY line is before the last line" before '^PRIVACY ' '^G5 OK '
chk "the demo gets --no-open --exit-when-ready" has '^STEP demo args=--no-open --exit-when-ready cwd='
chk "claims gets --offline" has '^STEP claims args=--offline cwd='
chk "the evidence check is run as pnpm tsx scripts/evidence-check.ts" has '^STEP evidence file=scripts/evidence-check\.ts args= cwd='
chk "AIR-254 check 4 passes on the captured output" check4 "$T/g5.out"
grep -v '^DURATION demo ' "$T/g5.out" > "$T/g5.nodemo"
sed 's/^DURATION demo .*/DURATION demo 61s/' "$T/g5.out" > "$T/g5.slow"
grep -v '^PRIVACY ' "$T/g5.out" > "$T/g5.nopriv"
chk "check 4 fails without the demo line (control)" check4_fails "$T/g5.nodemo"
chk "check 4 fails for a demo of 61 seconds (control)" check4_fails "$T/g5.slow"
chk "check 4 fails without the PRIVACY line (control)" check4_fails "$T/g5.nopriv"
chk "TMPDIR folder is empty" tmp_empty
chk "git status of the working repository is empty" test -z "$(git -C "$T/work" status --porcelain)"
# a demo that is ready in 0 seconds is a pass (the count of ready in <n>s may be 0; the other three counts may not)
mkfix
write_steps demozero
commit_push 'test(fresh-clone): demo ready in 0s' scripts docs
run "$T/work" FRESH_CLONE_SKIP_INSTALL=1 G5_TEST_MODE=1 ./scripts/g5-check.sh
chk "ready in 0s: exit 0" rc_is 0
chk "ready in 0s: last line G5 OK" last_has '^G5 OK sha=[0-9a-f]{40}$'
# the last line is read from stdout and stderr together, as the person watching the run sees them
mkfix
write_steps claimserr,demoerr
commit_push 'test(fresh-clone): claims and demo print their last line on stderr' scripts docs
run "$T/work" FRESH_CLONE_SKIP_INSTALL=1 G5_TEST_MODE=1 ./scripts/g5-check.sh
chk "last line on stderr: exit 0" rc_is 0
chk "last line on stderr: last line G5 OK" last_has '^G5 OK sha=[0-9a-f]{40}$'
# each DURATION is its own step's time: a demo and a replay that take two seconds each print 2 or 3, not 0 and not the sum
mkfix
write_steps demoslow,replayslow
commit_push 'test(fresh-clone): slow demo and slow replay' scripts docs
run "$T/work" FRESH_CLONE_SKIP_INSTALL=1 G5_TEST_MODE=1 ./scripts/g5-check.sh
chk "slow steps: exit 0" rc_is 0
chk "slow steps: DURATION demo is 2 or 3 seconds" has '^DURATION demo [23]s$'
chk "slow steps: DURATION replay is 2 or 3 seconds" has '^DURATION replay [23]s$'
# claims-run.sh appends " (<p> pending)" while a row is pending, and 0 rows is valid when every row is pending
for v in claimspend claimsallpend; do
  mkfix
  write_steps "$v"
  commit_push "test(fresh-clone): step variant $v" scripts docs
  run "$T/work" FRESH_CLONE_SKIP_INSTALL=1 G5_TEST_MODE=1 ./scripts/g5-check.sh
  chk "$v: exit 0" rc_is 0
  chk "$v: last line G5 OK" last_has '^G5 OK sha=[0-9a-f]{40}$'
  chk "$v: the claims line is the one with the pending count" has '^CLAIMS OFFLINE OK [0-9]+ rows \([0-9]+ pending\)$'
  chk "$v: the four DURATION lines" test "$(grep -cE '^DURATION (quick|full|demo|replay) [0-9]+s$' <<<"$OUT")" = 4
done
# a server the demo leaves behind must not hold the run up: the run ends with the demo, not with the leftover process
mkfix
write_steps demoleak
commit_push 'test(fresh-clone): demo leaves a process behind' scripts docs
SECONDS=0
run "$T/work" FRESH_CLONE_SKIP_INSTALL=1 G5_TEST_MODE=1 ./scripts/g5-check.sh
chk "a process left behind by the demo: exit 0" rc_is 0
chk "a process left behind by the demo: last line G5 OK" last_has '^G5 OK sha=[0-9a-f]{40}$'
chk "a process left behind by the demo: the run did not wait for it (under 5 seconds)" test "$SECONDS" -lt 5
end_case 10 "four DURATION lines, one PRIVACY line, steps in order, check 4 passes, each duration its own step's, G5 OK, no wait for a leftover process"

# ---- case 11 ----
echo "case 11: each of the steps (a) to (e) failing, in every way a stub can fail"
BAD=""
# expect_fail <variant> <step> <message>: a fixture whose <step> fails the way <variant> says; the run ends G5 FAIL <step> and the steps
# after it do not run
expect_fail() {
  local v=$1 st=$2 msg=$3 s seen=1
  mkfix
  write_steps "$v"
  commit_push "test(fresh-clone): step variant $v" scripts docs
  run "$T/work" FRESH_CLONE_SKIP_INSTALL=1 G5_TEST_MODE=1 ./scripts/g5-check.sh
  chk "$v: exit 1" rc_is 1
  chk "$v: last line G5 FAIL $st" last_is "G5 FAIL $st"
  chk "$v: no G5 OK line" lacks '^G5 OK'
  chk "$v: the line before says what happened" has "$msg"
  for s in demo replay claims evidence; do
    if [ "$seen" = 1 ]; then chk "$v: step $s ran" has "^STEP $s "; else chk "$v: step $s did not run" lacks "^STEP $s "; fi
    [ "$s" = "$st" ] && seen=0
  done
  case "$st" in
    demo) chk "$v: no DURATION demo line" lacks '^DURATION demo '; chk "$v: no DURATION replay line" lacks '^DURATION replay ';;
    replay) chk "$v: DURATION demo was printed" has '^DURATION demo [0-9]+s$'; chk "$v: no DURATION replay line" lacks '^DURATION replay ';;
    *) chk "$v: DURATION demo was printed" has '^DURATION demo [0-9]+s$'; chk "$v: DURATION replay was printed" has '^DURATION replay [0-9]+s$';;
  esac
  chk "$v: DURATION quick and full were printed" test "$(grep -cE '^DURATION (quick|full) [0-9]+s$' <<<"$OUT")" = 2
  chk "$v: no PRIVACY line" lacks '^PRIVACY '
  chk "$v: TMPDIR folder is empty" tmp_empty
}
EXIT1='^step %s exited 1$'
NOLINE='^step %s exited 0 without its last line'
for st in demo replay claims evidence; do
  expect_fail "${st}fail" "$st" "$(printf "$EXIT1" "$st")"
  expect_fail "${st}liar" "$st" "$(printf "$EXIT1" "$st")"
  expect_fail "${st}silent" "$st" "$(printf "$NOLINE" "$st")"
done
for st in replay claims evidence; do
  expect_fail "${st}zero" "$st" "$(printf "$NOLINE" "$st")"
done
expect_fail claimsbadpend claims "$(printf "$NOLINE" claims)"
expect_fail claimszeropend claims "$(printf "$NOLINE" claims)"
expect_fail replaydiff replay '^step replay: docs/BENCH.md differs from the committed table'
chk "replaydiff: the diff itself is shown" contains '+| regenerated | 31 |'
# a failing step is not recorded: --record leaves docs/EVIDENCE.md as it was
mkfix
write_steps claimsfail
commit_push 'test(fresh-clone): claims fail' scripts docs
cp "$T/work/docs/EVIDENCE.md" "$T/EVIDENCE.orig"
run "$T/work" FRESH_CLONE_SKIP_INSTALL=1 G5_TEST_MODE=1 ./scripts/g5-check.sh --record
chk "--record with a failing step: exit 1" rc_is 1
chk "--record with a failing step: last line G5 FAIL claims" last_is 'G5 FAIL claims'
chk "--record with a failing step: docs/EVIDENCE.md is unchanged" cmp -s "$T/work/docs/EVIDENCE.md" "$T/EVIDENCE.orig"
chk "--record with a failing step: TMPDIR folder is empty" tmp_empty
end_case 11 "a failing step ends G5 FAIL <step>: demo, replay, replay diff, claims, evidence, each failing four ways"

# ---- case 12 ----
echo "case 12: the demo step, its PATH, its HOME and its environment"
mkfix
BAD=""
mkdir "$T/home"
run "$T/work" FRESH_CLONE_SKIP_INSTALL=1 G5_TEST_MODE=1 HOME="$T/home" AIRLOCK_TEST_SENTINEL=leaked CARGO_TARGET_DIR="$T/exported" ./scripts/g5-check.sh
chk "exit 0" rc_is 0
chk "PATH is the node folder, the pnpm folder, /usr/bin and /bin and nothing else" has_line "STEP demo path=$T/nodebin:$T/pnpmbin:/usr/bin:/bin"
chk "cargo and rustc are not found from inside the demo, though they are on the caller's PATH" has_line "STEP demo cargo=none rustc=none"
chk "the replay step, which is not under env -i, does find the caller's cargo" has_line "STEP replay cargo=$T/rustbin/cargo"
DH=$(tail_of 'STEP demo home=')
chk "HOME is not the caller's" test -n "$DH" -a "$DH" != "$T/home"
case "$DH" in "$T/tmp"/fresh-clone.*) ;; *) BAD="$BAD [HOME is not a fresh-clone.* folder of TMPDIR: $DH]";; esac
chk "HOME held nothing when the demo started" has_line "STEP demo home_entries=0"
chk "web/dist, which check.sh full built in the clone, is gone when the demo starts" has_line "STEP demo web_dist=absent"
chk "HOME is deleted when the run ends" test -n "$DH" -a ! -e "$DH"
chk "nothing else of the caller's environment arrives (no sentinel, no CARGO_TARGET_DIR, no COREPACK_HOME)" has_line "STEP demo sentinel=unset target=unset corepack_home=unset"
DC=$(sed -n 's/^STEP demo args=.* cwd=//p' <<<"$OUT")
case "$DC" in */fresh-clone.clone.*) ;; *) BAD="$BAD [the demo did not run in the clone: cwd=$DC]";; esac
chk "TMPDIR folder is empty" tmp_empty
# COREPACK_HOME is the one extra thing: pnpm is a corepack shim, and with an empty HOME corepack would download pnpm again
mkdir -p "$T/corepack" "$T/home/.cache/node/corepack"
run "$T/work" FRESH_CLONE_SKIP_INSTALL=1 G5_TEST_MODE=1 HOME="$T/home" COREPACK_HOME="$T/corepack" ./scripts/g5-check.sh
chk "COREPACK_HOME set and present: passed on as it is" has_line "STEP demo sentinel=unset target=unset corepack_home=$T/corepack"
chk "COREPACK_HOME set and present: the PATH is unchanged" has_line "STEP demo path=$T/nodebin:$T/pnpmbin:/usr/bin:/bin"
run "$T/work" FRESH_CLONE_SKIP_INSTALL=1 G5_TEST_MODE=1 HOME="$T/home" ./scripts/g5-check.sh
chk "COREPACK_HOME unset: the corepack cache under the caller's HOME" has_line "STEP demo sentinel=unset target=unset corepack_home=$T/home/.cache/node/corepack"
run "$T/work" FRESH_CLONE_SKIP_INSTALL=1 G5_TEST_MODE=1 HOME="$T/home" COREPACK_HOME="$T/no-such-folder" ./scripts/g5-check.sh
chk "COREPACK_HOME naming a missing folder: not passed" has_line "STEP demo sentinel=unset target=unset corepack_home=unset"
chk "COREPACK_HOME naming a missing folder: the run still passes" last_has '^G5 OK sha=[0-9a-f]{40}$'
mkdir "$T/home2"
run "$T/work" FRESH_CLONE_SKIP_INSTALL=1 G5_TEST_MODE=1 HOME="$T/home2" ./scripts/g5-check.sh
chk "no corepack cache anywhere: not passed" has_line "STEP demo sentinel=unset target=unset corepack_home=unset"
chk "TMPDIR folder is empty after the COREPACK_HOME runs" tmp_empty
# a cargo in the folder of node (a Homebrew install) would make the proof void: the step refuses
cp "$T/rustbin/cargo" "$T/nodebin/cargo"
run "$T/work" FRESH_CLONE_SKIP_INSTALL=1 G5_TEST_MODE=1 ./scripts/g5-check.sh
chk "cargo next to node: exit 1" rc_is 1
chk "cargo next to node: last line G5 FAIL demo" last_is 'G5 FAIL demo'
chk "cargo next to node: the message names cargo" has '^step demo: cargo is reachable on the demo PATH '
chk "cargo next to node: the demo did not run" lacks '^STEP demo '
chk "cargo next to node: TMPDIR folder is empty" tmp_empty
rm -f "$T/nodebin/cargo"
cp "$T/rustbin/rustc" "$T/pnpmbin/rustc"
run "$T/work" FRESH_CLONE_SKIP_INSTALL=1 G5_TEST_MODE=1 ./scripts/g5-check.sh
chk "rustc next to pnpm: exit 1 and G5 FAIL demo" last_is 'G5 FAIL demo'
chk "rustc next to pnpm: the message names rustc" has '^step demo: rustc is reachable on the demo PATH '
rm -f "$T/pnpmbin/rustc"
cp "$T/rustbin/cargo" "$T/pnpmbin/rustup"
run "$T/work" FRESH_CLONE_SKIP_INSTALL=1 G5_TEST_MODE=1 ./scripts/g5-check.sh
chk "rustup next to pnpm: exit 1 and G5 FAIL demo" last_is 'G5 FAIL demo'
chk "rustup next to pnpm: the message names rustup" has '^step demo: rustup is reachable on the demo PATH '
rm -f "$T/pnpmbin/rustup"
# node or pnpm missing from the PATH
run "$T/work" FRESH_CLONE_SKIP_INSTALL=1 G5_TEST_MODE=1 PATH="$T/nodebin:$T/rustbin:/usr/bin:/bin" ./scripts/g5-check.sh
chk "no pnpm: exit 1" rc_is 1
chk "no pnpm: last line G5 FAIL demo" last_is 'G5 FAIL demo'
chk "no pnpm: the message names node and pnpm" has '^step demo: node or pnpm is not on the PATH$'
run "$T/work" FRESH_CLONE_SKIP_INSTALL=1 G5_TEST_MODE=1 PATH="$T/pnpmbin:$T/rustbin:/usr/bin:/bin" ./scripts/g5-check.sh
chk "no node: exit 1" rc_is 1
chk "no node: last line G5 FAIL demo" last_is 'G5 FAIL demo'
chk "no node: the message names node and pnpm" has '^step demo: node or pnpm is not on the PATH$'
chk "no node: TMPDIR folder is empty" tmp_empty
end_case 12 "the demo runs under env -i with only the node and pnpm folders, an empty HOME and COREPACK_HOME; Rust anywhere on that PATH refuses"

# ---- case 13 ----
echo "case 13: the steps run in the clone with the clone script's empty target directory"
mkfix
BAD=""
X="$T/exported-target"
mkdir "$X" && : > "$X/marker"
run "$T/work" FRESH_CLONE_SKIP_INSTALL=1 G5_TEST_MODE=1 CARGO_TARGET_DIR="$X" ./scripts/g5-check.sh
chk "exit 0" rc_is 0
TQ=$(sed -n 's/^STUB quick target=\(.*\) entries=.*/\1/p' <<<"$OUT")
chk "the clone script's check saw a target directory of its own, not the exported one" test -n "$TQ" -a "$TQ" != "$X"
for s in replay claims evidence; do
  L=$(grep -m1 "^STEP $s .*cwd=" <<<"$OUT")
  C=$(sed -n 's/.* cwd=\([^ ]*\) target=.*/\1/p' <<<"$L")
  G=$(sed -n 's/.* target=//p' <<<"$L")
  case "$C" in */fresh-clone.clone.*) ;; *) BAD="$BAD [$s did not run in the clone: cwd=$C]";; esac
  chk "$s: CARGO_TARGET_DIR is the clone script's target directory" test -n "$G" -a "$G" = "$TQ"
done
chk "the exported target directory was not touched" test "$(ls -A "$X")" = marker
for s in replay claims evidence; do chk "$s: the clone's scripts/env.sh was sourced first" has_line "STEP $s env=yes"; done
chk "the demo, under env -i, does not see what env.sh exported" has_line 'STEP demo fixture_env=no'
chk "TMPDIR folder is empty" tmp_empty
# the clone's scripts/env.sh is sourced once more by g5-check.sh: when that fails the run ends G5 FAIL env, before any step
mkfix
write_env g5fail
commit_push 'test(fresh-clone): env.sh fails for g5-check.sh' scripts
run "$T/work" FRESH_CLONE_SKIP_INSTALL=1 G5_TEST_MODE=1 ./scripts/g5-check.sh
chk "env.sh failing for g5-check.sh: the clone script itself passed" has '^FRESH CLONE OK elapsed=[0-9]+$'
chk "env.sh failing for g5-check.sh: exit 1" rc_is 1
chk "env.sh failing for g5-check.sh: last line G5 FAIL env" last_is 'G5 FAIL env'
chk "env.sh failing for g5-check.sh: no step ran" lacks '^STEP '
chk "env.sh failing for g5-check.sh: TMPDIR folder is empty" tmp_empty
end_case 13 "the steps run in the clone after its scripts/env.sh, with the clone script's target directory as CARGO_TARGET_DIR"

# ---- case 14 ----
echo "case 14: the privacy dry run"
GH_ORIGIN=1
mkfix
GH_ORIGIN=0
BAD=""
ORIGIN_SHA=$(git --git-dir="$OG" rev-parse refs/heads/main)
run "$T/work" FRESH_CLONE_SKIP_INSTALL=1 G5_TEST_MODE=1 ./scripts/g5-check.sh
chk "exit 0" rc_is 0
chk "last line G5 OK sha=" last_is "G5 OK sha=$ORIGIN_SHA"
chk "PRIVACY clean" has_line 'PRIVACY clean'
chk "no PRIVACY HITS line" lacks '^PRIVACY HITS'
chk "the screen ran once" test "$(wc -l < "$T/privacy.rec" | tr -d ' ')" = 1
chk "REPO is owner/name read from the clone's origin" test "$(sed -n 's/^repo=\(.*\) cwd=.*/\1/p' "$T/privacy.rec")" = acme/airlock
PC=$(sed -n 's/^repo=.* cwd=//p' "$T/privacy.rec")
case "$PC" in */fresh-clone.clone.*) ;; *) BAD="$BAD [the screen did not run in the clone: cwd=$PC]";; esac
chk "TMPDIR folder is empty" tmp_empty
# the same owner and name from the other forms of a GitHub URL (the scp form, a token before the host, no .git suffix)
for form in colon token nogit; do
  GH_ORIGIN=$form
  mkfix
  GH_ORIGIN=0
  run "$T/work" FRESH_CLONE_SKIP_INSTALL=1 G5_TEST_MODE=1 ./scripts/g5-check.sh
  chk "$form origin: exit 0" rc_is 0
  chk "$form origin: REPO is acme/airlock" test "$(sed -n 's/^repo=\(.*\) cwd=.*/\1/p' "$T/privacy.rec")" = acme/airlock
  chk "$form origin: no token in the output" not_contains SECRET
done
# priv_case <kind> <n>: the screen reports in the way <kind> says; the run reports PRIVACY HITS <n> and still ends G5 OK
priv_case() {
  mkfix
  write_steps "priv$1"
  commit_push "test(fresh-clone): privacy screen variant $1" scripts docs
  run "$T/work" FRESH_CLONE_SKIP_INSTALL=1 G5_TEST_MODE=1 ./scripts/g5-check.sh
  chk "$1: the run is not gated on the screen: exit 0" rc_is 0
  chk "$1: last line G5 OK sha=" last_has '^G5 OK sha=[0-9a-f]{40}$'
  chk "$1: PRIVACY HITS $2" has_line "PRIVACY HITS $2"
  chk "$1: exactly one PRIVACY line" test "$(grep -c '^PRIVACY ' <<<"$OUT")" = 1
  chk "$1: the four DURATION lines are still there" test "$(grep -cE '^DURATION (quick|full|demo|replay) [0-9]+s$' <<<"$OUT")" = 4
  printf '%s\n' "$OUT" > "$T/g5.out"
  chk "$1: AIR-254 check 4 passes" check4 "$T/g5.out"
  chk "$1: TMPDIR folder is empty" tmp_empty
}
priv_case hits 4
chk "hits: the labels are shown" has '^  privacy: FILE docs/notes\.md$'
chk "hits: every label is shown" test "$(grep -c '^  privacy: ' <<<"$OUT")" = 4
chk "hits: the matched text is never printed" not_contains 'jane.doe@example.com'
chk "hits: a line that starts with a space is not shown" not_contains 'one space is not a label'
priv_case missing 1
chk "missing: the pattern file message is shown" has '^  privacy: no pattern file at '
priv_case silent 1
chk "silent: the exit code is shown" has '^  privacy: the screen exited 1 and printed nothing$'
priv_case absent 1
chk "absent: the shell's own message is shown" has '^  privacy: .*privacy-screen\.sh: No such file or directory$'
priv_case indent 1
end_case 14 "REPO from origin, run in the clone, PRIVACY clean or HITS n, never gating"

if [ "$OK" -eq "$TOTAL_CASES" ]; then
  echo "FRESH CLONE TESTS OK ($OK of $TOTAL_CASES)"
  exit 0
fi
echo "FRESH CLONE TESTS FAILED ($OK of $TOTAL_CASES ok)"
exit 1
